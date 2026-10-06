import { chmodSync, copyFileSync, createReadStream, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const extensionRoot = join(root, 'packages', 'vscode');
const platform = process.env.CODEX_TARGET_PLATFORM || (process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux');
const arch = process.env.CODEX_TARGET_ARCH || (process.arch === 'x64' ? 'x86_64' : process.arch === 'arm64' ? 'aarch64' : process.arch);
const executableName = platform === 'windows' ? 'codex.exe' : 'codex';

function findOnPath(name) {
  const pathValue = process.env.PATH || process.env.Path || '';
  const extensions = platform === 'windows' ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  for (const directory of pathValue.split(process.platform === 'win32' ? ';' : ':')) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = join(directory, name + (name.includes('.') ? '' : extension));
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function findSource() {
  if (process.env.CODEX_CLI_SOURCE && existsSync(process.env.CODEX_CLI_SOURCE)) return resolve(process.env.CODEX_CLI_SOURCE);
  const fromPath = findOnPath(executableName);
  if (fromPath) return resolve(fromPath);
  if (process.env.CODEX_HOME) {
    const candidate = join(process.env.CODEX_HOME, 'bin', executableName);
    if (existsSync(candidate)) return resolve(candidate);
    try {
      for (const entry of readdirSync(join(process.env.CODEX_HOME, 'bin'), { withFileTypes: true }).reverse()) {
        if (!entry.isDirectory()) continue;
        const versioned = join(process.env.CODEX_HOME, 'bin', entry.name, executableName);
        if (existsSync(versioned)) return resolve(versioned);
      }
    } catch {}
  }
  if (platform === 'windows' && process.env.LOCALAPPDATA) {
    const rootPath = join(process.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
    try {
      for (const entry of readdirSync(rootPath, { withFileTypes: true }).reverse()) {
        if (!entry.isDirectory()) continue;
        const candidate = join(rootPath, entry.name, executableName);
        if (existsSync(candidate)) return resolve(candidate);
      }
    } catch {}
  }
  return null;
}

const source = findSource();
if (!source) {
  throw new Error(`Codex CLI binary not found for ${platform}-${arch}. Set CODEX_CLI_SOURCE or install Codex before packaging.`);
}

const destinationDirectory = join(extensionRoot, 'bin', `${platform}-${arch}`);
const destination = join(destinationDirectory, executableName);
// Windows Codex delegates execution to sibling binaries. Copy the runtime
// from one release directory; mixing helpers from another release is unsafe.
const runtimeNames = [executableName];
if (platform === 'windows') {
  for (const name of ['codex-code-mode-host.exe', 'codex-command-runner.exe', 'codex-windows-sandbox-setup.exe']) {
    if (!existsSync(join(dirname(source), name))) throw new Error(`Incomplete Codex runtime: missing ${name} next to ${source}`);
    runtimeNames.push(name);
  }
  for (const name of readdirSync(dirname(source))) {
    if (name.toLowerCase().endsWith('.dll')) runtimeNames.push(name);
  }
}
mkdirSync(destinationDirectory, { recursive: true });
for (const name of runtimeNames) copyFileSync(join(dirname(source), name), join(destinationDirectory, name));
for (const name of ['LICENSE', 'NOTICE']) {
  copyFileSync(join(root, 'third_party', 'codex', name), join(destinationDirectory, name));
}
if (platform !== 'windows') chmodSync(destination, 0o755);

let version = process.env.CODEX_CLI_VERSION || null;
try {
  const output = execFileSync(source, ['--version'], { encoding: 'utf8', timeout: 10_000, windowsHide: true }).trim();
  version = output.match(/(\d+\.\d+\.\d+)/)?.[1] || version;
} catch {}

async function hashFile(path) { return await new Promise((resolveHash, reject) => {
  const hash = createHash('sha256');
  const stream = createReadStream(path);
  stream.on('data', (chunk) => hash.update(chunk));
  stream.on('error', reject);
  stream.on('end', () => resolveHash(hash.digest('hex')));
}); }
const files = Object.fromEntries(await Promise.all(runtimeNames.map(async (name) => [name, await hashFile(join(destinationDirectory, name))])));
const sha256 = files[executableName];

writeFileSync(join(destinationDirectory, 'codex-package.json'), `${JSON.stringify({
  layoutVersion: 1,
  version,
  target: `${arch}-${platform}`,
  sha256,
  files,
  variant: 'codex',
  entrypoint: platform === 'windows' ? 'bin/codex.exe' : 'bin/codex',
}, null, 2)}\n`);
console.log(`Staged Codex ${version || 'unknown'} from ${source} -> ${destination}`);
