import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';

export const audioId = 'openai.codex-audio';
export const microphoneCommands = ['available', 'start', 'read', 'stop', 'cancel'].map(action => `_codex.microphone.${action}`);
export const pinnedAudio = JSON.parse(await readFile(resolve(import.meta.dirname, '../codex-audio.json'), 'utf8'));
const stable = /^\d+\.\d+\.\d+$/;
const property = (entry, key) => entry.properties?.find(value => value.key === key)?.value;
export function validateAudioManifest(audio) {
  if (audio?.id !== audioId || !stable.test(audio.version || '') || audio.channel !== 'release' || audio.targetPlatform !== 'universal' || !/^\^\d+\.\d+\.\d+$/.test(audio.engine || '') || !/^[a-f0-9]{64}$/.test(audio.sha256 || '')) throw new Error('Invalid stable Codex Audio manifest');
  const url = new URL(audio.url);
  if (url.protocol !== 'https:' || url.hostname !== 'openai.gallerycdn.vsassets.io' || !url.pathname.startsWith(`/extensions/openai/codex-audio/${audio.version}/`) || !url.pathname.endsWith('/Microsoft.VisualStudio.Services.VSIXPackage') || url.username || url.password || url.search || url.hash) throw new Error('Codex Audio package must come from the official OpenAI Marketplace CDN');
  return audio;
}
export function audioFromGallery(response, version = 'latest') {
  const extension = response?.results?.flatMap(result => result.extensions || []).find(entry => entry.extensionName === 'codex-audio' && entry.publisher?.publisherName === 'openai');
  if (!extension || !extension.publisher.flags?.split(',').map(value => value.trim()).includes('verified')) throw new Error('Official verified OpenAI Codex Audio publisher was not returned');
  const releases = (extension.versions || []).filter(entry => stable.test(entry.version || '') && property(entry, 'Microsoft.VisualStudio.Code.PreRelease') !== 'true');
  releases.sort((a, b) => { const av = a.version.split('.').map(Number), bv = b.version.split('.').map(Number); return bv[0] - av[0] || bv[1] - av[1] || bv[2] - av[2]; });
  const selectedVersion = version === 'latest' ? releases[0]?.version : version;
  const entry = releases.find(entry => entry.version === selectedVersion && (!entry.targetPlatform || entry.targetPlatform === 'universal'));
  if (!entry) throw new Error(`No official stable universal Codex Audio ${selectedVersion || version} package; upstream platform layout may need adaptation`);
  return validateAudioManifest({ id: audioId, version: entry.version, channel: 'release', targetPlatform: 'universal',
    engine: property(entry, 'Microsoft.VisualStudio.Code.Engine'),
    url: entry.files?.find(file => file.assetType === 'Microsoft.VisualStudio.Services.VSIXPackage')?.source,
    sha256: property(entry, 'Microsoft.VisualStudio.Services.VsixSha256'),
    marketplace: pinnedAudio.marketplace,
  });
}
export function fetchAudioGallery() {
  const body = JSON.stringify({ filters: [{ criteria: [{ filterType: 7, value: audioId }], pageNumber: 1, pageSize: 1 }], flags: 211 });
  const args = ['--silent', '--show-error', '--fail', '--retry', '3', '--connect-timeout', '15', '--max-time', '45', '--proto', '=https', '--header', 'Accept: application/json;api-version=7.2-preview.1', '--header', 'Content-Type: application/json', '--data-binary', '@-'];
  if (process.platform === 'win32') args.push('--ssl-revoke-best-effort');
  if (process.env.CODEX_DOWNLOAD_PROXY) args.push('--proxy', process.env.CODEX_DOWNLOAD_PROXY);
  return new Promise((done, reject) => {
    const child = spawn(process.platform === 'win32' ? 'curl.exe' : 'curl', [...args, 'https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let data = '', errors = '';
    child.stdout.on('data', bytes => { data += bytes; }); child.stderr.on('data', bytes => { errors += bytes; });
    child.once('error', reject); child.stdin.on('error', () => {});
    child.once('exit', code => { if (code !== 0) { reject(new Error(`Codex Audio Marketplace lookup failed (${code}): ${errors.slice(-1000)}`)); return; } try { done(JSON.parse(data)); } catch { reject(new Error('Invalid Codex Audio Marketplace response')); } });
    child.stdin.end(body);
  });
}
export async function resolveCodexAudio(version = 'latest', fetchGallery = fetchAudioGallery) {
  if (version === 'pinned') return validateAudioManifest(structuredClone(pinnedAudio));
  if (version !== 'latest' && !stable.test(version)) throw new Error('Use latest, pinned or a stable Codex Audio version');
  return audioFromGallery(await fetchGallery(), version);
}
