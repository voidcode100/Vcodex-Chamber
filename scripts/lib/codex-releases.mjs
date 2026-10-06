import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

export const pinnedRuntime = JSON.parse(await readFile(resolve(import.meta.dirname, '../codex-runtime.json'), 'utf8'));
const stableVersion = /^\d+\.\d+\.\d+$/;
export function validateManifest(config) {
  if (!stableVersion.test(config?.version || '') || config.release !== `https://github.com/openai/codex/releases/tag/rust-v${config.version}`) throw new Error('Expected an official stable Codex release manifest');
  const expected = Object.keys(pinnedRuntime.targets).sort();
  if (JSON.stringify(Object.keys(config.targets || {}).sort()) !== JSON.stringify(expected)) throw new Error('Codex manifest must include all four supported platforms');
  for (const target of expected) {
    const actual = config.targets[target], shape = pinnedRuntime.targets[target];
    if (['platform', 'arch', 'triple'].some(key => actual[key] !== shape[key]) || actual.url !== `https://registry.npmjs.org/@openai/codex/-/codex-${config.version}-${target}.tgz` || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(actual.integrity || '')) throw new Error(`Invalid official package metadata for ${target}`);
  }
  return config;
}
export function manifestCacheKey(config) {
  return createHash('sha256').update(JSON.stringify({ version: config.version, targets: config.targets })).digest('hex');
}
export function fetchOfficialJSON(url) {
  const host = new URL(url).hostname;
  if (!['api.github.com', 'registry.npmjs.org'].includes(host)) throw new Error('Unexpected metadata host');
  const args = ['--silent', '--show-error', '--fail', '--retry', '3', '--retry-delay', '2', '--connect-timeout', '15', '--max-time', '45', '--proto', '=https', '--header', 'Accept: application/json', '--user-agent', 'Vcodex-Chamber-build'];
  if (process.platform === 'win32') args.push('--ssl-revoke-best-effort');
  if (process.env.CODEX_DOWNLOAD_PROXY) args.push('--proxy', process.env.CODEX_DOWNLOAD_PROXY);
  const token = host === 'api.github.com' && (process.env.GH_TOKEN || process.env.GITHUB_TOKEN);
  // Send credentials through stdin, never through process arguments or logs.
  if (token) args.push('--header', '@-');
  return new Promise((done, reject) => {
    const child = spawn(process.platform === 'win32' ? 'curl.exe' : 'curl', [...args, url], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let body = '', error = '';
    child.stdout.on('data', bytes => { body += bytes; });
    child.stderr.on('data', bytes => { error += bytes; });
    child.once('error', reject);
    child.once('exit', code => {
      if (code !== 0) { reject(new Error(`Official Codex metadata request failed (${host}, exit ${code}): ${error.slice(-1000)}`)); return; }
      try { done(JSON.parse(body)); } catch { reject(new Error(`Invalid JSON from ${host}`)); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(token ? `Authorization: Bearer ${token}\n` : '');
  });
}
export async function resolveCodexRuntime(version = 'latest', fetchJSON = fetchOfficialJSON) {
  if (version === 'pinned') return validateManifest(structuredClone(pinnedRuntime));
  if (version !== 'latest' && !stableVersion.test(version)) throw new Error('Use latest, pinned or a stable MAJOR.MINOR.PATCH Codex version');
  const latest = version === 'latest';
  const release = await fetchJSON(latest ? 'https://api.github.com/repos/openai/codex/releases/latest' : `https://api.github.com/repos/openai/codex/releases/tags/rust-v${version}`);
  const match = release.tag_name?.match(/^rust-v(\d+\.\d+\.\d+)$/);
  if (!match || release.draft !== false || release.prerelease !== false || (!latest && match[1] !== version)) throw new Error('Upstream did not return the requested stable Codex release');
  version = match[1];
  const targets = {};
  // Every platform must exist for this exact GitHub release. Never mix latest
  // npm dist-tags, prereleases or an older fallback with another target.
  await Promise.all(Object.entries(pinnedRuntime.targets).map(async ([target, shape]) => {
    const metadata = await fetchJSON(`https://registry.npmjs.org/@openai/codex/${version}-${target}`);
    if (metadata.name !== '@openai/codex' || metadata.version !== `${version}-${target}`) throw new Error(`npm package version does not match Codex ${version} / ${target}`);
    targets[target] = { ...shape, url: metadata.dist?.tarball, integrity: metadata.dist?.integrity };
  }));
  // Stable key order makes cache keys independent of concurrent responses.
  return validateManifest({ version, release: `https://github.com/openai/codex/releases/tag/rust-v${version}`, releaseId: release.id,
    resolvedAt: new Date().toISOString(), selection: latest ? 'latest-stable' : 'explicit',
    targets: Object.fromEntries(Object.keys(pinnedRuntime.targets).map(target => [target, targets[target]])),
  });
}
