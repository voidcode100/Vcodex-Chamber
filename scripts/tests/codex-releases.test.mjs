import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pinnedRuntime, resolveCodexRuntime, validateManifest, manifestCacheKey } from '../lib/codex-releases.mjs';

function upstream({ version = '0.160.9', prerelease = false, draft = false, brokenTarget, wrongVersion } = {}) {
  const requests = [];
  return { requests, fetchJSON: async url => {
    requests.push(url);
    if (url.startsWith('https://api.github.com/')) return { tag_name: `rust-v${version}`, prerelease, draft, id: 42 };
    const target = Object.keys(pinnedRuntime.targets).find(target => url.endsWith(`-${target}`));
    if (!target || target === brokenTarget) throw new Error('Platform not published yet');
    return { name: '@openai/codex', version: `${wrongVersion || version}-${target}`, dist: {
      tarball: `https://registry.npmjs.org/@openai/codex/-/codex-${version}-${target}.tgz`, integrity: pinnedRuntime.targets[target].integrity,
    } };
  } };
}
test('latest takes one stable GitHub release and resolves all four exact npm versions', async () => {
  const fake = upstream();
  const config = await resolveCodexRuntime('latest', fake.fetchJSON);
  assert.equal(config.version, '0.160.9');
  assert.equal(config.selection, 'latest-stable');
  assert.equal(config.releaseId, 42);
  assert.equal(fake.requests[0], 'https://api.github.com/repos/openai/codex/releases/latest');
  assert.deepEqual(Object.keys(config.targets), Object.keys(pinnedRuntime.targets));
  for (const target of Object.keys(config.targets)) assert.ok(fake.requests.includes(`https://registry.npmjs.org/@openai/codex/0.160.9-${target}`));
  assert.equal(fake.requests.length, 5, 'never read independent npm latest dist-tags');
  assert.equal(manifestCacheKey(config), manifestCacheKey({ ...config, resolvedAt: 'tomorrow' }));
});
test('unavailable platform or mismatched npm release fails instead of silently packaging an older version', async () => {
  for (const options of [{ brokenTarget: 'linux-arm64' }, { wrongVersion: '0.160.8' }]) {
    await assert.rejects(resolveCodexRuntime('latest', upstream(options).fetchJSON), /not published|does not match/);
  }
});
test('drafts, prereleases and nonstable requested versions are rejected', async () => {
  for (const options of [{ draft: true }, { prerelease: true }, { version: '0.161.0-alpha.1' }]) {
    await assert.rejects(resolveCodexRuntime('latest', upstream(options).fetchJSON), /stable/);
  }
  await assert.rejects(resolveCodexRuntime('0.161.0-beta.1', upstream().fetchJSON), /stable/);
});
test('explicit version checks its GitHub tag; pinned mode works without networking', async () => {
  const fake = upstream({ version: '0.160.9' });
  const config = await resolveCodexRuntime('0.160.9', fake.fetchJSON);
  assert.equal(fake.requests[0], 'https://api.github.com/repos/openai/codex/releases/tags/rust-v0.160.9');
  assert.equal(config.selection, 'explicit');
  const pinned = await resolveCodexRuntime('pinned', () => { throw new Error('No networking permitted'); });
  assert.deepEqual(pinned, pinnedRuntime);
  await assert.rejects(resolveCodexRuntime('0.160.8', fake.fetchJSON), /requested stable/);
});
test('saved snapshots reject foreign URLs, invalid SHA-512 and missing architecture', () => {
  for (const change of [config => { config.targets['linux-x64'].url = 'https://example.com/codex.tgz'; },
    config => { config.targets['linux-x64'].integrity = 'sha1-weak'; },
    config => { delete config.targets['linux-arm64']; },
    config => { config.targets['win32-arm64'].arch = 'x86_64'; }]) {
    const config = structuredClone(pinnedRuntime); change(config);
    assert.throws(() => validateManifest(config), /metadata|all four/);
  }
});
