import { createReadStream } from 'node:fs';
import { readFile, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

// Manual builds use unique prerelease tags so rebuilding source version 1.0.0
// never replaces its existing published binaries or moves its release tag.
export function releasePlan(env, directory = 'release') {
  const version = env.RELEASE_VERSION;
  if (!/^\d+\.\d+\.\d+$/.test(version || '')) throw new Error('Release version must be MAJOR.MINOR.PATCH');
  if (!/^[a-f0-9]{40}$/.test(env.GITHUB_SHA || '')) throw new Error('Release requires the exact build commit SHA');
  if (env.RELEASE_DRAFT && !['true', 'false'].includes(env.RELEASE_DRAFT)) throw new Error('Invalid draft selection');
  const manual = env.GITHUB_EVENT_NAME === 'workflow_dispatch';
  let tag;
  if (manual) {
    if (!/^[1-9]\d*$/.test(env.GITHUB_RUN_ID || '') || !/^[1-9]\d*$/.test(env.GITHUB_RUN_ATTEMPT || '')) throw new Error('Manual release requires run ID and attempt');
    tag = `v${version}-build.${env.GITHUB_RUN_ID}.${env.GITHUB_RUN_ATTEMPT}`;
  } else {
    tag = `v${version}`;
    if (env.GITHUB_EVENT_NAME !== 'push' || env.GITHUB_REF !== `refs/tags/${tag}`) throw new Error('Stable release requires a matching version tag push');
  }
  const checksumFiles = ['win32-x64', 'win32-arm64', 'linux-x64', 'linux-arm64'].map(target => `Vcodex-Chamber-${version}-${target}.vsix`);
  checksumFiles.push(`Vcodex-Chamber-WindowsSender-${version}-win-x64.zip`, 'codex-runtime.json');
  const assets = [...checksumFiles, 'SHA256SUMS.txt'];
  const args = ['release', 'create', tag, ...assets.map(file => join(directory, file))];
  if (manual) args.push('--target', env.GITHUB_SHA, '--prerelease');
  else args.push('--verify-tag');
  if (env.RELEASE_DRAFT === 'true') args.push('--draft');
  args.push('--title', `Vcodex-Chamber ${tag}`, '--notes',
    `Built from ${env.GITHUB_SHA}. Windows/Linux x64 and ARM64 VSIX packages include the stable upstream Codex resolved once for this build. See codex-runtime.json for Codex/Codex Audio versions and integrity. WindowsSender is Windows x64 only. All platform build checks passed before release. See README and docs/builds.md for installation and validation scope.`);
  return { tag, args, checksumFiles, assets };
}

export async function verifyReleaseAssets(plan, directory) {
  const checksums = new Map();
  const text = await readFile(join(directory, 'SHA256SUMS.txt'), 'utf8');
  for (const line of text.trim().split(/\r?\n/)) {
    const match = line.match(/^([a-f0-9]{64})  ([A-Za-z0-9.-]+)$/);
    if (!match || !plan.checksumFiles.includes(match[2]) || checksums.has(match[2])) throw new Error('Unexpected or duplicate release checksum');
    checksums.set(match[2], match[1]);
  }
  if (checksums.size !== plan.checksumFiles.length) throw new Error('Missing release checksum');
  for (const file of plan.assets) {
    const path = join(directory, file);
    if (!(await lstat(path)).isFile()) throw new Error(`Release asset must be a regular file: ${file}`);
    if (file === 'SHA256SUMS.txt') continue;
    const hash = createHash('sha256');
    for await (const bytes of createReadStream(path)) hash.update(bytes);
    if (hash.digest('hex') !== checksums.get(file)) throw new Error(`Release asset checksum mismatch: ${file}`);
  }
}

async function main() {
  const { values } = parseArgs({ options: { directory: { type: 'string', default: 'release' }, 'dry-run': { type: 'boolean', default: false } } });
  const directory = resolve(values.directory);
  const plan = releasePlan(process.env, directory);
  await verifyReleaseAssets(plan, directory);
  if (values['dry-run']) { console.log(`Validated ${plan.tag}: ${plan.assets.length} release assets; ${process.env.RELEASE_DRAFT === 'true' ? 'draft' : 'published'} ${process.env.GITHUB_EVENT_NAME === 'workflow_dispatch' ? 'prerelease' : 'stable release'}; no GitHub changes`); return; }
  if (!process.env.GH_TOKEN || !process.env.GH_REPO) throw new Error('Release requires GH_TOKEN and GH_REPO');
  // gh create fails for an existing release; never upload --clobber or edit it.
  await new Promise((done, reject) => {
    const child = spawn(process.platform === 'win32' ? 'gh.exe' : 'gh', plan.args, { stdio: 'inherit', windowsHide: true });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? done() : reject(new Error(`GitHub release creation failed (${code}); existing releases are not replaced`)));
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
