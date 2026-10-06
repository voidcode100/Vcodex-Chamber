import * as vscode from 'vscode';
import * as path from 'node:path';
import type { OpenCodeManager, ConnectionStatus } from '../opencode';
import { Dictation, transcribeRecording, authIdentity } from './dictation';
import { createDictationFetch } from './dictationTransport';
import { MicrophoneRouter } from './microphoneRouter';
import type { GetAuthStatusResponse } from './generated/GetAuthStatusResponse';
import { CodexAuth, canUseCodex, type CodexAuthState } from './auth';
export type { CodexAuthState } from './auth';
import { CodexBackend } from './backend';
import { CodexFacade } from './facade';
import { CodexExecutableResolver, type CodexExecutableInfo } from './resolver';

type DebugInfo = ReturnType<OpenCodeManager['getDebugInfo']>;
type Compatibility = {
  state: 'compatible' | 'incompatible' | 'unavailable';
  version: string | null;
  installation: 'managed' | 'external' | 'bundled';
  binary: string | null;
  minimumVersion: string;
  canInstall: boolean;
};

export type CaptureTarget = {
  mode: 'active' | 'pinned';
  sessionId?: string;
  directory?: string;
};

export type SessionCapturePrompt = string;

export class CodexManager implements OpenCodeManager, vscode.Disposable {
  private readonly backend: CodexBackend;
  private readonly facade: CodexFacade;
  private readonly resolver: CodexExecutableResolver;
  private executableInfo: CodexExecutableInfo | null;
  private apiUrl: string | null = null;
  private status: ConnectionStatus = 'disconnected';
  private error: string | undefined;
  private workingDirectory = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
  private readonly listeners = new Set<(status: ConnectionStatus, error?: string) => void>();
  private readonly authListeners = new Set<(state: CodexAuthState) => void>();
  private readonly voiceStateListeners = new Set<(state: 'recording' | 'uploading' | 'idle' | 'error', error?: string, sessionId?: string) => void>();
  private readonly auth: CodexAuth;
  private activeThreadId: string | undefined;
  private initialPromptSent = false;
  private voiceThreadId: string | undefined;
  private activeSessionId: string | undefined;
  private captureTarget: CaptureTarget = { mode: 'active' };
  private voicePrompt = '';
  private voiceAuthIdentity?: string;
  private voiceTranscript?: string;
  private voiceSubmissionUncertain = false;
  private voiceAbort = new AbortController();
  private readonly sessionPrompts = new Map<string, SessionCapturePrompt>();
  private readonly dictation: Dictation;
  private voiceDelivery?: Promise<string>;
  private voiceStarting?: Promise<string>;
  private voiceState: { state: 'recording' | 'uploading' | 'idle' | 'error'; error?: string; sessionId?: string } = { state: 'idle' };
  getVoiceState() { return { ...this.voiceState, canRetry: !this.voiceSubmissionUncertain && this.voiceState.state === 'error' && (this.dictation.active || Boolean(this.voiceTranscript)) }; }

