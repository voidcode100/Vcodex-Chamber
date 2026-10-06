import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';

type Frame = { status: 'audio'; pcm: string } | { status: 'stopped' } | { status: 'error'; reason: string };
type Session = {
  id: string; child: ChildProcessWithoutNullStreams; chunks: Buffer[]; bytes: number;
  stopped: boolean; cancelled: boolean; closed: boolean; error?: string;
  waiter?: (frame: Frame) => void; close: Promise<void>; ready: Promise<{ status: 'started'; sampleRate: number }>;
};

/** Local Linux ARM64 capture. Uses the same open-source recorder as Codex Audio.
 * The helper's PCM stays in memory and stop drains stdout before closing. */
export class LinuxArmMicrophone {
  private session?: Session;
  constructor(private readonly binary: string, private readonly device: () => string = () => '', private readonly launch: typeof spawn = spawn) {}
  async available(): Promise<number> {
    try { await access(this.binary, constants.X_OK); }
    catch { throw new Error('Linux ARM64 录音程序缺失或不可执行，请安装 Vcodex Audio ARM 的 linux-arm64 VSIX。'); }
    return 1;
  }
  async command<T>(name: string, id?: string): Promise<T> {
    if (name.endsWith('.available')) return await this.available() as T;
    if (typeof id !== 'string' || !id) throw new Error('Missing microphone session ID');
    if (name.endsWith('.start')) return await this.start(id) as T;
    const session = this.session;
    if (!session || session.id !== id) {
      if (name.endsWith('.cancel') || name.endsWith('.stop')) return undefined as T;
      return { status: 'stopped' } as T;
    }
    if (name.endsWith('.read')) return await this.read(session) as T;
    if (name.endsWith('.stop')) { await this.stop(session, false); return undefined as T; }
    if (name.endsWith('.cancel')) { await this.stop(session, true); return undefined as T; }
    throw new Error(`Unknown microphone command: ${name}`);
  }
  private start(id: string): Promise<{ status: 'started'; sampleRate: number }> {
    if (this.session) {
      if (this.session.id === id && !this.session.stopped) return this.session.ready;
      return Promise.reject(new Error('麦克风正被另一段录音使用，请先停止或丢弃录音。'));
    }
    const device = this.device().trim();
    const child = this.launch(this.binary, device ? ['--device', device] : [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let resolveReady!: (value: { status: 'started'; sampleRate: number }) => void, rejectReady!: (error: Error) => void, resolveClose!: () => void;
    const session: Session = { id, child, chunks: [], bytes: 0, stopped: false, cancelled: false, closed: false,
      ready: new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; }),
      close: new Promise(resolve => { resolveClose = resolve; }),
    };
    this.session = session;
    let ready = false, stderr = '';
    const fail = (reason: string) => {
      if (session.cancelled) return;
      session.error ||= `Linux ARM64 麦克风失败：${reason}`;
      rejectReady(new Error(session.error)); this.wake(session);
    };
    const startupTimer = setTimeout(() => { fail('启动超时，请检查桌面音频服务及麦克风权限。'); child.kill('SIGTERM'); }, 10_000);
    child.stdin.on('error', error => { if (!session.closed && !session.stopped) fail(error.message); });
    child.stdout.on('data', (bytes: Buffer) => {
      if (session.cancelled || session.error) return;
      session.chunks.push(bytes); session.bytes += bytes.length;
      if (session.bytes > 2 * 1024 * 1024) { fail('录音缓冲区已满。'); child.kill('SIGTERM'); return; }
      this.wake(session);
    });
    child.stderr.on('data', (bytes: Buffer) => {
      stderr += bytes.toString('utf8');
      if (stderr.length > 16_384) stderr = stderr.slice(-16_384);
      let newline: number;
      while ((newline = stderr.indexOf('\n')) >= 0) {
        const line = stderr.slice(0, newline); stderr = stderr.slice(newline + 1);
        let event: { status?: string; sampleRate?: number; reason?: string };
        try { event = JSON.parse(line); } catch { continue; } // ALSA diagnostics are not protocol messages.
        if (event.status === 'started' && !ready) {
          if (session.cancelled) { rejectReady(new Error('录音已取消。')); continue; }
          if (!Number.isInteger(event.sampleRate) || event.sampleRate! <= 0) { fail('无效采样率。'); child.kill('SIGTERM'); continue; }
          ready = true; clearTimeout(startupTimer); resolveReady({ status: 'started', sampleRate: event.sampleRate! });
        } else if (event.status === 'error') { fail(event.reason || '录音程序报告错误。'); child.kill('SIGTERM'); }
      }
    });
    const closed = (code: number | null) => {
      if (session.closed) return;
      session.closed = true; clearTimeout(startupTimer);
      if (!ready && !session.error) rejectReady(new Error(session.cancelled ? '录音已取消。' : '麦克风未能启动，请检查输入设备。'));
      if (!session.cancelled && (code !== 0 || !session.stopped)) fail(`录音程序意外退出（${code}）。`);
      this.wake(session); resolveClose();
    };
    child.once('error', error => { fail(error.message); closed(null); });
    child.once('close', closed);
    // Handle a cancelled start even when its caller is waiting on prepare/auth.
    void session.ready.catch(() => undefined);
    return session.ready;
  }
  private take(session: Session): Frame | undefined {
    if (session.cancelled) return { status: 'stopped' };
    if (session.error) return { status: 'error', reason: session.error };
    const chunk = session.chunks.shift();
    if (chunk) { session.bytes -= chunk.length; return { status: 'audio', pcm: chunk.toString('base64') }; }
    if (session.closed) {
      if (this.session === session) this.session = undefined;
      return { status: 'stopped' };
    }
  }
  private wake(session: Session): void {
    if (!session.waiter) return;
    const frame = this.take(session);
    if (frame) { const resolve = session.waiter; session.waiter = undefined; resolve(frame); }
  }
  private read(session: Session): Promise<Frame> {
    const frame = this.take(session);
    if (frame) return Promise.resolve(frame);
    if (session.waiter) return Promise.reject(new Error('Concurrent microphone reads are not supported'));
    return new Promise(resolve => { session.waiter = resolve; });
  }
  private async stop(session: Session, cancel: boolean): Promise<void> {
    if (cancel) {
      session.cancelled = true; session.chunks.length = 0; session.bytes = 0; this.wake(session);
    }
    if (!session.stopped) {
      session.stopped = true;
      if (!session.closed) {
        if (cancel) session.child.kill('SIGTERM');
        else session.child.stdin.end('stop\n');
      }
    }
    const kill = setTimeout(() => session.child.kill('SIGKILL'), 2_000);
    try { await session.close; } finally { clearTimeout(kill); }
    if (cancel && this.session === session) this.session = undefined;
  }
  async dispose(): Promise<void> { if (this.session) await this.stop(this.session, true); }
}
