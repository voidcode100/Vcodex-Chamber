import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CodexExecutableResolver } from './resolver';

const contextFor = (root: string) => ({ extensionUri: { fsPath: root } }) as never;
const executableName = process.platform === 'win32' ? 'codex.exe' : 'codex';
const platform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
function executable(file: string) { writeFileSync(file, 'test'); chmodSync(file, 0o755); }

test('resolver prefers an explicit executable path', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'capture-codex-resolver-'));
  try {
    const explicit = path.join(root, executableName);
    executable(explicit);
    const resolver = new CodexExecutableResolver(contextFor(root));
    const result = resolver.resolveSync(explicit);
    assert.equal(result?.path, explicit);
    assert.equal(result?.source, 'configured');
    assert.equal(result?.bundled, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolver finds the platform bundled executable and metadata', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'capture-codex-resolver-'));
  try {
    const directory = path.join(root, 'bin', `${platform}-${arch}`);
    mkdirSync(directory, { recursive: true });
    const file = path.join(directory, executableName);
    executable(file);
    writeFileSync(path.join(directory, 'codex-package.json'), JSON.stringify({ version: '0.160.0' }));
    const resolver = new CodexExecutableResolver(contextFor(root));
    const result = resolver.resolveSync();
    assert.equal(result?.path, file);
    assert.equal(result?.source, 'bundled');
    assert.equal(result?.version, '0.160.0');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolver prefers the official bin layout and reads runtime root metadata', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'capture-codex-resolver-'));
  try {
    const directory = path.join(root, 'bin', `${platform}-${arch}`);
    mkdirSync(path.join(directory, 'bin'), { recursive: true });
    const file = path.join(directory, 'bin', executableName);
    executable(file);
    executable(path.join(directory, executableName));
    writeFileSync(path.join(directory, 'codex-package.json'), JSON.stringify({ version: '0.160.0' }));
    const result = new CodexExecutableResolver(contextFor(root)).resolveSync();
    assert.equal(result?.path, file);
    assert.equal(result?.version, '0.160.0');
    assert.equal(result?.source, 'bundled');
    assert.equal(result?.platform, platform);
    assert.equal(result?.arch, arch);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
