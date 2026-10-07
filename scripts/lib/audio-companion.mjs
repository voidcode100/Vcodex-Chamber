import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Zip } from './vsix-tools.mjs';
import { audioId } from './codex-audio-releases.mjs';
import { armAudioId } from './arm-audio-tools.mjs';
import { auditAudioZip } from './codex-audio-tools.mjs';

const prefix = 'extension/audio-companion/';
export async function embedAudioCompanion(zip, target, file, identity) {
  const bytes = await readFile(file);
  zip.addFile(prefix + 'audio.vsix', bytes);
  zip.addFile(prefix + 'manifest.json', Buffer.from(JSON.stringify({
    ...identity, target, file: 'audio.vsix', sha256: createHash('sha256').update(bytes).digest('hex'),
  }, null, 2) + '\n'));
}

export async function verifyAudioCompanion(zip, target, audio) {
  const descriptor = JSON.parse(zip.readAsText(prefix + 'manifest.json'));
  const id = target === 'linux-arm64' ? armAudioId : audioId;
  if (descriptor.id !== id || descriptor.target !== target || descriptor.file !== 'audio.vsix' ||
      !/^\d+\.\d+\.\d+$/.test(descriptor.version) || !/^\^\d+\.\d+\.\d+$/.test(descriptor.engine) || !/^[a-f0-9]{64}$/.test(descriptor.sha256)) throw new Error('Invalid bundled Audio identity/target');
  const bytes = zip.readFile(prefix + descriptor.file);
  if (!bytes || createHash('sha256').update(bytes).digest('hex') !== descriptor.sha256) throw new Error('Bundled Audio VSIX integrity mismatch');
  const nested = new Zip(bytes);
  const manifest = JSON.parse(nested.readAsText('extension/package.json'));
  if (`${manifest.publisher}.${manifest.name}` !== id || manifest.version !== descriptor.version || manifest.engines?.vscode !== descriptor.engine || manifest.extensionKind?.join() !== 'ui') throw new Error('Bundled Audio package/descriptor mismatch');
  if (target === 'linux-arm64') {
    const { verifyArmAudioVsix } = await import('./arm-audio-vsix.mjs');
    await verifyArmAudioVsix(bytes);
  } else {
    if (!audio || descriptor.sha256 !== audio.sha256 || descriptor.version !== audio.version) throw new Error('Bundled official Audio differs from upstream snapshot');
    auditAudioZip(nested, audio);
  }
  const entries = zip.getEntries().filter(entry => entry.entryName.startsWith(prefix) && !entry.isDirectory);
  if (entries.length !== 2 || entries.some(entry => !['manifest.json', 'audio.vsix'].includes(entry.entryName.slice(prefix.length)))) throw new Error('Unexpected bundled Audio files');
  if (zip.getEntries().some(entry => /\.vsix$/i.test(entry.entryName) && entry.entryName !== prefix + descriptor.file)) throw new Error('Unmanifested companion VSIX');
  return descriptor;
}
