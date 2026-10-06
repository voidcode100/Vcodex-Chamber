import { createReadStream } from 'node:fs';
import { readFile, readdir, mkdir, lstat, rm, rename, cp, chmod, writeFile, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { resolve, join, relative, isAbsolute, dirname } from 'node:path';
import * as tar from 'tar';
import { pinnedRuntime, validateManifest, resolveCodexRuntime } from './codex-releases.mjs';

export const root = resolve(import.meta.dirname, '../..');
export const extensionRoot = join(root, 'packages/vscode');
export let runtimeConfig = process.env.VCODEX_CODEX_RUNTIME_MANIFEST
  ? validateManifest(JSON.parse(await readFile(resolve(process.env.VCODEX_CODEX_RUNTIME_MANIFEST), 'utf8')))
  : validateManifest(structuredClone(pinnedRuntime));
export const targets = Object.keys(pinnedRuntime.targets);
export const nativeTarget = `${process.platform}-${process.arch}`;
export async function loadRuntimeManifest(file) {
  runtimeConfig = validateManifest(JSON.parse(await readFile(resolve(file), 'utf8')));
  return runtimeConfig;
}
export async function selectBuildRuntime({ version, manifest, offline = false } = {}) {
  manifest ||= process.env.VCODEX_CODEX_RUNTIME_MANIFEST;
  if (version && manifest) throw new Error('Choose --codex-version or --runtime-manifest, not both');
  if (manifest) return loadRuntimeManifest(manifest);
  if (offline && version !== 'pinned') throw new Error('Offline packaging requires --runtime-manifest <saved snapshot> or --codex-version pinned; latest must query upstream');
  runtimeConfig = await resolveCodexRuntime(version || 'latest');
  const file = await generatedPath(join(root, 'artifacts/build/codex-runtime.json'), join(root, 'artifacts'));
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(runtimeConfig, null, 2) + '\n');
  console.log(`Packaging official Codex ${runtimeConfig.version}: ${runtimeConfig.release}; snapshot ${file}`);
  return runtimeConfig;
}
export function targetInfo(target) {
  const info = runtimeConfig.targets[target];
  if (!info) throw new Error(`Unsupported VSIX target ${target}; choose ${targets.join(', ')}. ARM means ARM64, not ARMv7.`);
  return { ...info, target, folder: `${info.platform}-${info.arch}`, executable: info.platform === 'windows' ? 'codex.exe' : 'codex' };
}
export async function hashFile(file, algorithm = 'sha256', encoding = 'hex') {
  const hash = createHash(algorithm);
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest(encoding);
}
export function run(command, args, options = {}) {
  return new Promise((done, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', windowsHide: true, ...options });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? done() : reject(new Error(`${command} exited with ${code}`)));
  });
}
export function safeRelative(file) {
  if (!file || file.includes('\\') || file.includes('\0') || file.includes(':') || isAbsolute(file) || file.split('/').includes('..')) throw new Error(`Unsafe archive path: ${file}`);
  return file;
}
export async function generatedPath(path, base) {
  const absolute = resolve(path), parent = resolve(base), rel = relative(parent, absolute);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`Generated path escaped ${parent}`);
  // Check every existing ancestor before deleting, extracting or overwriting.
  let current = absolute;
  while (true) {
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error(`Linked generated path: ${current}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (current === parent) break;
    current = dirname(current);
  }
  return absolute;
}
export async function removeGenerated(path, base) { await rm(await generatedPath(path, base), { recursive: true, force: true }); }
export async function filesIn(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const key = prefix + entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Runtime contains link: ${key}`);
    if (entry.isDirectory()) files.push(...await filesIn(join(directory, entry.name), key + '/'));
    else if (entry.isFile()) files.push(key);
  }
  return files.sort();
}
export function inspectBinary(bytes, target) {
  const info = targetInfo(target);
  if (info.platform === 'windows') {
    if (bytes.length < 64 || bytes.toString('ascii', 0, 2) !== 'MZ') throw new Error('Expected a PE executable');
    const pe = bytes.readUInt32LE(60);
    if (pe + 6 > bytes.length || bytes.readUInt32LE(pe) !== 0x4550) throw new Error('Invalid PE header');
    if (bytes.readUInt16LE(pe + 4) !== (info.arch === 'x86_64' ? 0x8664 : 0xaa64)) throw new Error(`PE architecture does not match ${target}`);
    return { format: 'PE', arch: info.arch };
  }
  if (bytes.length < 64 || !bytes.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])) || bytes[4] !== 2 || bytes[5] !== 1) throw new Error('Expected a little-endian ELF64 executable');
  if (bytes.readUInt16LE(18) !== (info.arch === 'x86_64' ? 62 : 183)) throw new Error(`ELF architecture does not match ${target}`);
  const offset = Number(bytes.readBigUInt64LE(32)), size = bytes.readUInt16LE(54), count = bytes.readUInt16LE(56);
  if (size < 56 || offset + count * size > bytes.length) throw new Error('Invalid ELF program headers');
  const interpreter = Array.from({ length: count }, (_, i) => bytes.readUInt32LE(offset + i * size)).includes(3);
  return { format: 'ELF', arch: info.arch, interpreter };
}
export async function inspectFile(file, target) {
  const handle = await open(file, 'r');
  try {
    const bytes = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    return inspectBinary(bytes.subarray(0, bytesRead), target);
  } finally { await handle.close(); }
}
export function coreFiles(target) {
  const info = targetInfo(target), suffix = info.platform === 'windows' ? '.exe' : '';
  return [`bin/codex${suffix}`, `bin/codex-code-mode-host${suffix}`, ...(info.platform === 'windows'
    ? ['codex-resources/codex-command-runner.exe', 'codex-resources/codex-windows-sandbox-setup.exe']
    : ['codex-resources/bwrap']), `codex-path/rg${suffix}`];
}
export async function validateRuntime(directory, target) {
  const info = targetInfo(target);
  const metadata = JSON.parse(await readFile(join(directory, 'codex-package.json'), 'utf8'));
  if (metadata.version !== runtimeConfig.version || metadata.target !== info.triple || metadata.entrypoint !== `bin/${info.executable}`) throw new Error(`Runtime metadata does not match pinned ${target}`);
  for (const key of coreFiles(target)) {
    const binary = await inspectFile(join(directory, key), target);
    if (info.platform === 'linux' && key.startsWith('bin/') && binary.interpreter) throw new Error(`${key} is dynamically linked; expected the portable musl executable`);
  }
  return metadata;
}
export async function prepareRuntime(target, { offline = false } = {}) {
  const info = targetInfo(target);
  const cache = join(root, 'artifacts/codex', runtimeConfig.version);
  const archive = join(cache, 'downloads', `${target}.tgz`);
  await generatedPath(archive, join(root, 'artifacts'));
  await mkdir(dirname(archive), { recursive: true });
  const valid = async () => {
    try { return `sha512-${await hashFile(archive, 'sha512', 'base64')}` === info.integrity; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  };
  if (!(await valid())) {
    if (offline) throw new Error(`No verified offline Codex archive for ${target}`);
    const partial = archive + '.partial';
    await generatedPath(partial, join(root, 'artifacts'));
    const args = ['--fail', '--location', '--retry', '3', '--retry-delay', '2', '--connect-timeout', '20', '--max-time', '600', '--proto', '=https', '--output', partial];
    // Schannel may be unable to reach revocation servers behind a proxy.
    // Keep TLS CA/hostname verification, and reject known revoked certificates.
    if (process.platform === 'win32') args.push('--ssl-revoke-best-effort');
    if (process.env.CODEX_DOWNLOAD_PROXY) args.push('--proxy', process.env.CODEX_DOWNLOAD_PROXY);
    console.log(`Downloading official Codex ${runtimeConfig.version} for ${target}`);
    await run(process.platform === 'win32' ? 'curl.exe' : 'curl', [...args, info.url]);
    if (`sha512-${await hashFile(partial, 'sha512', 'base64')}` !== info.integrity) throw new Error(`Codex archive integrity mismatch for ${target}`);
    await rename(partial, archive);
  }
  const extraction = join(cache, target);
  await removeGenerated(extraction, join(root, 'artifacts'));
  await mkdir(extraction, { recursive: true });
  const executableFiles = [];
  const prefix = `package/vendor/${info.triple}/`;
  // Read structured tar entries first; no links or traversal are accepted.
  await tar.t({ file: archive, strict: true, onReadEntry(entry) {
    safeRelative(entry.path);
    if (!entry.path.startsWith('package/') || !['File', 'Directory'].includes(entry.type)) throw new Error(`Unexpected archive entry ${entry.path}`);
    if (entry.type === 'File' && entry.path.startsWith(prefix) && (entry.mode & 0o111)) executableFiles.push(entry.path.slice(prefix.length));
  } });
  await tar.x({ file: archive, cwd: extraction, strict: true, preserveOwner: false });
  const directory = join(extraction, 'package/vendor', info.triple);
  await validateRuntime(directory, target);
  await writeFile(join(extraction, 'executables.json'), JSON.stringify(executableFiles.sort()));
  return { directory, executableFiles: executableFiles.sort() };
}
export async function stageRuntime(target, prepared) {
  const info = targetInfo(target);
  const directory = join(extensionRoot, 'bin', info.folder);
  await removeGenerated(directory, join(extensionRoot, 'bin'));
  await mkdir(dirname(directory), { recursive: true });
  await cp(prepared.directory, directory, { recursive: true, errorOnExist: true });
  for (const file of ['LICENSE', 'NOTICE']) await cp(join(root, 'third_party/codex', file), join(directory, file));
  for (const key of prepared.executableFiles) await chmod(join(directory, safeRelative(key)), 0o755);
  const upstream = await validateRuntime(directory, target);
  const files = {};
  for (const key of await filesIn(directory)) if (key !== 'codex-package.json') files[key] = await hashFile(join(directory, key));
  const metadata = { ...upstream, vsixTarget: target, source: { url: info.url, integrity: info.integrity, release: runtimeConfig.release, releaseId: runtimeConfig.releaseId }, executableFiles: prepared.executableFiles, files };
  await writeFile(join(directory, 'codex-package.json'), JSON.stringify(metadata, null, 2) + '\n');
  console.log(`Staged verified Codex ${metadata.version} (${info.triple})`);
  return directory;
}
