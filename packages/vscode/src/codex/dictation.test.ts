import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Dictation, pcmToWav, transcribeRecording, type DictationState } from './dictation';

function audioHarness(failures = 0) {
  const states: DictationState[] = [];
  let pending: ((frame: unknown) => void) | undefined;
  let stopped = false;
  let uploads = 0;
  let starts = 0;
  const dictation = new Dictation({
    command: async <T>(name: string) => {
      if (name.endsWith('.available')) return 1 as T;
      if (name.endsWith('.start')) { starts++; stopped = false; return { status: 'started', sampleRate: 16_000 } as T; }
      if (name.endsWith('.read')) {
        if (stopped) return { status: 'stopped' } as T;
        return new Promise<unknown>(resolve => { pending = resolve; }) as Promise<T>;
      }
      if (name.endsWith('.stop')) { stopped = true; pending?.({ status: 'audio', pcm: Buffer.from([1, 0, 2, 0]).toString('base64') }); }
      if (name.endsWith('.cancel')) { stopped = true; pending?.({ status: 'stopped' }); }
      return undefined as T;
    },
    state: state => states.push(state),
    transcribe: async (pcm, sampleRate) => {
      uploads++;
      assert.equal(sampleRate, 16_000);
      assert.deepEqual([...pcm], [1, 0, 2, 0], 'stop must drain the final chunk');
      if (uploads <= failures) throw new Error('temporary upload failure');
      return '你好 Codex';
    },
  });
  return { dictation, states, counts: () => ({ uploads, starts }) };
}

test('duplicate start/stop uses one capture and drains the final PCM before transcription', async () => {
  const h = audioHarness();
  await Promise.all([h.dictation.start(), h.dictation.start()]);
  assert.deepEqual(await Promise.all([h.dictation.stop(), h.dictation.stop()]), ['你好 Codex', '你好 Codex']);
  assert.deepEqual(h.counts(), { uploads: 1, starts: 1 });
  assert.deepEqual(h.states, ['recording', 'uploading', 'idle']);
  assert.equal(await h.dictation.stop(), '');
});

test('failed upload retains PCM in memory and duplicate retries do not start a new recording', async () => {
  const h = audioHarness(1);
  await h.dictation.start();
  await assert.rejects(h.dictation.stop(), /temporary upload failure/);
  assert.equal(h.dictation.active, true);
  await assert.rejects(h.dictation.start(), /重试/);
  assert.deepEqual(await Promise.all([h.dictation.stop(), h.dictation.stop()]), ['你好 Codex', '你好 Codex']);
  assert.deepEqual(h.counts(), { uploads: 2, starts: 1 });
  assert.equal(h.dictation.active, false);
});

test('discard after a failed upload clears the retained recording', async () => {
  const h = audioHarness(1);
  await h.dictation.start();
  await assert.rejects(h.dictation.stop());
  await h.dictation.cancel();
  assert.equal(h.dictation.active, false);
  assert.equal(await h.dictation.stop(), '');
  await h.dictation.start();
  assert.equal(await h.dictation.stop(), '你好 Codex');
  assert.deepEqual(h.counts(), { uploads: 2, starts: 2 });
});

test('cancel discards audio, never transcribes, and permits the next recording', async () => {
  const h = audioHarness();
  await h.dictation.start();
  await h.dictation.cancel();
  assert.equal(h.counts().uploads, 0);
  assert.equal(h.dictation.active, false);
  await h.dictation.start();
  assert.equal(await h.dictation.stop(), '你好 Codex');
});

test('cancel while capture startup is pending does not leave an active microphone', async () => {
  const h = audioHarness();
  const started = h.dictation.start();
  const cancelled = h.dictation.cancel();
  await assert.rejects(started);
  await cancelled;
  assert.equal(h.dictation.active, false);
  assert.equal(h.counts().uploads, 0);
});

test('WAV header uses the actual Codex Audio sample rate, not a hardcoded 24 kHz', () => {
  const wav = pcmToWav(Buffer.alloc(320), 16_000);
  assert.equal(wav.readUInt32LE(24), 16_000);
  assert.equal(wav.readUInt32LE(28), 32_000);
  assert.equal(wav.readUInt32LE(40), 320);
});

test('cancelling during account lookup never starts the microphone when lookup completes', async () => {
  let ready!: () => void;
  const lookup = new Promise<void>(resolve => { ready = resolve; });
  const commands: string[] = [];
  const dictation = new Dictation({
    prepare: () => lookup,
    command: async <T>(name: string) => { commands.push(name); return undefined as T; },
    state: () => undefined,
    transcribe: async () => { throw new Error('must not upload'); },
  });
  const started = dictation.start();
  const rejected = assert.rejects(started, /abort/i);
  const cancelled = dictation.cancel();
  ready();
  await Promise.all([rejected, cancelled]);
  assert.equal(dictation.active, false);
  assert.ok(commands.every(name => name === '_codex.microphone.cancel'));
});

