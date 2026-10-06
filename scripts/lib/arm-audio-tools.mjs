import { readFile, mkdir, writeFile, cp, chmod, rename } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { root, extensionRoot, hashFile, run, generatedPath, inspectBinary } from './runtime-tools.mjs';

export const armAudioSources = JSON.parse(await readFile(join(root, 'scripts/arm-audio-sources.json'), 'utf8'));
export const armAudioCache = join(root, 'artifacts/arm-audio/linux-arm64');
export const armAudioFiles = ['recorder', 'LICENSE', 'MINIAUDIO-LICENSE', 'NOTICE'];
export const armExtensionRoot = join(root, 'packages/codex-audio-arm');
export const armAudioId = 'fedaykindev.vcodex-audio-arm';
export function armAudioVsixName(version) { return `Vcodex-Audio-ARM-${version}-linux-arm64.vsix`; }
const helper = join(armExtensionRoot, 'src/recorder.c');
// Git may use CRLF in a Windows checkout. Share native build caches across
// hosts without treating line-ending conversions as a recorder change.
export async function armHelperHash() {
  return createHash('sha256').update((await readFile(helper, 'utf8')).replace(/\r\n/g, '\n')).digest('hex');
}
export function validateArmAudioMetadata(metadata, helperHash) {
  if (metadata?.target !== 'linux-arm64' || metadata.helperSha256 !== helperHash || JSON.stringify(metadata.sources) !== JSON.stringify(armAudioSources) || armAudioFiles.some(file => !/^[a-f0-9]{64}$/.test(metadata.files?.[file] || '')) || Object.keys(metadata.files).length !== armAudioFiles.length) throw new Error('Stale or invalid ARM audio provenance; rebuild with scripts/build-arm-audio.mjs');
}
export async function validateArmAudio(directory) {
  const metadata = JSON.parse(await readFile(join(directory, 'arm-audio.json'), 'utf8'));
  validateArmAudioMetadata(metadata, await armHelperHash());
  inspectBinary(await readFile(join(directory, 'recorder')), 'linux-arm64');
  for (const file of armAudioFiles) if (await hashFile(join(directory, file)) !== metadata.files[file]) throw new Error(`ARM audio integrity mismatch: ${file}`);
  return metadata;
}
export async function buildArmAudio({ offline = false, cc = process.env.ARM_AUDIO_CC || 'cc' } = {}) {
  const source = join(root, 'artifacts/arm-audio/source');
  for (const entry of armAudioSources.files) {
    const file = await generatedPath(join(source, entry.output), join(root, 'artifacts'));
    await mkdir(dirname(file), { recursive: true });
    let valid = false;
    try { valid = await hashFile(file) === entry.sha256; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!valid) {
      if (offline) throw new Error(`Missing verified offline ARM audio source: ${entry.output}`);
      const revision = entry.repository === 'Picovoice/pvrecorder' ? armAudioSources.pvrecorder : armAudioSources.miniaudio;
      const partial = file + '.partial';
      const args = ['--silent', '--show-error', '--fail', '--location', '--retry', '3', '--connect-timeout', '15', '--max-time', '90', '--proto', '=https', '--output', partial];
      if (process.platform === 'win32') args.push('--ssl-revoke-best-effort');
      if (process.env.CODEX_DOWNLOAD_PROXY) args.push('--proxy', process.env.CODEX_DOWNLOAD_PROXY);
      await run(process.platform === 'win32' ? 'curl.exe' : 'curl', [...args, `https://raw.githubusercontent.com/${entry.repository}/${revision}/${entry.path}`]);
      if (await hashFile(partial) !== entry.sha256) throw new Error(`Upstream ARM audio source hash mismatch: ${entry.output}`);
      await rename(partial, file);
    }
  }
  await mkdir(armAudioCache, { recursive: true });
  const output = await generatedPath(join(armAudioCache, 'recorder'), join(root, 'artifacts'));
  await run(cc, ['-std=gnu11', '-O2', '-D__PV_RECORDER_PLATFORM_LINUX__', '-I', join(source, 'include'), helper, join(source, 'src/pv_recorder.c'), join(source, 'src/pv_circular_buffer.c'), '-o', output + '.partial', '-pthread', '-ldl', '-lm']);
  inspectBinary(await readFile(output + '.partial'), 'linux-arm64');
  await rename(output + '.partial', output); await chmod(output, 0o755);
  await cp(join(source, 'LICENSE'), join(armAudioCache, 'LICENSE'));
  await cp(join(source, 'MINIAUDIO-LICENSE'), join(armAudioCache, 'MINIAUDIO-LICENSE'));
  await writeFile(join(armAudioCache, 'NOTICE'), `Vcodex-Chamber ARM microphone adapter (MIT)\nBuilt from Picovoice PvRecorder ${armAudioSources.pvrecorder} (Apache-2.0),\nCopyright 2021-2023 Picovoice Inc., and miniaudio ${armAudioSources.miniaudio}\n(MIT/public domain; see MINIAUDIO-LICENSE).\nThis is a Vcodex-Chamber adapter, not a modified or official Codex Audio release.\n`);
  const files = {};
  for (const file of armAudioFiles) files[file] = await hashFile(join(armAudioCache, file));
  await writeFile(join(armAudioCache, 'arm-audio.json'), JSON.stringify({ target: 'linux-arm64', helperSha256: await armHelperHash(), sources: armAudioSources, files }, null, 2) + '\n');
  await validateArmAudio(armAudioCache);
  if (process.platform === 'linux' && process.arch === 'arm64') await run(output, ['--version']);
  console.log(`Built verified ARM microphone: ${output}`);
  return armAudioCache;
}
export async function prepareArmAudio(options = {}) {
  try { await validateArmAudio(armAudioCache); return armAudioCache; }
  catch (error) {
    if (options.offline) throw new Error(`No verified ARM audio cache: ${error.message}. Build it first with node scripts/build-arm-audio.mjs --offline.`);
    if ((process.platform !== 'linux' || process.arch !== 'arm64') && !process.env.ARM_AUDIO_CC) throw new Error('Linux ARM64 packaging needs its microphone helper: build scripts/build-arm-audio.mjs on Linux ARM64 and copy artifacts/arm-audio/linux-arm64 here, or set ARM_AUDIO_CC to a cross compiler.');
    return buildArmAudio(options);
  }
}
export async function stageArmAudio(directory) {
  await validateArmAudio(directory);
  const stage = await generatedPath(join(armExtensionRoot, 'native/linux-arm64'), join(armExtensionRoot, 'native'));
  await mkdir(stage, { recursive: true });
  for (const file of [...armAudioFiles, 'arm-audio.json']) await cp(join(directory, file), join(stage, file));
  await chmod(join(stage, 'recorder'), 0o755);
}
