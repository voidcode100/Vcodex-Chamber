import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join, dirname, resolve, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'packages/vscode/package.json'));
const temporary = await mkdtemp(join(tmpdir(), 'openchamber-transport-test-'));
try {
  const file = join(temporary, 'transport.test.cjs');
  await require('esbuild').build({ entryPoints: [join(root, 'packages/vscode/src/codex/dictationTransport.test.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: file });
  const result = spawnSync(process.execPath, ['--test', file], { stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  if (dirname(resolve(temporary)) !== resolve(tmpdir()) || !basename(temporary).startsWith('openchamber-transport-test-')) throw new Error('Unexpected test directory');
  await rm(temporary, { recursive: true, force: true });
}
