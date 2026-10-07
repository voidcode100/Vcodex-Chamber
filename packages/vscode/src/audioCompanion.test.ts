import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { AudioCompanionInstaller, type AudioCompanion } from './audioCompanion';

function harness(target = 'win32-x64') {
  const bytes = Buffer.from('unmodified companion VSIX');
  const descriptor: AudioCompanion = {
    target, id: target === 'linux-arm64' ? 'fedaykindev.vcodex-audio-arm' : 'openai.codex-audio',
    version: '1.2.3', engine: '^1.96.2', file: 'audio.vsix', sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  let installed: { version: string } | undefined;
  let installs = 0, installedFile = '', failure = false, held: Promise<void> | undefined;
  const options = {
    platform: target.split('-')[0], arch: target.split('-')[1], remote: false, vscodeVersion: '1.100.0',
    read: async (file: string) => file === 'manifest.json' ? Buffer.from(JSON.stringify(descriptor)) : bytes,
    installed: (_id: string) => installed,
    install: async (file: string) => { installs++; installedFile = file; await held; if (failure) throw new Error('install rejected'); installed = { version: descriptor.version }; },
    log: (_message: string) => {},
  };
  return { descriptor, bytes, options, installer: new AudioCompanionInstaller(options), installs: () => installs,
    installedFile: () => installedFile, installed: (version: string) => { installed = { version }; },
    fail: (value: boolean) => { failure = value; }, hold: (value: Promise<void>) => { held = value; } };
}

test('local x64 and Linux ARM64 install distinct companions exactly once and await concurrent microphone setup', async () => {
  for (const target of ['win32-x64', 'linux-x64', 'linux-arm64', 'win32-arm64']) {
    const h = harness(target);
    let release!: () => void; h.hold(new Promise<void>(resolve => { release = resolve; }));
    const first = h.installer.ensure(), microphone = h.installer.ensure();
    assert.equal(first, microphone); release(); await Promise.all([first, microphone]);
    assert.equal(h.installs(), 1); assert.equal(h.installedFile(), 'audio.vsix');
    await h.installer.ensure(); assert.equal(h.installs(), 1);
  }
});

test('companion setup never downgrades a newer installed version', async () => {
  const h = harness(); h.installed('2.0.0'); await h.installer.ensure(); assert.equal(h.installs(), 0);
});

test('installation failure is retryable instead of becoming a permanently rejected setup promise', async () => {
  const h = harness(); h.fail(true); await assert.rejects(h.installer.ensure(), /install rejected/);
  h.fail(false); await h.installer.ensure(); assert.equal(h.installs(), 2);
});

test('corrupt bundles, swapped architecture, unsafe paths and unsupported editor versions cannot install', async () => {
  for (const change of [
    (h: ReturnType<typeof harness>) => { h.bytes[0] ^= 1; },
    (h: ReturnType<typeof harness>) => { h.descriptor.target = 'linux-arm64'; },
    (h: ReturnType<typeof harness>) => { h.descriptor.file = '../../outside.vsix'; },
    (h: ReturnType<typeof harness>) => { h.descriptor.id = 'other.audio'; },
    (h: ReturnType<typeof harness>) => { h.options.vscodeVersion = '1.85.0'; },
  ]) {
    const h = harness(); change(h); await assert.rejects(h.installer.ensure()); assert.equal(h.installs(), 0);
  }
});

test('SSH hosts do not deploy server Audio onto an incompatible local desktop', async () => {
  const h = harness('linux-arm64'); h.options.remote = true;
  h.options.read = async () => { throw new Error('Must not read remote bundle'); };
  await h.installer.ensure(); assert.equal(h.installs(), 0);
});

test('development hosts without a packaged companion remain usable; other IO failures remain visible', async () => {
  const h = harness(); h.options.read = async () => { throw Object.assign(new Error('No dev bundle'), { code: 'ENOENT' }); };
  await h.installer.ensure(); assert.equal(h.installs(), 0);
  h.options.read = async () => { throw Object.assign(new Error('Access denied'), { code: 'EACCES' }); };
  await assert.rejects(h.installer.ensure(), /Access denied/);
});
