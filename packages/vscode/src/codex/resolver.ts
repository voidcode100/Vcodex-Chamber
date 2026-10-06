import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type * as vscode from 'vscode';

const execFileAsync = promisify(execFile);

export type CodexExecutableSource = 'configured' | 'bundled' | 'codex-home' | 'path';

export type CodexExecutableInfo = {
  path: string;
  source: CodexExecutableSource;
  version: string | null;
  platform: string;
  arch: string;
  bundled: boolean;
};

const executableName = (platform: NodeJS.Platform = process.platform): string => platform === 'win32' ? 'codex.exe' : 'codex';

const targetPlatform = (platform: NodeJS.Platform): string => {
  if (platform === 'win32') return 'windows';
  if (platform === 'darwin') return 'macos';
  return 'linux';
};

const targetArch = (arch: string): string => {
  if (arch === 'x64') return 'x86_64';
  if (arch === 'arm64') return 'aarch64';
  return arch;
};

function isExecutable(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    if (process.platform === 'win32') return true;
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolvePathCommand(command: string, env: NodeJS.ProcessEnv): string | null {
  if (path.isAbsolute(command) || command.includes(path.sep) || (process.platform === 'win32' && command.includes('/'))) {
    return isExecutable(command) ? path.resolve(command) : null;
  }
  const pathValue = env.PATH ?? env.Path ?? '';
  const candidates = pathValue.split(path.delimiter).filter(Boolean);
  const extensions = process.platform === 'win32'
    ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
    : [''];
  for (const directory of candidates) {
    for (const extension of extensions) {
      const candidate = path.join(directory, command + (process.platform === 'win32' && path.extname(command) ? '' : extension));
      if (isExecutable(candidate)) return path.resolve(candidate);
    }
  }
  return null;
}

function readVersion(binaryPath: string): string | null {
  // Official packages keep metadata next to bin/, while older development
  // packages kept it next to the executable. Support both layouts.
  for (const directory of [path.dirname(binaryPath), path.dirname(path.dirname(binaryPath))]) {
    try {
      const metadata = JSON.parse(fs.readFileSync(path.join(directory, 'codex-package.json'), 'utf8')) as { version?: unknown };
      if (typeof metadata.version === 'string') return metadata.version;
    } catch { /* Missing metadata is a normal fallback. */ }
  }
  return null;
}

async function readBinaryVersion(binaryPath: string): Promise<string | null> {
  try {
    const result = await execFileAsync(binaryPath, ['--version'], { encoding: 'utf8', timeout: 5_000, windowsHide: true });
    const output = typeof result.stdout === 'string' ? result.stdout : '';
    return output.match(/(\d+\.\d+\.\d+)/)?.[1] || null;
  } catch {
    return null;
  }
}

function codexHomeCandidates(env: NodeJS.ProcessEnv): string[] {
  const homes = new Set<string>();
  if (env.CODEX_HOME) homes.add(env.CODEX_HOME);
  if (process.platform === 'win32' && env.LOCALAPPDATA) homes.add(path.join(env.LOCALAPPDATA, 'OpenAI', 'Codex'));
  homes.add(path.join(os.homedir(), '.codex'));
  return [...homes];
}

function findInCodexHome(home: string, name: string): string | null {
  const direct = [path.join(home, 'bin', name), path.join(home, name)];
  for (const candidate of direct) if (isExecutable(candidate)) return path.resolve(candidate);
  const binRoot = path.join(home, 'bin');
  try {
    for (const entry of fs.readdirSync(binRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(binRoot, entry.name, name);
      if (isExecutable(candidate)) return path.resolve(candidate);
    }
  } catch {
    // A missing Codex home is a normal fallback case.
  }
  return null;
}

export class CodexExecutableResolver {
  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveSync(configured?: string | null): CodexExecutableInfo | null {
    const env = process.env;
    const platform = targetPlatform(process.platform);
    const arch = targetArch(process.arch);
    const name = executableName();

    if (configured?.trim()) {
      const resolved = resolvePathCommand(configured.trim(), env);
      if (resolved) return { path: resolved, source: 'configured', version: readVersion(resolved), platform, arch, bundled: false };
    }

    const runtimeRoot = path.join(this.context.extensionUri.fsPath, 'bin', `${platform}-${arch}`);
    for (const bundled of [path.join(runtimeRoot, 'bin', name), path.join(runtimeRoot, name)]) {
      if (isExecutable(bundled)) return { path: bundled, source: 'bundled', version: readVersion(bundled), platform, arch, bundled: true };
    }

    for (const home of codexHomeCandidates(env)) {
      const resolved = findInCodexHome(home, name);
      if (resolved) return { path: resolved, source: 'codex-home', version: readVersion(resolved), platform, arch, bundled: false };
    }

    const resolved = resolvePathCommand(name, env);
    return resolved ? { path: resolved, source: 'path', version: readVersion(resolved), platform, arch, bundled: false } : null;
  }

  async resolve(configured?: string | null): Promise<CodexExecutableInfo | null> {
    const result = this.resolveSync(configured);
    if (!result || result.version) return result;
    const version = await readBinaryVersion(result.path);
    return version ? { ...result, version } : result;
  }
}
