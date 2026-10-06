import * as vscode from 'vscode';
import { CodexTransport, type CodexTransportOptions } from './transport';
import { emptyCapabilities, probeCapabilities, type CapabilityMatrix } from './capabilities';
import type { JsonRpcNotification, JsonRpcServerRequest } from './protocol';

export type CodexEvent = JsonRpcNotification;
export type CodexBackendOptions = CodexTransportOptions & { clientVersion?: string };

export class CodexBackend implements vscode.Disposable {
  readonly transport: CodexTransport;
  private readonly listeners = new Set<(event: CodexEvent) => void>();
  private readonly errorListeners = new Set<(error: Error) => void>();
  private capabilitiesState = emptyCapabilities();
  private initialized = false;
  private stopping = false;

  constructor(private readonly options: CodexBackendOptions = {}) {
    this.transport = new CodexTransport(options);
    this.transport.on('notification', (event) => this.listeners.forEach((listener) => listener(event)));
    this.transport.on('serverRequest', (request) => this.handleServerRequest(request));
    this.transport.on('error', (error) => this.handleTransportError(error));
    this.transport.on('exit', (code, signal) => {
      if (!this.stopping) {
        this.handleTransportError(new Error(`Codex app-server exited (${code ?? 'unknown'}${signal ? `, ${signal}` : ''})`));
      }
    });
  }

  get capabilities(): CapabilityMatrix { return this.capabilitiesState; }
  get isRunning(): boolean { return this.transport.running; }

  onEvent(listener: (event: CodexEvent) => void): vscode.Disposable {
    this.listeners.add(listener);
    return new vscode.Disposable(() => this.listeners.delete(listener));
  }

  onError(listener: (error: Error) => void): vscode.Disposable {
    this.errorListeners.add(listener);
    return new vscode.Disposable(() => this.errorListeners.delete(listener));
  }

  async start(): Promise<void> {
    if (this.initialized) return;
    this.transport.start();
    const response = await this.transport.request<{ userAgent?: string; platformFamily?: string; platformOs?: string }>('initialize', {
      clientInfo: { name: 'codex_vscode', title: 'Vcodex-Chamber', version: this.options.clientVersion || '0.1.0' },
      capabilities: { experimentalApi: true },
    }, 15_000);
    // app-server follows the JSON-RPC initialize handshake and expects this
    // notification before thread methods are accepted.
    this.transport.notify('initialized');
    this.initialized = true;
    this.capabilitiesState = probeCapabilities(undefined, true, typeof response?.userAgent === 'string' ? response.userAgent : null);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.initialized = false;
    this.capabilitiesState = emptyCapabilities();
    try { await this.transport.stop(); } finally { this.stopping = false; }
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    return this.transport.request<T>(method, params, timeoutMs).catch((error) => {
      if (/method not found|unknown method|unsupported/i.test(error instanceof Error ? error.message : String(error)) && method in this.capabilitiesState) {
        (this.capabilitiesState as Record<string, boolean | string | null>)[method] = false;
      }
      throw error;
    });
  }

  threadStart(params: Record<string, unknown> = {}) { return this.request('thread/start', params); }
  threadResume(params: Record<string, unknown>) { return this.request('thread/resume', params); }
  threadList(params: Record<string, unknown> = {}) { return this.request('thread/list', params); }
  threadRead(params: Record<string, unknown>) { return this.request('thread/read', params); }
  threadArchive(params: Record<string, unknown>) { return this.request('thread/archive', params); }
  threadUnarchive(params: Record<string, unknown>) { return this.request('thread/unarchive', params); }
  threadDelete(params: Record<string, unknown>) { return this.request('thread/delete', params); }
  threadFork(params: Record<string, unknown>) { return this.request('thread/fork', params); }
  threadSetName(params: Record<string, unknown>) { return this.request('thread/name/set', params); }
  threadItemsList(params: Record<string, unknown>) { return this.request('thread/items/list', params); }
  threadTurnsList(params: Record<string, unknown>) { return this.request('thread/turns/list', params); }
  threadSettingsUpdate(params: Record<string, unknown>) { return this.request('thread/settings/update', params); }
  threadGoalGet(params: Record<string, unknown>) { return this.request('thread/goal/get', params); }
  threadGoalSet(params: Record<string, unknown>) { return this.request('thread/goal/set', params); }
  threadGoalClear(params: Record<string, unknown>) { return this.request('thread/goal/clear', params); }
  turnStart(params: Record<string, unknown>) { return this.request('turn/start', params, 120_000); }
  turnSteer(params: Record<string, unknown>) { return this.request('turn/steer', params); }
  turnInterrupt(params: Record<string, unknown>) { return this.request('turn/interrupt', params); }
  modelList(params: Record<string, unknown> = {}) { return this.request('model/list', params); }
  accountRead(params: Record<string, unknown> = {}) { return this.request('account/read', params); }
  accountLoginStart(params: Record<string, unknown>) { return this.request('account/login/start', params, 30_000); }
  accountLoginCancel(params: Record<string, unknown>) { return this.request('account/login/cancel', params); }
  accountLogout() { return this.request('account/logout', undefined); }
  reviewStart(params: Record<string, unknown>) { return this.request('review/start', params, 120_000); }

  private handleServerRequest(request: JsonRpcServerRequest): void {
    // Permission and user-input requests are surfaced as events. The UI can
    // later answer them through respondToServerRequest without auto-approving.
    this.listeners.forEach((listener) => listener(request));
  }

  respondToServerRequest(id: string | number, result?: unknown, error?: { code?: number; message?: string }): void {
    this.transport.respond(id, result, error);
  }

  private handleTransportError(error: Error): void {
    this.initialized = false;
    this.capabilitiesState = emptyCapabilities();
    if (!this.stopping) this.errorListeners.forEach((listener) => listener(error));
  }

  dispose(): void { void this.stop(); }
}
