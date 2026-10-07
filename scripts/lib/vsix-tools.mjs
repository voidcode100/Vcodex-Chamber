import { createRequire } from 'node:module';
import { readFile, mkdir, writeFile, chmod } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { root, extensionRoot, targetInfo, runtimeConfig, coreFiles, inspectBinary, safeRelative, filesIn, generatedPath } from './runtime-tools.mjs';
import { validateAudioManifest } from './codex-audio-releases.mjs';
import { verifyAudioCompanion } from './audio-companion.mjs';
const require = createRequire(join(extensionRoot, 'package.json'));
export const Zip = require('adm-zip');
export const vsce = require('@vscode/vsce');
export function vsixName(version, target) { targetInfo(target); return `Vcodex-Chamber-${version}-${target}.vsix`; }
export function setExecutableAttributes(zip, prefix, executableFiles) {
  for (const key of executableFiles) {
    const entry = zip.getEntry(prefix + safeRelative(key));
    if (!entry) throw new Error(`Missing executable in VSIX: ${key}`);
    // NTFS has no Unix execute bits. Set Unix ZIP attributes explicitly, also
    // when cross-packaging Linux VSIX files on Windows.
    entry.header.made = 0x0314;
    entry.attr = (0o100755 << 16) >>> 0;
  }
}
export async function verifyVsix(file, target, { verifyDist = false, extractRuntime } = {}) {
  const info = targetInfo(target), zip = new Zip(file);
  const manifest = JSON.parse(zip.readAsText('extension/package.json'));
  const expected = JSON.parse(await readFile(join(extensionRoot, 'package.json'), 'utf8'));
  if (manifest.version !== expected.version || manifest.displayName !== 'Vcodex-Chamber') throw new Error('Incorrect VSIX version or identity');
  if (runtimeConfig.audio) {
    const audio = validateAudioManifest(JSON.parse(zip.readAsText('extension/codex-audio.json')));
    if (manifest.extensionPack?.length || ['id', 'version', 'sha256', 'url', 'engine', 'channel', 'targetPlatform'].some(key => audio[key] !== runtimeConfig.audio[key])) throw new Error('VSIX Codex Audio installation/provenance mismatch');
    await verifyAudioCompanion(zip, target, audio);
    if (target !== 'linux-arm64' && manifest.engines?.vscode !== audio.engine) throw new Error('Client must require its bundled official Audio VS Code version');
    if (!manifest.activationEvents?.includes('onStartupFinished')) throw new Error('Missing Audio companion startup installation');
  }
  const xml = zip.readAsText('extension.vsixmanifest');
  if (!xml.includes(`TargetPlatform="${target}"`) && !xml.includes(`Id="Microsoft.VisualStudio.Code.TargetPlatform" Value="${target}"`)) throw new Error(`Missing VSIX target ${target}`);
  const prefix = `extension/bin/${info.folder}/`;
  const entries = zip.getEntries();
  for (const entry of entries) {
    safeRelative(entry.entryName);
    if (entry.entryName.startsWith('extension/native/') && !entry.isDirectory) throw new Error('Microphone belongs in the independent Audio ARM VSIX');
    if (((entry.attr >>> 16) & 0o170000) === 0o120000) throw new Error('Links are not permitted in release VSIX');
    if (entry.entryName.startsWith('extension/bin/') && !entry.entryName.startsWith(prefix) && entry.entryName !== 'extension/bin/') throw new Error(`Foreign runtime in ${target}: ${entry.entryName}`);
    if (/(?:^|\/)(?:plan\.md|.*\.log|auth\.json|settings\.json|\.env)$/.test(entry.entryName)) throw new Error('Private file in VSIX');
  }
  const metadata = JSON.parse(zip.readAsText(prefix + 'codex-package.json'));
  if (metadata.vsixTarget !== target || metadata.target !== info.triple || metadata.version !== runtimeConfig.version || metadata.entrypoint !== `bin/${info.executable}` || metadata.source?.integrity !== info.integrity || metadata.source?.url !== info.url) throw new Error('VSIX Codex provenance/target mismatch');
  if (!metadata.files || !Array.isArray(metadata.executableFiles)) throw new Error('Missing runtime integrity manifest');
  for (const key of coreFiles(target)) {
    const entry = zip.getEntry(prefix + key);
    if (!entry) throw new Error(`Missing Codex helper ${key}`);
    const binary = inspectBinary(entry.getData(), target);
    if (info.platform === 'linux' && key.startsWith('bin/') && binary.interpreter) throw new Error('Linux Codex requires a dynamic loader');
  }
  for (const [key, digest] of Object.entries(metadata.files)) {
    const bytes = zip.readFile(prefix + safeRelative(key));
    if (!bytes || createHash('sha256').update(bytes).digest('hex') !== digest) throw new Error(`Codex file hash mismatch: ${key}`);
  }
  for (const entry of entries.filter(entry => entry.entryName.startsWith(prefix) && !entry.isDirectory)) {
    const key = entry.entryName.slice(prefix.length);
    if (key !== 'codex-package.json' && !(key in metadata.files)) throw new Error(`Unmanifested runtime file: ${key}`);
  }
  for (const key of metadata.executableFiles) {
    const entry = zip.getEntry(prefix + safeRelative(key));
    if (!entry || ((entry.attr >>> 16) & 0o111) !== 0o111) throw new Error(`Lost execute permission: ${key}`);
  }
  for (const name of ['LICENSE', 'NOTICE']) if (!zip.getEntry(prefix + name)) throw new Error(`Missing Codex ${name}`);
  if (verifyDist) {
    for (const key of await filesIn(join(extensionRoot, 'dist'))) {
      if (!zip.readFile('extension/dist/' + key)?.equals(await readFile(join(extensionRoot, 'dist', key)))) throw new Error(`Stale dist in VSIX: ${key}`);
    }
  }
  if (extractRuntime) {
    const destination = await generatedPath(resolve(extractRuntime), join(root, 'artifacts'));
    await mkdir(destination, { recursive: true });
    for (const entry of entries.filter(entry => entry.entryName.startsWith(prefix) && !entry.isDirectory)) {
      const key = entry.entryName.slice(prefix.length), output = join(destination, safeRelative(key));
      await generatedPath(output, destination);
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, entry.getData(), { mode: metadata.executableFiles.includes(key) ? 0o755 : 0o644 });
      // An existing file can retain its previous mode despite writeFile's mode.
      await chmod(output, metadata.executableFiles.includes(key) ? 0o755 : 0o644);
    }
  }
  console.log(`Verified ${target} VSIX: Codex ${metadata.version}, ${Object.keys(metadata.files).length} runtime files, platform and execute bits`);
  return { version: manifest.version, target, metadata };
}
