import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CodexExecutableResolver } from './resolver';

const contextFor = (root: string) => ({ extensionUri: { fsPath: root } }) as never;

test('resolver prefers an explicit executable path', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'capture-codex-resolver-'));
  try {
    const explicit = path.join(root, 'codex.exe');
    writeFileSync(explicit, 'test');
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
    const directory = path.join(root, 'bin', 'windows-x86_64');
    mkdirSync(directory, { recursive: true });
    const executable = path.join(directory, 'codex.exe');
    writeFileSync(executable, 'test');
    writeFileSync(path.join(directory, 'codex-package.json'), JSON.stringify({ version: '0.160.0' }));
    const resolver = new CodexExecutableResolver(contextFor(root));
    const result = resolver.resolveSync();
    assert.equal(result?.path, executable);
    assert.equal(result?.source, 'bundled');
    assert.equal(result?.version, '0.160.0');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