  constructor(private readonly context: vscode.ExtensionContext, private readonly output?: vscode.OutputChannel) {
    this.resolver = new CodexExecutableResolver(context);
    const configured = vscode.workspace.getConfiguration('captureCodex').get<string>('codexBinary')
      || undefined;
    this.executableInfo = this.resolver.resolveSync(configured);
    this.backend = new CodexBackend({
      binary: this.executableInfo?.path || configured || undefined,
      cwd: this.workingDirectory,
      env: this.getCodexEnvironment(),
      onLog: (line) => this.log(line),
    });
    const storedPrompts = context.workspaceState.get<Record<string, string>>('captureCodex.sessionPrompts', {});
    for (const [sessionId, prompt] of Object.entries(storedPrompts ?? {})) {
      if (typeof prompt === 'string' && prompt.trim()) this.sessionPrompts.set(sessionId, prompt.trim());
    }
    this.facade = new CodexFacade(this.backend, (line) => this.log(line));
    this.backend.onError((error) => {
      this.error = error.message;
      this.log(error.message);
      this.setStatus('error', error.message);
    });
    this.auth = new CodexAuth((method, params) => this.backend.request(method, params), state => this.authListeners.forEach(listener => listener(state)));
    this.backend.onEvent(event => this.auth.onEvent(event.method, event.params));
    const microphone = new MicrophoneRouter({
      official: <T>(name: string, ...args: unknown[]) => Promise.resolve(vscode.commands.executeCommand<T>(name, ...args)),
      arm: { command: async <T>(name: string, ...args: unknown[]): Promise<T> => {
        const extension = vscode.extensions.getExtension('fedaykindev.vcodex-audio-arm');
        if (!extension) throw new Error('请安装并启用独立的 Vcodex Audio ARM 插件（linux-arm64 VSIX）。');
        await extension.activate();
        return await vscode.commands.executeCommand<T>(name.replace('_codex.microphone.', '_vcodex.audio.'), ...args) as T;
      } }, platform: process.platform, arch: process.arch, remote: Boolean(vscode.env.remoteName),
    });
    this.dictation = new Dictation({
      prepare: async () => {
        this.voiceAuthIdentity = undefined;
        if (!this.voiceThreadId) throw new Error('没有可用的录音会话。');
        await this.facade.checkExternalTarget(this.voiceThreadId, true);
        if (!vscode.workspace.getConfiguration('captureCodex').get<string>('voice.transcriptionUrl', '').trim()) {
          const auth = await this.backend.request<GetAuthStatusResponse>('getAuthStatus', { includeToken: true, refreshToken: false });
          this.voiceAuthIdentity = `${auth.authMethod}:${authIdentity(auth.authToken)}`;
        }
      },
      command: <T>(name: string, ...args: unknown[]) => microphone.command<T>(name, ...args),
      state: (state, error) => this.setVoiceState(state, error),
      transcribe: (pcm, sampleRate, signal) => {
        const config = vscode.workspace.getConfiguration('captureCodex');
        return transcribeRecording({ pcm, sampleRate, signal,
          auth: async refreshToken => {
            const auth = await this.backend.request<GetAuthStatusResponse>('getAuthStatus', { includeToken: true, refreshToken });
            if (this.voiceAuthIdentity && this.voiceAuthIdentity !== `${auth.authMethod}:${authIdentity(auth.authToken)}`) throw new Error('登录账号已切换，请丢弃录音后重新录制。');
            return auth;
          },
          endpoint: config.get<string>('voice.transcriptionUrl', '').trim(),
          apiKey: config.get<string>('voice.transcriptionApiKey', '').trim(),
          model: config.get<string>('voice.transcriptionModel', 'gpt-4o-mini-transcribe'),
          language: config.get<string>('voice.language', '').trim(),
          clientVersion: this.context.extension.packageJSON.version,
          fetch: createDictationFetch({ proxy: vscode.workspace.getConfiguration('http').get<string>('proxy', '') }),
        });
      },
    });
  }

  async start(workdir?: string): Promise<void> {
    if (workdir?.trim()) this.workingDirectory = workdir.trim();
    this.setStatus('connecting');
    try {
      const configured = vscode.workspace.getConfiguration('captureCodex').get<string>('codexBinary') || undefined;
      this.executableInfo = await this.resolver.resolve(configured);
      if (!this.executableInfo) {
        throw new Error('Codex CLI was not found. Install Codex, set captureCodex.codexBinary, or reload VS Code after installing it.');
      }
      await this.backend.start();
      this.apiUrl = await this.facade.start();
      this.setStatus('connected');
      // Authentication is independent from app-server availability. A fresh
      // install can start the server successfully while still requiring OAuth.
      await this.refreshAuthState(true);
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      this.log(this.error);
      this.setStatus('error', this.error);
    }
  }

  async stop(): Promise<void> {
    this.auth.reset();
    await this.cancelVoice();
    await this.facade.stop();
    await this.backend.stop();
    this.apiUrl = null;
    this.activeThreadId = undefined;
    this.initialPromptSent = false;
    this.voiceThreadId = undefined;
    this.setStatus('disconnected');
  }

