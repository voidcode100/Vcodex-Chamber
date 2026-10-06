import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { extensionRoot, generatedPath, inspectBinary, safeRelative, targetInfo } from '../lib/runtime-tools.mjs';
import { Zip, setExecutableAttributes } from '../lib/vsix-tools.mjs';

function pe(machine) { const b = Buffer.alloc(256); b.write('MZ'); b.writeUInt32LE(128, 60); b.writeUInt32LE(0x4550, 128); b.writeUInt16LE(machine, 132); return b; }
function elf(machine, dynamic = false) { const b = Buffer.alloc(128); Buffer.from([127, 69, 76, 70, 2, 1]).copy(b); b.writeUInt16LE(machine, 18); b.writeBigUInt64LE(64n, 32); b.writeUInt16LE(56, 54); b.writeUInt16LE(1, 56); b.writeUInt32LE(dynamic ? 3 : 1, 64); return b; }
test('binary validation rejects a wrong architecture before packaging', () => {
  assert.equal(inspectBinary(pe(0x8664), 'win32-x64').arch, 'x86_64');
  assert.equal(inspectBinary(pe(0xaa64), 'win32-arm64').arch, 'aarch64');
  assert.throws(() => inspectBinary(pe(0x8664), 'win32-arm64'), /architecture/);
  assert.throws(() => inspectBinary(pe(0xaa64), 'win32-x64'), /architecture/);
  assert.equal(inspectBinary(elf(62), 'linux-x64').interpreter, false);
  assert.equal(inspectBinary(elf(183), 'linux-arm64').arch, 'aarch64');
  assert.equal(inspectBinary(elf(62, true), 'linux-x64').interpreter, true);
  assert.throws(() => inspectBinary(elf(183), 'linux-x64'), /architecture/);
  assert.throws(() => inspectBinary(pe(0x8664), 'linux-x64'), /ELF/);
  assert.throws(() => inspectBinary(Buffer.alloc(5), 'win32-x64'), /PE/);
  assert.throws(() => targetInfo('linux-arm'), /ARMv7/);
});
test('archive paths cannot escape generated output', () => {
  for (const file of ['../codex', 'a/../codex', '/tmp/codex', 'C:/codex', 'a\\codex', 'a\0b']) assert.throws(() => safeRelative(file), /Unsafe/);
  assert.equal(safeRelative('bin/codex'), 'bin/codex');
});
test('generated mutations reject paths outside their root and directory links', async () => {
  const base = await mkdtemp(join(tmpdir(), 'vcodex-packaging-test-'));
  try {
    assert.equal(await generatedPath(join(base, 'safe', 'runtime'), base), join(base, 'safe', 'runtime'));
    await assert.rejects(generatedPath(base, base), /escaped/);
    await assert.rejects(generatedPath(join(base, '..', 'foreign'), base), /escaped/);
    await mkdir(join(base, 'original'));
    await symlink(join(base, 'original'), join(base, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(generatedPath(join(base, 'linked', 'runtime'), base), /Linked/);
  } finally { await rm(base, { recursive: true, force: true }); }
});
test('Linux execute bits survive ZIP serialization on NTFS', () => {
  const zip = new Zip(); zip.addFile('extension/bin/linux-x86_64/bin/codex', elf(62));
  setExecutableAttributes(zip, 'extension/bin/linux-x86_64/', ['bin/codex']);
  const restored = new Zip(zip.toBuffer()).getEntry('extension/bin/linux-x86_64/bin/codex');
  assert.equal(restored.header.made >>> 8, 3);
  assert.equal((restored.attr >>> 16) & 0o777, 0o755);
  assert.throws(() => setExecutableAttributes(zip, 'extension/bin/linux-x86_64/', ['missing']), /Missing/);
});
test('extension resolves its native official and legacy runtime layouts', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'vcodex-packaging-test-'));
  try {
    const require = createRequire(join(extensionRoot, 'package.json'));
    const file = join(temporary, 'resolver.test.cjs');
    await require('esbuild').build({ entryPoints: [join(extensionRoot, 'src/codex/resolver.test.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: file });
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ['--test', file], { stdio: 'inherit', windowsHide: true, env });
    assert.equal(result.status, 0);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
