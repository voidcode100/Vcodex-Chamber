import { randomUUID } from 'node:crypto';
import type { GetAuthStatusResponse } from './generated/GetAuthStatusResponse';

export type DictationState = 'recording' | 'uploading' | 'idle' | 'error';
export type DictationOptions = {
  prepare?: () => Promise<void>;
  command: <T>(name: string, ...args: unknown[]) => Promise<T>;
  transcribe: (pcm: Buffer, sampleRate: number, signal: AbortSignal) => Promise<string>;
  state: (state: DictationState, error?: string) => void;
};

/** Codex Audio's stop drains queued PCM through read; cancel discards it. */
export class Dictation {
  private current?: { id: string; abort: AbortController; chunks: Buffer[]; bytes: number; rate: number; stopped?: boolean; pump?: Promise<void>; error?: Error };
  private starting?: Promise<void>;
  private finishing?: Promise<string>;
  constructor(private readonly options: DictationOptions) {}
  get active(): boolean { return Boolean(this.current); }

  start(): Promise<void> {
    if (this.finishing) return Promise.reject(new Error('上一段录音正在转写，请稍候。'));
    if (this.starting) return this.starting;
    if (this.current?.stopped) return Promise.reject(new Error('上一段录音仍待转写，请重试或先丢弃录音。'));
    if (this.current) return Promise.resolve();
    this.starting = this.begin().finally(() => { this.starting = undefined; });
    return this.starting;
  }
  private async begin(): Promise<void> {
    const session = { id: randomUUID(), abort: new AbortController(), chunks: [] as Buffer[], bytes: 0, rate: 0 } as NonNullable<typeof this.current>;
    this.current = session;
    try {
      await this.options.prepare?.();
      session.abort.signal.throwIfAborted();
      const available = await this.options.command<number | null>('_codex.microphone.available');
      session.abort.signal.throwIfAborted();
      if (!available) throw new Error('请在本机 VS Code 安装并启用官方 Codex Audio 扩展以使用麦克风。');
      const result = await this.options.command<{ status: string; sampleRate?: number; reason?: string }>('_codex.microphone.start', session.id);
      session.abort.signal.throwIfAborted();
      if (result?.status !== 'started' || !Number.isFinite(result.sampleRate) || result.sampleRate! <= 0) throw new Error(`麦克风启动失败：${result?.reason || 'invalid sample rate'}`);
      session.rate = result.sampleRate!;
      this.options.state('recording');
      session.pump = (async () => {
        while (!session.abort.signal.aborted) {
          const frame = await this.options.command<{ status: string; pcm?: string; reason?: string }>('_codex.microphone.read', session.id);
          if (session.abort.signal.aborted) return;
          if (frame?.status === 'stopped') return;
          if (frame?.status !== 'audio' || typeof frame.pcm !== 'string') throw new Error(`录音失败：${frame?.reason || 'invalid audio frame'}`);
          const chunk = Buffer.from(frame.pcm, 'base64');
          session.bytes += chunk.length;
          if (session.bytes > session.rate * 2 * 600 || session.bytes > 24 * 1024 * 1024) throw new Error('录音已达到十分钟或 24 MB 限制，请缩短录音。');
          session.chunks.push(chunk);
        }
      })().catch(async error => {
        session.error = error instanceof Error ? error : new Error(String(error));
        if (!session.abort.signal.aborted) {
          this.options.state('error', session.error.message);
          await this.options.command('_codex.microphone.cancel', session.id).catch(() => undefined);
          session.chunks.length = 0;
          if (this.current === session) this.current = undefined;
        }
      });
    } catch (error) {
      await this.options.command('_codex.microphone.cancel', session.id).catch(() => undefined);
      if (this.current === session) this.current = undefined;
      if (!session.abort.signal.aborted) this.options.state('error', String(error));
      throw error;
    }
  }
  stop(): Promise<string> {
    if (this.finishing) return this.finishing;
    this.finishing = this.finish().finally(() => { this.finishing = undefined; });
    return this.finishing;
  }
  private async finish(): Promise<string> {
    await this.starting;
    const session = this.current;
    if (!session) return '';
    this.options.state('uploading');
    let completed = false;
    try {
      if (!session.stopped) {
        await this.options.command('_codex.microphone.stop', session.id);
        await session.pump;
        session.stopped = true;
      }
      session.abort.signal.throwIfAborted();
      if (session.error) throw session.error;
      if (!session.bytes) throw new Error('没有录到声音，请检查麦克风后重试。');
      const text = (await this.options.transcribe(Buffer.concat(session.chunks), session.rate, session.abort.signal)).trim();
      session.abort.signal.throwIfAborted();
      if (!text) throw new Error('未识别到语音，请重新录音。');
      completed = true;
      this.options.state('idle');
      return text;
    } catch (error) {
      if (!session.abort.signal.aborted) this.options.state('error', error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      // A failed upload can be retried without recording the same sentence again.
      // Audio remains in memory only, and cancel/logout discards it immediately.
      if (completed || session.abort.signal.aborted || session.error || !session.bytes || !session.stopped) {
        session.chunks.length = 0;
        if (this.current === session) this.current = undefined;
      }
    }
  }
  async cancel(): Promise<void> {
    const session = this.current;
    if (!session) return;
    session.abort.abort();
    await Promise.resolve(this.options.command('_codex.microphone.cancel', session.id)).catch(() => undefined);
    await this.starting?.catch(() => undefined);
    await session.pump;
    await this.finishing?.catch(() => undefined);
    session.chunks.length = 0;
    if (this.current === session) this.current = undefined;
    this.options.state('idle');
  }
}

export function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
  if (!Number.isInteger(sampleRate) || sampleRate <= 0 || pcm.length % 2) throw new Error('Invalid PCM16 audio');
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export async function transcribeRecording(options: {
  pcm: Buffer; sampleRate: number; signal: AbortSignal;
  auth: (refresh: boolean) => Promise<GetAuthStatusResponse>;
  endpoint?: string; apiKey?: string; model?: string; language?: string; clientVersion?: string; fetch?: typeof fetch;
}): Promise<string> {
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(60_000)]);
  const request = options.fetch ?? fetch;
  let auth = options.endpoint ? undefined : await options.auth(false);
  const chatgpt = auth?.authMethod === 'chatgpt' || auth?.authMethod === 'chatgptAuthTokens';
  if (!options.endpoint && (!auth?.authToken || (!chatgpt && auth.authMethod !== 'apikey'))) throw new Error('语音听写需要 Codex 的 ChatGPT 登录，或配置语音转写 API。');
  const endpoint = options.endpoint || (chatgpt ? 'https://chatgpt.com/backend-api/transcribe' : 'https://api.openai.com/v1/audio/transcriptions');
  for (let attempt = 0; attempt < 2; attempt++) {
    signal.throwIfAborted();
    const token = options.endpoint ? options.apiKey : auth?.authToken;
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': `OpenChamber/${options.clientVersion?.replace(/[^\w.-]/g, '') || '2.1.5'}`,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
    if (chatgpt && token) {
      headers.originator = 'openchamber';
      // Match the official desktop account header; do not persist or expose tokens.
      try {
        const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
        const account = claims['https://api.openai.com/auth']?.chatgpt_account_id;
        if (typeof account === 'string') headers['ChatGPT-Account-Id'] = account;
      } catch { /* The server validates opaque tokens. */ }
    }
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(pcmToWav(options.pcm, options.sampleRate))], { type: 'audio/wav' }), 'dictation.wav');
    if (options.language && /^[a-z]{2,3}(?:-[A-Za-z0-9]+)*$/.test(options.language)) form.append('language', options.language);
    if (!chatgpt) form.append('model', options.model || 'gpt-4o-mini-transcribe');
    const response = await request(endpoint, { method: 'POST', headers, body: form, signal, redirect: 'error' });
    if (response.status === 401 && !options.endpoint && attempt === 0) {
      await response.body?.cancel();
      const refreshed = await options.auth(true);
      if (refreshed.authMethod !== auth?.authMethod || !refreshed.authToken) throw new Error('登录状态已变化，请重新开始录音。');
      if (chatgpt && authIdentity(auth?.authToken) !== authIdentity(refreshed.authToken)) throw new Error('ChatGPT 账号已切换，请丢弃这段录音后重新录制。');
      auth = refreshed;
      continue;
    }
    if (response.status === 403 && response.headers.get('cf-mitigated') === 'challenge') {
      await response.body?.cancel();
      const reference = response.headers.get('cf-ray');
      const safeReference = reference && /^[\w.:-]{1,100}$/.test(reference) ? ` 请求编号：${reference}。` : '';
      throw new Error(`ChatGPT 听写请求被 Cloudflare 验证拦截（HTTP 403），并非缺少 API Key。录音已暂存在内存中，可检查网络连接后点击重试，或丢弃录音。${safeReference}`);
    }
    const result = await response.json().catch(() => null) as { text?: unknown; error?: { message?: unknown }; detail?: unknown } | null;
    if (!response.ok) {
      const detail = typeof result?.error?.message === 'string' ? result.error.message : typeof result?.detail === 'string' ? result.detail : '';
      throw new Error(`语音转写失败（HTTP ${response.status}）${detail ? `：${detail.slice(0, 400)}` : '。请检查登录状态或转写服务配置。'}`);
    }
    if (typeof result?.text !== 'string' || !result.text.trim()) throw new Error('转写服务没有返回文本。');
    return result.text.trim();
  }
  throw new Error('语音转写认证失败，请重新登录 Codex。');
}

export function authIdentity(token?: string | null): string {
  try {
    const claims = JSON.parse(Buffer.from(token!.split('.')[1], 'base64url').toString());
    const account = claims['https://api.openai.com/auth'];
    return JSON.stringify([account?.chatgpt_account_id ?? null, account?.chatgpt_user_id ?? claims.sub ?? null]);
  } catch { return ''; }
}