  async restart(): Promise<void> { await this.stop(); await this.start(this.workingDirectory); }
  async upgradeCli(): Promise<void> { throw new Error('Codex CLI is managed outside Vcodex-Chamber.'); }
  async installV2(): Promise<void> { throw new Error('Vcodex-Chamber uses the Codex CLI; OpenCode installation is unavailable.'); }
  async getCompatibility(): Promise<Compatibility> {
    const source = this.executableInfo?.source;
    return {
      state: this.status === 'connected' ? 'compatible' : 'unavailable',
      version: this.executableInfo?.version || this.backend.capabilities.userAgent,
      installation: source === 'bundled' ? 'bundled' : source === 'codex-home' ? 'managed' : 'external',
      binary: this.executableInfo?.path || null,
      minimumVersion: '0.160.0',
      canInstall: false,
    };
  }
  async setWorkingDirectory(directory: string): Promise<{ success: true; path: string } | { success: false; error: string }> {
    try {
      const stat = await vscode.workspace.fs.stat(vscode.Uri.file(directory));
      if (stat.type !== vscode.FileType.Directory) return { success: false, error: 'path not found' };
      this.workingDirectory = path.resolve(directory);
      return { success: true, path: this.workingDirectory };
    } catch { return { success: false, error: 'path not found' }; }
  }
  setActiveSession(sessionId: string | undefined): void { this.activeSessionId = sessionId?.trim() || undefined; }
  setCaptureTarget(target: CaptureTarget): void { this.captureTarget = { ...target, sessionId: target.sessionId?.trim() || undefined }; }
  setSessionPrompt(sessionId: string, prompt: string): void {
    const id = sessionId.trim();
    if (!id) return;
    const normalized = prompt.trim();
    if (!normalized) this.sessionPrompts.delete(id);
    else this.sessionPrompts.set(id, normalized);
    void this.context.workspaceState.update('captureCodex.sessionPrompts', Object.fromEntries(this.sessionPrompts));
  }
  getSessionPrompt(sessionId: string): string { return this.sessionPrompts.get(sessionId.trim()) ?? ''; }
  getCaptureTarget(): CaptureTarget { return { ...this.captureTarget, sessionId: this.resolveCaptureThreadId() }; }
  getCaptureStatus(): { sessionId?: string; mode: CaptureTarget['mode']; voiceActive: boolean } {
    return { sessionId: this.resolveCaptureThreadId(), mode: this.captureTarget.mode, voiceActive: Boolean(this.voiceThreadId) };
  }
  getStatus(): ConnectionStatus { return this.status; }
  getApiUrl(): string | null { return this.apiUrl; }
  getOpenCodeAuthHeaders(): Record<string, string> { return {}; }
  getManagedLaunchEnvironment(): NodeJS.ProcessEnv | null { return process.env; }
  getWorkingDirectory(): string { return this.workingDirectory; }
  isCliAvailable(): boolean { return this.executableInfo !== null; }
  getDebugInfo(): DebugInfo {
    return { mode: 'managed', status: this.status, lastError: this.error, workingDirectory: this.workingDirectory, cliAvailable: this.executableInfo !== null, cliPath: this.executableInfo?.path || null, configuredApiUrl: null, configuredPort: null, detectedPort: this.apiUrl ? Number(new URL(this.apiUrl).port) : null, apiPrefix: '', apiPrefixDetected: true, startCount: 1, restartCount: 0, lastStartAt: null, lastConnectedAt: this.status === 'connected' ? Date.now() : null, lastExitCode: null, serverUrl: this.apiUrl, lastReadyElapsedMs: null, lastReadyAttempts: null, lastStartAttempts: 1, version: this.executableInfo?.version || this.backend.capabilities.userAgent, secureConnection: false, authSource: null };
  }
  onStatusChange(callback: (status: ConnectionStatus, error?: string) => void): vscode.Disposable { this.listeners.add(callback); callback(this.status, this.error); return new vscode.Disposable(() => this.listeners.delete(callback)); }
  onAuthChange(callback: (state: CodexAuthState) => void): vscode.Disposable { this.authListeners.add(callback); callback(this.auth.state); return new vscode.Disposable(() => this.authListeners.delete(callback)); }
  onVoiceState(callback: (state: 'recording' | 'uploading' | 'idle' | 'error', error?: string, sessionId?: string) => void): vscode.Disposable { this.voiceStateListeners.add(callback); return new vscode.Disposable(() => this.voiceStateListeners.delete(callback)); }
  getAuthState(): CodexAuthState { return this.auth.state; }
  async refreshAuthState(refreshToken = false): Promise<CodexAuthState> {
    if (!this.backend.isRunning) return this.auth.state;
    return this.auth.refresh(refreshToken);
  }
  async login(deviceCode = false): Promise<CodexAuthState> {
    if (!this.backend.isRunning) throw new Error('Codex 尚未连接，请先重试连接。');
    await this.auth.login(deviceCode);
    return this.auth.state;
  }
  async cancelLogin(): Promise<void> { await this.auth.cancelLogin(); }
  async logout(): Promise<void> { await this.cancelVoice(); await this.auth.logout(); }
  private requireAuthentication(): void {
    if (!canUseCodex(this.auth.state)) throw new Error('请先在 OpenChamber 首页完成 Codex 登录。');
  }
  dispose(): void { void this.stop(); this.facade.dispose(); this.backend.dispose(); }

