import { spawnSync } from 'node:child_process';

// Keep package test commands independent from the caller's working directory.
// Bun is used because the repository tests include TypeScript and ESM fixtures.
const bun = process.env.BUN_BIN || (process.platform === 'win32' ? 'bun.exe' : 'bun');
const result = spawnSync(bun, ['test', ...process.argv.slice(2)], {
  stdio: 'inherit',
  cwd: process.cwd(),
  env: process.env,
  shell: process.platform === 'win32',
});

if (result.error) {
  console.error(`Unable to start Bun test runner (${bun}): ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
