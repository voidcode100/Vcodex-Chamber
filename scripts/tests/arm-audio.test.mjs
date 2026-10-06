import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { extensionRoot } from '../lib/runtime-tools.mjs';
import { armAudioSources, armAudioFiles, validateArmAudioMetadata, armHelperHash, armExtensionRoot } from '../lib/arm-audio-tools.mjs';
import { Zip, setExecutableAttributes } from '../lib/vsix-tools.mjs';
import { verifyArmAudioVsix } from '../lib/arm-audio-vsix.mjs';

test('ARM recording provenance pins upstream sources, helper and exactly the licensed files', () => {
  const hash = '1'.repeat(64), files = Object.fromEntries(armAudioFiles.map(name => [name, hash]));
  const metadata = { target: 'linux-arm64', sources: structuredClone(armAudioSources), helperSha256: hash, files };
  assert.doesNotThrow(() => validateArmAudioMetadata(metadata, hash));
  assert.throws(() => validateArmAudioMetadata(metadata, '2'.repeat(64)), /Stale/);
  for (const mutate of [value => { value.target = 'linux-x64'; }, value => { delete value.files.LICENSE; }, value => { value.sources.pvrecorder = 'unreviewed'; }, value => { value.files.foreign = hash; }]) {
    const copy = structuredClone(metadata); mutate(copy); assert.throws(() => validateArmAudioMetadata(copy, hash), /invalid/);
  }
  for (const source of armAudioSources.files) assert.match(source.sha256, /^[a-f0-9]{64}$/);
});

test('microphone routing, stop/cancel, failure and dictation contracts run on Node', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vcodex-arm-microphone-tests-'));
  try {
    const require = createRequire(join(extensionRoot, 'package.json'));
    const entries = ['linuxArmMicrophone', 'dictation'];
    const files = [];
    for (const name of entries) {
      const file = join(directory, `${name}.test.cjs`); files.push(file);
      await require('esbuild').build({ entryPoints: [join(extensionRoot, `src/codex/${name}.test.ts`)], bundle: true, platform: 'node', format: 'cjs', outfile: file });
    }
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit', env, windowsHide: true });
    assert.equal(result.status, 0);
  } finally { if (dirname(directory) === tmpdir()) await rm(directory, { recursive: true, force: true }); }
});

test('standalone Audio VSIX enforces ARM architecture, execute bits, provenance and separation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vcodex-audio-vsix-test-'));
  try {
    const zip = new Zip(), prefix = 'extension/native/linux-arm64/';
    const binary = Buffer.alloc(128);
    Buffer.from([127, 69, 76, 70, 2, 1]).copy(binary); binary.writeUInt16LE(183, 18);
    binary.writeBigUInt64LE(64n, 32); binary.writeUInt16LE(56, 54); binary.writeUInt16LE(1, 56); binary.writeUInt32LE(1, 64);
    const files = {};
    for (const name of armAudioFiles) {
      const bytes = name === 'recorder' ? binary : Buffer.from(name);
      zip.addFile(prefix + name, bytes);
      files[name] = createHash('sha256').update(bytes).digest('hex');
    }
    const manifest = await readFile(join(armExtensionRoot, 'package.json'));
    zip.addFile('extension/package.json', manifest);
    zip.addFile('extension/dist/extension.js', Buffer.from('exports.activate = () => {};'));
    zip.addFile('extension.vsixmanifest', Buffer.from('<Property Value="linux-arm64"/>'));
    zip.addFile(prefix + 'arm-audio.json', Buffer.from(JSON.stringify({ target: 'linux-arm64', helperSha256: await armHelperHash(), sources: armAudioSources, files })));
    setExecutableAttributes(zip, prefix, ['recorder']);
    const file = join(directory, 'audio.vsix'); zip.writeZip(file);
    await verifyArmAudioVsix(file);
    zip.addFile(prefix + 'recorder', Buffer.from('wrong architecture')); zip.writeZip(file);
    await assert.rejects(verifyArmAudioVsix(file), /integrity/);
    zip.addFile(prefix + 'recorder', binary); zip.writeZip(file);
    await assert.rejects(verifyArmAudioVsix(file), /execute/);
    setExecutableAttributes(zip, prefix, ['recorder']);
    zip.addFile('extension/bin/codex', Buffer.from('foreign runtime')); zip.writeZip(file);
    await assert.rejects(verifyArmAudioVsix(file), /client VSIX/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
