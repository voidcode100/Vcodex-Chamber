import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { spawn } from 'node:child_process';
import { LinuxArmMicrophone } from '../../../codex-audio-arm/src/microphone';
import { MicrophoneRouter } from './microphoneRouter';
import { Dictation } from './dictation';

function harness({ failure, delayReady = false }: { failure?: string; delayReady?: boolean } = {}) {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: (_signal?: string) => { queueMicrotask(() => child.emit('close', null)); return true; } });
  let starts = 0; const args: string[][] = [];
  child.stdin.on('finish', () => {
    // The final PCM arrives after stop, before close. Both chunks must drain.
    child.stdout.write(Buffer.from([3, 0, 4, 0]));
    child.stderr.write('{"status":"stopped"}\n');
    child.emit('close', 0);
  });
  const ready = () => child.stderr.write('{"status":"started","sampleRate":16000}\n');
  const microphone = new LinuxArmMicrophone('/fake/recorder', () => '麦克风 "one"', ((_binary: string, parameters: string[]) => {
    starts++; args.push(parameters as string[]);
    if (failure) queueMicrotask(() => { child.stderr.write(JSON.stringify({ status: 'error', reason: failure }) + '\n'); });
    else if (!delayReady) queueMicrotask(ready);
    return child;
  }) as unknown as typeof spawn);
  return { microphone, child, ready, args, starts: () => starts };
}

test('ARM stop drains final PCM, uses actual sample rate and submits one transcript', async () => {
  const h = harness(); let uploads = 0;
  const dictation = new Dictation({ command: async <T>(name: string, ...args: unknown[]) => name.endsWith('.available') ? 1 as T : h.microphone.command<T>(name, args[0] as string), state: () => {},
    transcribe: async (pcm, rate) => { uploads++; assert.equal(rate, 16000); assert.deepEqual([...pcm], [1, 0, 2, 0, 3, 0, 4, 0]); return 'ARM 听写'; },
  });
  await Promise.all([dictation.start(), dictation.start()]);
  h.child.stdout.write(Buffer.from([1, 0, 2, 0]));
  assert.deepEqual(await Promise.all([dictation.stop(), dictation.stop()]), ['ARM 听写', 'ARM 听写']);
  assert.equal(h.starts(), 1); assert.equal(uploads, 1);
  assert.deepEqual(h.args[0], ['--device', '麦克风 "one"'], 'device is an argument, never shell code');
});

test('ARM cancel resolves a pending read and discards buffered PCM', async () => {
  const h = harness(); await h.microphone.command('_codex.microphone.start', 'first');
  const read = h.microphone.command('_codex.microphone.read', 'first');
  await h.microphone.command('_codex.microphone.cancel', 'first');
  assert.deepEqual(await read, { status: 'stopped' });
  assert.deepEqual(await h.microphone.command('_codex.microphone.read', 'first'), { status: 'stopped' });
});

test('ARM cancellation during startup rejects startup and releases the process', async () => {
  const h = harness({ delayReady: true });
  const start = h.microphone.command('_codex.microphone.start', 'first');
  const rejected = assert.rejects(start, /取消/);
  await h.microphone.command('_codex.microphone.cancel', 'first'); await rejected;
});

test('ARM reports no microphone and unexpected exits instead of installation instructions', async () => {
  const h = harness({ failure: 'No microphone input device' });
  await assert.rejects(h.microphone.command('_codex.microphone.start', 'first'), /No microphone/);
  await h.microphone.dispose();
  const h2 = harness(); await h2.microphone.command('_codex.microphone.start', 'second');
  const read = h2.microphone.command<{ status: string; reason: string }>('_codex.microphone.read', 'second');
  h2.child.emit('close', 1);
  assert.match((await read).reason, /意外退出/); await h2.microphone.dispose();
});

test('router prefers official Audio even on ARM, then falls back only on a local ARM desktop', async () => {
  const calls: string[] = []; let available = 1;
  const router = new MicrophoneRouter({ platform: 'linux', arch: 'arm64', remote: false,
    official: async <T>(name: string) => { calls.push(`official:${name}`); return (name.endsWith('.available') ? available : { status: 'started' }) as T; },
    arm: { command: async <T>(name: string) => { calls.push(`arm:${name}`); return 1 as T; } },
  });
  await router.command('_codex.microphone.available'); await router.command('_codex.microphone.start', 'one');
  assert.ok(calls.every(name => name.startsWith('official:')));
  available = 0; calls.length = 0;
  await router.command('_codex.microphone.available'); await router.command('_codex.microphone.start', 'two');
  assert.deepEqual(calls, ['official:_codex.microphone.available', 'arm:_codex.microphone.available', 'arm:_codex.microphone.start']);
});

test('remote ARM cannot silently capture a server microphone', async () => {
  const router = new MicrophoneRouter({ platform: 'linux', arch: 'arm64', remote: true,
    official: async <T>() => null as T, arm: { command: async () => { throw Error('remote microphone must not start'); } },
  });
  await assert.rejects(router.command('_codex.microphone.available'), /不会录制远程服务器/);
});

test('missing ARM executable has an architecture-specific installation error', async () => {
  await assert.rejects(new LinuxArmMicrophone('/missing/vcodex-recorder').available(), /ARM64 录音程序/);
});
