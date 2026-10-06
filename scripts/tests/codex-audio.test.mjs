import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Zip } from '../lib/vsix-tools.mjs';
import { auditAudioZip, selectBuildAudio } from '../lib/codex-audio-tools.mjs';
import { audioFromGallery, audioId, microphoneCommands, pinnedAudio, validateAudioManifest, resolveCodexAudio } from '../lib/codex-audio-releases.mjs';

const property = (key, value) => ({ key, value });
function gallery(versions, { verified = true } = {}) {
  return { results: [{ extensions: [{ extensionName: 'codex-audio', publisher: { publisherName: 'openai', flags: verified ? 'verified' : '' }, versions }] }] };
}
function release(version, { platform, prerelease = false } = {}) {
  const base = `https://openai.gallerycdn.vsassets.io/extensions/openai/codex-audio/${version}/build/Microsoft.VisualStudio.Services.VSIXPackage`;
  return { version, targetPlatform: platform, properties: [property('Microsoft.VisualStudio.Code.Engine', '^1.96.2'), ...(prerelease ? [property('Microsoft.VisualStudio.Code.PreRelease', 'true')] : []), property('Microsoft.VisualStudio.Services.VsixSha256', pinnedAudio.sha256)], files: [{ assetType: 'Microsoft.VisualStudio.Services.VSIXPackage', source: base }] };
}

test('Codex Audio resolver selects the highest stable universal verified release', () => {
  const result = audioFromGallery(gallery([release('26.9.0'), release('26.11.0', { prerelease: true }), release('26.10.0'), release('26.10.0', { platform: 'win32-x64' })]));
  assert.equal(result.id, audioId);
  assert.equal(result.version, '26.10.0');
  assert.equal(result.targetPlatform, 'universal');
  assert.equal(result.engine, '^1.96.2');
  assert.throws(() => audioFromGallery(gallery([release('26.9.0')], { verified: false })), /verified/);
  assert.throws(() => audioFromGallery(gallery([release('26.9.0'), release('26.10.0', { platform: 'win32-x64' })])), /No official stable universal/);
});

test('Audio manifests are constrained to the official CDN and stable UI package', () => {
  assert.doesNotThrow(() => validateAudioManifest(pinnedAudio));
  for (const change of [
    audio => { audio.url = 'https://example.test/audio.vsix'; },
    audio => { audio.sha256 = 'not-a-sha'; },
    audio => { audio.targetPlatform = 'win32-x64'; },
    audio => { audio.channel = 'preview'; },
  ]) {
    const copy = structuredClone(pinnedAudio); change(copy);
    assert.throws(() => validateAudioManifest(copy), /manifest|official/);
  }
});

test('pinned Audio needs no network and offline selection rejects missing or mismatched snapshots', async () => {
  assert.deepEqual(await resolveCodexAudio('pinned', () => { throw new Error('No network allowed'); }), pinnedAudio);
  await assert.rejects(selectBuildAudio({}, { offline: true, version: 'latest' }), /Offline VSIX/);
  await assert.rejects(selectBuildAudio({ audio: structuredClone(pinnedAudio) }, { offline: true, version: '1.2.3' }), /not requested/);
});

test('official Audio archive contains the UI host and microphone command contract', () => {
  const zip = new Zip();
  zip.addFile('extension/package.json', Buffer.from(JSON.stringify({
    name: 'codex-audio', publisher: 'openai', version: pinnedAudio.version,
    engines: { vscode: pinnedAudio.engine }, extensionKind: ['ui'], main: './out/extension.js',
  })));
  zip.addFile('extension/out/extension.js', Buffer.from(microphoneCommands.join('\n')));
  zip.addFile('extension/LICENSE.md', Buffer.from('See https://openai.com/policies/row-terms-of-use.'));
  assert.doesNotThrow(() => auditAudioZip(zip, pinnedAudio));
  zip.addFile('extension/out/extension.js', Buffer.from(microphoneCommands.slice(1).join('\n')));
  assert.throws(() => auditAudioZip(zip, pinnedAudio), /removed.*available/);
  zip.addFile('extension/out/extension.js', Buffer.from(microphoneCommands.join('\n')));
  zip.deleteFile('extension/LICENSE.md');
  assert.throws(() => auditAudioZip(zip, pinnedAudio), /license/);
  zip.addFile('extension/package.json', Buffer.from(JSON.stringify({ name: 'codex-audio', publisher: 'other', version: pinnedAudio.version })));
  assert.throws(() => auditAudioZip(zip, pinnedAudio), /identity/);
});
