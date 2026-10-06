export class MicrophoneRouter {
  private source: 'official' | 'arm' = 'official';
  constructor(private readonly options: {
    official: <T>(name: string, ...args: unknown[]) => Promise<T>;
    arm: { command: <T>(name: string, ...args: unknown[]) => Promise<T> };
    platform: string; arch: string; remote: boolean;
  }) {}
  async command<T>(name: string, ...args: unknown[]): Promise<T> {
    if (name === '_codex.microphone.available') {
      let available: number | null;
      try { available = await this.options.official<number | null>(name); } catch { available = null; }
      if (available) { this.source = 'official'; return available as T; }
      if (this.options.platform === 'linux' && this.options.arch === 'arm64' && !this.options.remote) {
        this.source = 'arm'; return this.options.arm.command<T>(name);
      }
      if (this.options.remote) throw new Error('远程工作区需要本机 VS Code 的麦克风扩展；请在本机安装并启用官方 Codex Audio。不会录制远程服务器的麦克风。');
      throw new Error(`本机麦克风不可用（${this.options.platform}/${this.options.arch}），请安装并启用官方 Codex Audio。`);
    }
    return this.source === 'arm' ? this.options.arm.command<T>(name, args[0] as string | undefined) : this.options.official<T>(name, ...args);
  }
}
