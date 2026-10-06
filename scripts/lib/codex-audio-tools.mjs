import { readFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { root, extensionRoot, hashFile, generatedPath, run, safeRelative } from './runtime-tools.mjs';
import { Zip } from './vsix-tools.mjs';
import { audioId, microphoneCommands, validateAudioManifest, resolveCodexAudio } from './codex-audio-releases.mjs';

export function auditAudioZip(zip, audio) {
  validateAudioManifest(audio);
  for (const entry of zip.getEntries()) { safeRelative(entry.entryName); if (((entry.attr >>> 16) & 0o170000) === 0o120000) throw new Error('Unexpected link in official Codex Audio VSIX'); }
  const manifest = JSON.parse(zip.readAsText('extension/package.json'));
  if (`${manifest.publisher}.${manifest.name}` !== audioId || manifest.version !== audio.version || manifest.engines?.vscode !== audio.engine || !manifest.extensionKind?.includes('ui')) throw new Error('Codex Audio package identity/version/UI host contract mismatch');
  const code = zip.readAsText(`extension/${safeRelative((manifest.main || '').replace(/^\.\//, ''))}`);
  for (const command of microphoneCommands) if (!code.includes(command)) throw new Error(`Upstream Codex Audio removed ${command}; dictation adapter needs review`);
  if (!zip.getEntry('extension/LICENSE.md')) throw new Error('Official Codex Audio license is missing');
  return manifest;
}
export async function prepareCodexAudio(audio, { offline = false } = {}) {
  validateAudioManifest(audio);
  const directory = join(root, 'artifacts/codex-audio', audio.version);
  const file = await generatedPath(join(directory, 'universal.vsix'), join(root, 'artifacts'));
  await mkdir(directory, { recursive: true });
  const valid = async () => { try { return await hashFile(file) === audio.sha256; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
  if (!await valid()) {
    if (offline) throw new Error('No verified offline Codex Audio VSIX; first build online or use an existing audited snapshot/cache');
    const partial = await generatedPath(file + '.partial', join(root, 'artifacts'));
    const args = ['--silent', '--show-error', '--fail', '--location', '--retry', '3', '--connect-timeout', '15', '--max-time', '180', '--proto', '=https', '--output', partial];
    if (process.platform === 'win32') args.push('--ssl-revoke-best-effort');
    if (process.env.CODEX_DOWNLOAD_PROXY) args.push('--proxy', process.env.CODEX_DOWNLOAD_PROXY);
    await run(process.platform === 'win32' ? 'curl.exe' : 'curl', [...args, audio.url]);
    if (await hashFile(partial) !== audio.sha256) throw new Error('Official Codex Audio VSIX SHA-256 does not match Marketplace');
    await rename(partial, file);
  }
  auditAudioZip(new Zip(file), audio);
  const extension = JSON.parse(await readFile(join(extensionRoot, 'package.json'), 'utf8'));
  if (!extension.extensionPack?.includes(audioId)) throw new Error('Declare official Codex Audio in extensionPack so VS Code installs its current Marketplace release');
  console.log(`Audited official Codex Audio ${audio.version}: Marketplace SHA-256, identity, UI host and microphone commands`);
  return file;
}
export async function selectBuildAudio(runtime, { version, offline = false, pinned = false } = {}) {
  if (offline) {
    // An offline build must never turn `latest` into an implicit network lookup.
    // Reuse the resolved snapshot (or the explicitly selected pinned manifest),
    // and require an exact match when a version was supplied.
    if (version === 'pinned' || (pinned && !version)) runtime.audio = await resolveCodexAudio('pinned');
    else if (runtime.audio) {
      validateAudioManifest(runtime.audio);
      if (version && version !== 'latest' && version !== runtime.audio.version) throw new Error(`Offline Codex Audio snapshot is ${runtime.audio.version}, not requested ${version}`);
    } else throw new Error('Offline VSIX packaging requires a snapshot including Codex Audio, or --audio-version pinned');
  } else if (version) runtime.audio = await resolveCodexAudio(version);
  else if (runtime.audio) validateAudioManifest(runtime.audio);
  else if (pinned) runtime.audio = await resolveCodexAudio('pinned');
  else runtime.audio = await resolveCodexAudio();
  await prepareCodexAudio(runtime.audio, { offline });
  const reference = await generatedPath(join(extensionRoot, 'codex-audio.json'), extensionRoot);
  await writeFile(reference, JSON.stringify(runtime.audio, null, 2) + '\n');
  const snapshot = await generatedPath(join(root, 'artifacts/build/codex-runtime.json'), join(root, 'artifacts'));
  await mkdir(join(root, 'artifacts/build'), { recursive: true });
  await writeFile(snapshot, JSON.stringify(runtime, null, 2) + '\n');
}
