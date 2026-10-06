import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { releasePlan, verifyReleaseAssets } from '../publish-release.mjs';

const base = { RELEASE_VERSION: '1.0.0', GITHUB_SHA: 'a'.repeat(40), GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_RUN_ID: '1234', GITHUB_RUN_ATTEMPT: '1', RELEASE_DRAFT: 'false' };

test('manual releases bind a unique prerelease tag to the exact built commit', () => {
  const plan = releasePlan(base);
  assert.equal(plan.tag, 'v1.0.0-build.1234.1');
  assert.equal(plan.args[plan.args.indexOf('--target') + 1], base.GITHUB_SHA);
  assert.ok(plan.args.includes('--prerelease'));
  assert.ok(!plan.args.includes('--draft'));
  assert.equal(plan.assets.length, 8);
  assert.notEqual(releasePlan({ ...base, GITHUB_RUN_ATTEMPT: '2' }).tag, plan.tag);
  assert.notEqual(releasePlan({ ...base, GITHUB_RUN_ID: '1235' }).tag, plan.tag);
  assert.ok(releasePlan({ ...base, RELEASE_DRAFT: 'true' }).args.includes('--draft'));
});

test('stable releases require matching version tags, unsupported events cannot publish', () => {
  const plan = releasePlan({ ...base, GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/tags/v1.0.0' });
  assert.equal(plan.tag, 'v1.0.0');
  assert.ok(plan.args.includes('--verify-tag'));
  assert.ok(!plan.args.includes('--prerelease'));
  assert.ok(!plan.args.includes('--target'));
  for (const bad of [{ GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'push' }, { GITHUB_REF: 'refs/tags/v1.0.1', GITHUB_EVENT_NAME: 'push' }, { GITHUB_EVENT_NAME: 'pull_request' }, { GITHUB_SHA: 'main' }, { GITHUB_RUN_ID: '../foreign' }]) {
    assert.throws(() => releasePlan({ ...base, ...bad }));
  }
});

test('release upload rejects changed assets and incomplete or extra checksums', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vcodex-release-test-'));
  try {
    const plan = releasePlan(base, directory);
    const bytes = Buffer.from('built-and-checked');
    const digest = createHash('sha256').update(bytes).digest('hex');
    const sums = plan.checksumFiles.map(file => `${digest}  ${file}\n`).join('');
    for (const file of plan.checksumFiles) await writeFile(join(directory, file), bytes);
    await writeFile(join(directory, 'SHA256SUMS.txt'), sums);
    await verifyReleaseAssets(plan, directory);
    await writeFile(join(directory, plan.checksumFiles[0]), 'corrupted');
    await assert.rejects(verifyReleaseAssets(plan, directory), /checksum mismatch/);
    await writeFile(join(directory, 'SHA256SUMS.txt'), sums + `${digest}  unwanted.zip\n`);
    await assert.rejects(verifyReleaseAssets(plan, directory), /Unexpected/);
    await writeFile(join(directory, 'SHA256SUMS.txt'), sums.split('\n').slice(1).join('\n'));
    await assert.rejects(verifyReleaseAssets(plan, directory), /Missing/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