  private setStatus(status: ConnectionStatus, error?: string): void { this.status = status; this.error = error; this.listeners.forEach((listener) => listener(status, error)); }
  private setVoiceState(state: 'recording' | 'uploading' | 'idle' | 'error', error?: string): void {
    this.voiceState = { state, error, sessionId: this.voiceThreadId };
    this.voiceStateListeners.forEach((listener) => listener(state, error, this.voiceThreadId));
  }
  private log(line: string): void {
    this.output?.appendLine(`[Codex] ${line}`);
    console.error(`[Vcodex-Chamber] ${line}`);
  }
  logDiagnostic(line: string): void { this.log(line); }

  /** Pass the editor's network policy to the child CLI without changing the extension host. */
  private getCodexEnvironment(): NodeJS.ProcessEnv {
    const http = vscode.workspace.getConfiguration('http');
    const proxy = http.get<string>('proxy', '').trim();
    const strictSsl = http.get<boolean>('proxyStrictSSL', true);
    const environment: NodeJS.ProcessEnv = {};
    if (proxy) {
      environment.HTTP_PROXY = proxy;
      environment.HTTPS_PROXY = proxy;
      environment.ALL_PROXY = proxy;
    }
    if (strictSsl === false) environment.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    return environment;
  }
  getBackend(): CodexBackend { return this.backend; }
  isCodexBackend(): boolean { return true; }

  async codexThreadArchive(threadId: string): Promise<void> {
    await this.backend.threadArchive({ threadId });
  }

  async codexThreadUnarchive(threadId: string): Promise<void> {
    await this.backend.threadUnarchive({ threadId });
  }

  async codexThreadDelete(threadId: string): Promise<void> {
    await this.backend.threadDelete({ threadId });
  }

  async submitCapture(filePath: string): Promise<void> { await this.submitCaptures([filePath]); }

  async checkCaptureTarget(sessionId?: string, allowBusy = false): Promise<string> {
    this.requireAuthentication();
    if (!this.backend.isRunning) throw new Error('Codex 尚未连接。');
    const target = sessionId?.trim() || this.resolveCaptureThreadId();
    if (!target) throw new Error('请先打开一个 Codex 会话，或在设置中固定目标会话。');
    await this.facade.checkExternalTarget(target, allowBusy);
    return target;
  }

  async submitCaptures(filePaths: string[], prompt?: string, sessionId?: string, requestId?: string): Promise<void> {
    this.requireAuthentication();
    if (!this.backend.isRunning) throw new Error('Codex app-server is not connected');
    const threadId = sessionId || this.resolveCaptureThreadId();
    if (!threadId) throw new Error('No active or pinned Codex session is available for capture delivery.');
    const input: Array<Record<string, unknown>> = [];
    const text = (prompt ?? this.sessionPrompts.get(threadId) ?? '').trim();
    if (text) input.push({ type: 'text', text, text_elements: [] });
    for (const filePath of filePaths) if (filePath) input.push({ type: 'localImage', path: filePath });
    if (input.length === 0) return;
    await this.facade.submitExternalInput(threadId, input, requestId || `capture-${Date.now()}`);
  }

  startVoice(sessionId?: string): Promise<string> {
    if (this.voiceStarting) return this.voiceStarting.then(target => {
      if (sessionId && sessionId !== target) throw new Error('另一会话正在录音，请先停止或取消。');
      return target;
    });
    this.voiceStarting = this.beginVoice(sessionId).finally(() => { this.voiceStarting = undefined; });
    return this.voiceStarting;
  }
  private async beginVoice(sessionId?: string): Promise<string> {
    this.requireAuthentication();
    if (!this.backend.isRunning) throw new Error('Codex app-server is not connected');
    if (this.voiceDelivery) throw new Error('上一段录音正在转写或发送，请稍候。');
    // A new hold starts a fresh recording after a failed transcription. Keep
    // unsent or uncertain turns explicit so this never duplicates a submission.
    if (this.voiceState.state === 'error' && !this.voiceTranscript && !this.voiceSubmissionUncertain) await this.cancelVoice();
    const target = sessionId?.trim() || this.resolveCaptureThreadId();
    if (!target) throw new Error('请先打开一个 Codex 会话再开始录音。');
    if (this.voiceThreadId && this.voiceThreadId !== target) throw new Error('另一会话正在录音，请先停止或取消。');
    if (this.voiceTranscript) throw new Error('上一段转写尚未发送，请先重试发送或丢弃。');
    if (!this.voiceThreadId) this.voiceAbort = new AbortController();
    this.voiceThreadId = target;
    this.voicePrompt = (this.sessionPrompts.get(target) || '').trim();
    try { await this.dictation.start(); }
    catch (error) { if (!this.dictation.active) this.voiceThreadId = undefined; throw error; }
    return target;
  }

