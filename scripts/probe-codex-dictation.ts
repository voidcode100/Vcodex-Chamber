// Explicit opt-in live check: uploads only the caller-supplied test WAV to the
// official ChatGPT transcription endpoint, never creates/sends a Codex turn.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { CodexTransport } from '../packages/vscode/src/codex/transport';
import { transcribeRecording } from '../packages/vscode/src/codex/dictation';
import { createDictationFetch } from '../packages/vscode/src/codex/dictationTransport';
import type { GetAuthStatusResponse } from '../packages/vscode/src/codex/generated/GetAuthStatusResponse';

async function main() {
  const [audioPath, proxy] = process.argv.slice(2);
  if (!audioPath) throw new Error('Usage: probe-codex-dictation <test.wav> [http-proxy-url]');
  const wav = await readFile(audioPath);
  if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Expected WAV');
  let pcm: Buffer | undefined;
  let sampleRate = 0;
  for (let offset = 12; offset + 8 <= wav.length;) {
    const id = wav.toString('ascii', offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    if (id === 'fmt ') {
      if (wav.readUInt16LE(offset + 8) !== 1 || wav.readUInt16LE(offset + 10) !== 1 || wav.readUInt16LE(offset + 22) !== 16) throw new Error('Expected PCM16 mono');
      sampleRate = wav.readUInt32LE(offset + 12);
    }
    if (id === 'data') pcm = wav.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size + (size % 2);
  }
  if (!pcm || !sampleRate) throw new Error('Missing PCM data');
  const rpc = new CodexTransport({ binary: resolve('packages/vscode/bin/windows-x86_64/codex.exe') });
  rpc.on('error', () => { /* request errors are handled below */ });
  rpc.start();
  try {
    await rpc.request('initialize', { clientInfo: { name: 'openchamber', title: 'OpenChamber', version: '2.1.5' } }, 15_000);
    rpc.notify('initialized');
    const auth = await rpc.request<GetAuthStatusResponse>('getAuthStatus', { includeToken: true, refreshToken: false });
    if (!['chatgpt', 'chatgptAuthTokens'].includes(auth.authMethod ?? '')) throw new Error('Probe requires ChatGPT sign-in; it never falls back to a paid API key');
    console.log(JSON.stringify({ authMethod: auth.authMethod, sampleRate, audioBytes: pcm.length }));
    const text = await transcribeRecording({
      pcm, sampleRate, signal: AbortSignal.timeout(60_000),
      auth: refreshToken => rpc.request<GetAuthStatusResponse>('getAuthStatus', { includeToken: true, refreshToken }),
      fetch: createDictationFetch({ proxy }), clientVersion: '2.1.5', language: 'en',
    });
    console.log(JSON.stringify({ success: true, text }));
  } finally { await rpc.stop(); }
}
void main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
