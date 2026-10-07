import { createHash } from 'node:crypto';

export type AudioCompanion = {
  id: string; version: string; engine: string; target: string; file: string; sha256: string;
};
const numericVersion = (value: string) => {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-.*)?$/.exec(value);
  if (!match) throw new Error(`Invalid extension version: ${value}`);
  return match.slice(1).map(Number);
};
function compareVersion(left: string, right: string) {
  const a = numericVersion(left), b = numericVersion(right);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/** Installs a separate UI extension through VS Code, never loads its code here. */
export class AudioCompanionInstaller {
  private pending?: Promise<void>;
  constructor(private readonly options: {
    platform: string; arch: string; remote: boolean; vscodeVersion: string;
    read: (file: string) => Promise<Uint8Array>;
    installed: (id: string) => { version: string } | undefined;
    install: (file: string) => Promise<void>;
    log: (message: string) => void;
  }) {}

  ensure(): Promise<void> {
    if (this.pending) return this.pending;
    const pending = this.installIfMissing();
    this.pending = pending;
    void pending.finally(() => { if (this.pending === pending) this.pending = undefined; }).catch(() => {});
    return pending;
  }

  private async installIfMissing() {
    // The bundle targets the extension host; an SSH host cannot infer the local
    // desktop architecture. Never install its Linux recorder on a Windows UI.
    if (this.options.remote) return;
    let bytes: Uint8Array;
    try { bytes = await this.options.read('manifest.json'); }
    catch (error) {
      // Source/dev hosts have no bundled package. Packaged VSIX validation makes
      // this file mandatory; other IO failures must remain visible.
      if ((error as { code?: string }).code === 'ENOENT' || (error as { code?: string }).code === 'FileNotFound') return;
      throw error;
    }
    const descriptor = JSON.parse(Buffer.from(bytes).toString('utf8')) as AudioCompanion;
    const target = `${this.options.platform}-${this.options.arch}`;
    const expectedId = target === 'linux-arm64' ? 'fedaykindev.vcodex-audio-arm' : 'openai.codex-audio';
    if (descriptor.target !== target || descriptor.id !== expectedId || descriptor.file !== 'audio.vsix' ||
        !/^\d+\.\d+\.\d+$/.test(descriptor.version) || !/^\^\d+\.\d+\.\d+$/.test(descriptor.engine) || !/^[a-f0-9]{64}$/.test(descriptor.sha256)) throw new Error('Audio 配套包的平台或来源清单无效，请重新安装对应平台的 Vcodex-Chamber。');
    const installed = this.options.installed(descriptor.id);
    // Keep newer versions and respect explicitly disabled extensions.
    if (installed && compareVersion(installed.version, descriptor.version) >= 0) return;
    const minimum = descriptor.engine.slice(1);
    if (numericVersion(this.options.vscodeVersion)[0] !== numericVersion(minimum)[0] || compareVersion(this.options.vscodeVersion, minimum) < 0) throw new Error(`配套 Audio 需要 VS Code ${descriptor.engine}，请先更新编辑器。`);
    const archive = await this.options.read(descriptor.file);
    if (createHash('sha256').update(archive).digest('hex') !== descriptor.sha256) throw new Error('Audio 配套包校验失败，请重新安装 Vcodex-Chamber。');
    this.options.log(`Installing separate Audio companion ${descriptor.id} ${descriptor.version} from bundled VSIX`);
    await this.options.install(descriptor.file);
    this.options.log(`Audio companion installation completed: ${descriptor.id}`);
  }
}
