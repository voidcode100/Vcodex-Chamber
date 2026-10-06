import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'packages/vscode/package.json'));
if (process.platform === 'win32') {
  const build = spawnSync('dotnet', ['build', 'tests/windowssender/WindowsSender.Tests.csproj', '-c', 'Release', '-o', 'artifacts/test/windowssender'], { cwd: root, stdio: 'inherit', windowsHide: true });
  if (build.status !== 0) process.exit(build.status ?? 1);
}
const directory = await mkdtemp(join(tmpdir(), 'openchamber-sender-tests-'));
try {
  const file = join(directory, 'receiver.test.cjs');
  await require('esbuild').build({ entryPoints: [join(root, 'packages/vscode/src/captureReceiver.test.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: file });
  const managerFile = join(directory, 'manager.test.cjs');
  await require('esbuild').build({ entryPoints: [join(root, 'scripts/fixtures/windowssender-manager.test.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: managerFile,
    plugins: [{ name: 'vscode-host-fixture', setup(build) {
      build.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'fixture' }));
      build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `export const extensions={getExtension:()=>undefined}; export const env={remoteName:undefined}; export const workspace={getConfiguration:()=>({get:(key,fallback)=>fallback})}; export const Uri={file:fsPath=>({fsPath})}; export const FileType={Directory:2}; export class Disposable{constructor(fn){this.dispose=fn}} export const commands={executeCommand:()=>{throw Error('Microphone is mocked by the fixture')}};` }));
    } }],
  });
  const result = spawnSync(process.execPath, ['--test', file, managerFile], { cwd: root, stdio: 'inherit', windowsHide: true });
  process.exitCode = result.status ?? 1;
} finally { if (dirname(directory) === tmpdir()) await rm(directory, { recursive: true, force: true }); }