  stopVoice(send = true, expectedSessionId?: string): Promise<string> {
    if (this.voiceStarting) return this.voiceStarting.then(() => this.stopVoice(send, expectedSessionId));
    if (expectedSessionId && this.voiceThreadId && expectedSessionId !== this.voiceThreadId) return Promise.reject(new Error('录音属于另一会话，请返回原会话操作。'));
    if (this.voiceDelivery) return this.voiceDelivery;
    this.voiceDelivery = this.finishVoice(send).finally(() => { this.voiceDelivery = undefined; });
    return this.voiceDelivery;
  }
  private async finishVoice(send: boolean): Promise<string> {
    if (this.voiceSubmissionUncertain) throw new Error('上一段语音提交结果未确认，请检查会话并丢弃待发送记录，避免重复发送。');
    const threadId = this.voiceThreadId;
    if (!threadId) return '';
    const prompt = this.voicePrompt;
    const signal = this.voiceAbort.signal;
    try {
      const transcript = this.voiceTranscript || await this.dictation.stop();
      signal.throwIfAborted();
      if (!transcript) return '';
      if (send) {
        this.voiceTranscript = transcript;
        const text = prompt ? prompt + '\n\n' + transcript : transcript;
        this.requireAuthentication();
        if (this.voiceAuthIdentity) {
          const current = await this.backend.request<GetAuthStatusResponse>('getAuthStatus', { includeToken: true, refreshToken: false });
          if (this.voiceAuthIdentity !== `${current.authMethod}:${authIdentity(current.authToken)}`) throw new Error('登录账号已变化，请丢弃待发送录音。');
        }
        this.setVoiceState('uploading');
        await this.facade.submitExternalInput(threadId, [{ type: 'text', text, text_elements: [] }], `voice-${Date.now()}`, signal);
        this.voiceTranscript = undefined;
        this.setVoiceState('idle');
      }
      else {
        // Inserting a retained transcript into the composer completes delivery too.
        this.voiceTranscript = undefined;
        this.setVoiceState('idle');
      }
      return transcript;
    } catch (error) {
      if ((error as { uncertain?: boolean }).uncertain) this.voiceSubmissionUncertain = true;
      this.setVoiceState('error', error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      if (!this.dictation.active && !this.voiceTranscript) { this.voiceThreadId = undefined; this.voicePrompt = ''; this.voiceAuthIdentity = undefined; }
    }
  }
  async cancelVoice(expectedSessionId?: string): Promise<void> {
    if (expectedSessionId && this.voiceThreadId && expectedSessionId !== this.voiceThreadId) throw new Error('录音属于另一会话，请返回原会话操作。');
    this.voiceAbort.abort();
    await this.dictation.cancel();
    await this.voiceDelivery?.catch(() => undefined);
    this.voiceThreadId = undefined;
    this.voicePrompt = '';
    this.voiceAuthIdentity = undefined;
    this.voiceTranscript = undefined;
    this.voiceSubmissionUncertain = false;
    this.setVoiceState('idle');
  }

  private resolveCaptureThreadId(): string | undefined {
    if (this.captureTarget.mode === 'pinned') return this.captureTarget.sessionId || undefined;
    return this.activeSessionId || this.activeThreadId || undefined;
  }

  private async ensureThread(): Promise<void> {
    if (this.activeThreadId) return;
    const initialPrompt = vscode.workspace.getConfiguration('captureCodex').get<string>('initialPrompt', '').trim();
    const result = await this.backend.threadStart({ cwd: this.workingDirectory });
    const thread = result && typeof result === 'object' && result !== null && 'thread' in result ? (result as { thread?: { id?: unknown } }).thread : result as { id?: unknown };
    const id = thread && typeof thread.id === 'string' ? thread.id : undefined;
    if (!id) throw new Error('Codex did not return a thread id');
    this.activeThreadId = id;
    if (initialPrompt) this.initialPromptSent = false;
  }
}