test('ChatGPT dictation uses the observed official multipart contract, refreshes 401 once', async () => {
  const refreshes: boolean[] = [];
  let calls = 0;
  const text = await transcribeRecording({
    pcm: Buffer.alloc(320), sampleRate: 16_000, signal: new AbortController().signal,
    auth: async refresh => {
      refreshes.push(refresh);
      return { authMethod: 'chatgpt', authToken: refresh ? 'renewed' : 'original', requiresOpenaiAuth: true };
    },
    fetch: (async (url, init) => {
      assert.equal(url, 'https://chatgpt.com/backend-api/transcribe');
      assert.equal(init?.redirect, 'error');
      const form = init?.body as FormData;
      assert.equal(form.get('model'), null, 'official ChatGPT dictation does not accept an invented model');
      const file = form.get('file') as File;
      assert.equal(file.type, 'audio/wav');
      assert.equal(Buffer.from(await file.arrayBuffer()).readUInt32LE(24), 16_000);
      assert.equal((init?.headers as Record<string, string>).Authorization, calls === 0 ? 'Bearer original' : 'Bearer renewed');
      return ++calls === 1 ? new Response('', { status: 401 }) : Response.json({ text: '官方听写' });
    }) as typeof fetch,
  });
  assert.equal(text, '官方听写');
  assert.deepEqual(refreshes, [false, true]);
});

test('explicit transcription API never receives Codex account credentials', async () => {
  await transcribeRecording({
    pcm: Buffer.alloc(320), sampleRate: 24_000, signal: new AbortController().signal,
    endpoint: 'https://example.test/v1/audio/transcriptions', apiKey: 'configured-key', model: 'gpt-4o-mini-transcribe',
    auth: async () => { throw new Error('must not request account credentials'); },
    fetch: (async (_url, init) => {
      assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer configured-key');
      assert.equal((init?.body as FormData).get('model'), 'gpt-4o-mini-transcribe');
      return Response.json({ text: 'ok' });
    }) as typeof fetch,
  });
});

test('API errors and empty transcripts fail instead of remaining in uploading', async () => {
  for (const response of [Response.json({ text: '' }), Response.json({ error: { message: 'quota exceeded' } }, { status: 429 })]) {
    await assert.rejects(transcribeRecording({
      pcm: Buffer.alloc(32), sampleRate: 16_000, signal: new AbortController().signal,
      auth: async () => ({ authMethod: 'apikey', authToken: 'key', requiresOpenaiAuth: true }),
      fetch: (async () => response) as typeof fetch,
    }));
  }
});

test('Cloudflare rejection does not blame API billing and never automatically retries the challenge', async () => {
  let requests = 0;
  await assert.rejects(transcribeRecording({
    pcm: Buffer.alloc(32), sampleRate: 16_000, signal: new AbortController().signal,
    auth: async () => ({ authMethod: 'chatgpt', authToken: 'token', requiresOpenaiAuth: true }),
    fetch: (async () => { requests++; return new Response('<html>challenge</html>', { status: 403, headers: { 'cf-mitigated': 'challenge', 'cf-ray': 'test-LHR' } }); }) as typeof fetch,
  }), /Cloudflare.*403.*并非缺少 API Key.*test-LHR/);
  assert.equal(requests, 1);
});

test('ChatGPT multipart uses optional language and actual client identity, without borrowing browser cookies', async () => {
  const claims = { sub: 'user-a', 'https://api.openai.com/auth': { chatgpt_account_id: 'account-a' } };
  const token = `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;
  await transcribeRecording({
    pcm: Buffer.alloc(320), sampleRate: 16_000, signal: new AbortController().signal,
    language: 'zh', clientVersion: '2.1.5',
    auth: async () => ({ authMethod: 'chatgpt', authToken: token, requiresOpenaiAuth: true }),
    fetch: (async (_url, init) => {
      const headers = new Headers(init?.headers);
      assert.equal(headers.get('ChatGPT-Account-Id'), 'account-a');
      assert.equal(headers.get('User-Agent'), 'OpenChamber/2.1.5');
      assert.equal(headers.get('originator'), 'openchamber');
      assert.equal(headers.has('cookie'), false);
      assert.equal((init?.body as FormData).get('language'), 'zh');
      return Response.json({ text: '测试' });
    }) as typeof fetch,
  });
});

test('401 refresh must not upload the recording into a different account', async () => {
  let requests = 0;
  await assert.rejects(transcribeRecording({
    pcm: Buffer.alloc(320), sampleRate: 16_000, signal: new AbortController().signal,
    auth: async refresh => ({ authMethod: 'chatgpt', requiresOpenaiAuth: true,
      authToken: `header.${Buffer.from(JSON.stringify({ sub: refresh ? 'user-b' : 'user-a' })).toString('base64url')}.sig`,
    }),
    fetch: (async () => { requests++; return new Response('', { status: 401 }); }) as typeof fetch,
  }), /账号已切换/);
  assert.equal(requests, 1);
});

test('microphone availability preserves platform/setup errors and cleans the recording state', async () => {
  const states: DictationState[] = [];
  const dictation = new Dictation({
    command: async () => { throw new Error('Linux ARM64 录音程序缺失或不可执行'); },
    state: state => states.push(state),
    transcribe: async () => { throw new Error('must not transcribe'); },
  });
  await assert.rejects(dictation.start(), /Linux ARM64/);
  assert.equal(dictation.active, false);
  assert.deepEqual(states, ['error']);
});

test('cancelling an HTTP transcription aborts its request', async () => {
  const abort = new AbortController();
  const transcribing = transcribeRecording({
    pcm: Buffer.alloc(32), sampleRate: 16_000, signal: abort.signal,
    auth: async () => ({ authMethod: 'chatgpt', authToken: 'token', requiresOpenaiAuth: true }),
    fetch: (async (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      abort.abort();
    })) as typeof fetch,
  });
  await assert.rejects(transcribing, /abort/i);
});
