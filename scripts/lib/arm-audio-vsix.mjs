import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Zip } from './vsix-tools.mjs';
import { inspectBinary, safeRelative } from './runtime-tools.mjs';
import { armExtensionRoot, armAudioId, armAudioFiles, validateArmAudioMetadata, armHelperHash } from './arm-audio-tools.mjs';

export async function verifyArmAudioVsix(file, { verifyDist = false } = {}) {
  const zip = new Zip(file);
  const manifest = JSON.parse(zip.readAsText('extension/package.json'));
  const expected = JSON.parse(await readFile(join(armExtensionRoot, 'package.json'), 'utf8'));
  if (`${manifest.publisher}.${manifest.name}` !== armAudioId || manifest.version !== expected.version || manifest.main !== './dist/extension.js' || manifest.extensionKind?.join() !== 'ui') throw new Error('Incorrect standalone ARM Audio identity/host');
  if (!zip.readAsText('extension.vsixmanifest').includes('linux-arm64')) throw new Error('Missing standalone Audio target');
  const prefix = 'extension/native/linux-arm64/';
  const metadata = JSON.parse(zip.readAsText(prefix + 'arm-audio.json'));
  validateArmAudioMetadata(metadata, await armHelperHash());
  for (const name of armAudioFiles) {
    const bytes = zip.readFile(prefix + name);
    if (!bytes || createHash('sha256').update(bytes).digest('hex') !== metadata.files[name]) throw new Error(`ARM Audio integrity mismatch: ${name}`);
  }
  inspectBinary(zip.readFile(prefix + 'recorder'), 'linux-arm64');
  if (((zip.getEntry(prefix + 'recorder').attr >>> 16) & 0o111) !== 0o111) throw new Error('ARM Audio recorder lost execute bits');
  for (const entry of zip.getEntries()) {
    safeRelative(entry.entryName);
    if (((entry.attr >>> 16) & 0o170000) === 0o120000) throw new Error('ARM Audio must not contain symlinks');
    if (entry.entryName.startsWith('extension/bin/')) throw new Error('Codex runtime belongs in the client VSIX');
    if (entry.entryName.startsWith('extension/native/') && !entry.isDirectory && (!entry.entryName.startsWith(prefix) || ![...armAudioFiles, 'arm-audio.json'].includes(entry.entryName.slice(prefix.length)))) throw new Error('Foreign native file in ARM Audio');
    if (/(?:^|\/)(?:plan\.md|.*\.log|auth\.json|settings\.json|\.env)$/.test(entry.entryName)) throw new Error('Private file in ARM Audio');
  }
  const js = zip.readFile('extension/dist/extension.js');
  if (!js || (verifyDist && !js.equals(await readFile(join(armExtensionRoot, 'dist/extension.js'))))) throw new Error('Missing or stale ARM Audio extension');
  console.log(`Verified independent ARM Audio VSIX: ${file}`);
}
