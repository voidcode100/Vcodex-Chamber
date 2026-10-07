import assert from 'node:assert/strict';
import { test } from 'node:test';
import { request } from 'node:https';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import { CaptureReceiver, type CaptureRecord } from './captureReceiver';

const nodeTest = 'Bun' in globalThis ? test.skip : test;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV4cAAAAASUVORK5CYII=', 'base64');
async function harness() {
  const storage = await mkdtemp(join(tmpdir(), 'openchamber-sender-test-'));
  const turns: CaptureRecord[][] = []; const voiceCalls: string[] = [];
  let target: string | undefined = 'session-a', busy = false, uncertain = false, voiceActive = false, failVoice = false;
  const make = () => new CaptureReceiver({ globalStorageUri: { fsPath: storage } as never }, { appendLine() {} }, {
    getStatus: () => ({ target: { mode: 'active', sessionId: target }, connection: 'connected', auth: 'authenticated', voiceActive }),
    onCapture: async payload => {
      const sessionId = payload.sessionId || target;
      if (!sessionId) throw new Error('没有可用会话');
      const path = join(storage, payload.id + '.png'); await writeFile(path, payload.bytes);
      return { sessionId, path };
    },
    onBatchSend: async (_id, captures) => {
      if (busy) throw new Error('会话忙，队列保留');
      if (uncertain) throw Object.assign(new Error('提交未确认'), { uncertain: true });
      turns.push(captures);
    },
    onVoiceFrame: async frame => {
      voiceCalls.push(frame.kind);
      if (frame.kind === 'start') { voiceActive = true; return { sessionId: target }; }
      if (frame.kind === 'cancel') { voiceActive = false; return; }
      if (failVoice) { failVoice = false; throw new Error('临时转写失败，保留录音'); }
      const text = voiceActive ? '测试转写' : '';
      voiceActive = false; return { sessionId: 'session-a', transcript: text };
    },
  });
  let receiver = make();
  await receiver.start('127.0.0.1', 0, 'pairing-token');
  const port = ((receiver as unknown as { server: { address(): { port: number } } }).server.address()).port;
  const send = (path: string, body?: unknown, headers: Record<string, string> = {}) => new Promise<{ status: number; body: Record<string, any> }>((done, reject) => {
    const raw = Buffer.isBuffer(body) ? body : body ? Buffer.from(JSON.stringify(body)) : undefined;
    const req = request({ host: '127.0.0.1', port, path, method: body ? 'POST' : 'GET', rejectUnauthorized: false,
      headers: { authorization: 'Bearer pairing-token', ...headers } }, res => {
      const chunks: Buffer[] = []; res.on('data', c => chunks.push(c)); res.on('end', () => done({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) }));
    }); req.on('error', reject); req.end(raw);
  });
  return { storage, port, turns, voiceCalls, receiver, send, make,
    target: (id?: string) => { target = id; }, busy: (value: boolean) => { busy = value; }, uncertain: (value = true) => { uncertain = value; }, failVoice: () => { failVoice = true; },
    cleanup: async () => { await receiver.stop(); await rm(storage, { recursive: true, force: true }); } };
}

nodeTest('HTTPS capture staging, ordered atomic batch, concurrency, failures and restart receipts', async () => {
  const h = await harness();
  try {
    const upload = (id: string, batch = 'batch-0001') => h.send('/v1/capture', png, { 'x-capture-id': id, 'x-capture-batch-id': batch, 'content-type': 'image/png' });
    const first = await upload('capture-0001'); assert.equal(first.status, 201);
    h.target('session-b');
    // Explicit sender routing pins later images to the same target.
    await h.send('/v1/capture', png, { 'x-capture-id': 'capture-0002', 'x-capture-batch-id': 'batch-0002', 'x-target-session': 'session-a', 'content-type': 'image/png' });
    assert.equal(h.turns.length, 0);
    assert.equal((await upload('capture-0001')).body.duplicate, true);
    assert.equal(h.receiver.getPendingCaptures().length, 2);
    h.busy(true);
    const input = { requestId: 'request-0001', captureIds: ['capture-0001', 'capture-0002'] };
    assert.equal((await h.send('/v1/capture/send', input)).status, 409);
    assert.equal(h.receiver.getPendingCaptures().length, 2);
    h.busy(false);
    const replies = await Promise.all([h.send('/v1/capture/send', input), h.send('/v1/capture/send', input)]);
    assert.ok(replies.every(r => r.status === 202)); assert.equal(h.turns.length, 1);
    assert.deepEqual(h.turns[0].map(c => c.id), input.captureIds);
    assert.ok(h.turns[0].every(c => c.sessionId === 'session-a'));
    assert.deepEqual(await readFile(h.turns[0][0].path), png, 'Codex input must still exist after start');
    await h.receiver.stop(); const restored = h.make();
    await restored.start('127.0.0.1', h.port, 'pairing-token');
    try {
      assert.equal((await h.send('/v1/capture/send', input)).body.duplicate, true);
      assert.equal(h.turns.length, 1);
      assert.equal((await upload('capture-0001')).body.sent, true);
    } finally { await restored.stop(); }
  } finally { await h.cleanup(); }
});

nodeTest('missing target, mixed-session batch and uncertain turn never silently duplicate', async () => {
  const h = await harness();
  try {
    const upload = (id: string) => h.send('/v1/capture', png, { 'x-capture-id': id, 'content-type': 'image/png' });
    h.target(undefined); assert.equal((await upload('capture-1001')).status, 409);
    h.target('session-a'); await upload('capture-1001'); h.target('session-b'); await upload('capture-1002');
    assert.equal((await h.send('/v1/capture/send', { requestId: 'request-mixed' })).status, 409);
    h.uncertain();
    assert.equal((await h.send('/v1/capture/send', { requestId: 'request-1001', captureIds: ['capture-1001'] })).status, 409);
    assert.equal((await h.send('/v1/capture/send', { requestId: 'request-new1', captureIds: ['capture-1001'] })).status, 409);
    assert.equal(h.turns.length, 0); assert.equal(h.receiver.getPendingCaptures().length, 2);
    await h.receiver.resolveUncertain('request-1001', false);
    h.uncertain(false);
    assert.equal((await h.send('/v1/capture/send', { requestId: 'request-1001', captureIds: ['capture-1001'] })).status, 202);
    h.uncertain();
    await h.send('/v1/capture/send', { requestId: 'request-1002', captureIds: ['capture-1002'] });
    await h.receiver.resolveUncertain('request-1002', true);
    assert.equal(h.receiver.getPendingCaptures().length, 0);
    assert.equal((await h.send('/v1/capture/send', { requestId: 'request-1002', captureIds: ['capture-1002'] })).body.duplicate, true);
    assert.equal(h.turns.length, 1, 'confirming receipt must not resend an uncertain turn');
  } finally { await h.cleanup(); }
});

nodeTest('capture removal is session scoped, persisted, never re-uploaded and protects uncertain submissions', async () => {
  const h = await harness();
  const upload = (id: string, sessionId = 'session-a') => h.send('/v1/capture', png, { 'x-capture-id': id, 'x-target-session': sessionId, 'content-type': 'image/png' });
  try {
    await upload('remove-0001'); await upload('remove-0002'); await upload('remove-0003', 'session-b');
    assert.equal((await h.send('/v1/capture/remove', { sessionId: 'session-a', mode: 'last' })).body.removed, 1);
    assert.equal((await upload('remove-0002')).body.discarded, true);
    assert.deepEqual(h.receiver.getPendingCaptures().map(c => c.id), ['remove-0001', 'remove-0003']);
    assert.equal((await h.send('/v1/capture/remove', { sessionId: 'session-a', captureIds: ['offline-0001', 'remove-0003'] })).status, 409);
    assert.equal((await upload('offline-0001')).body.discarded, undefined, 'failed mixed-session removal must be atomic');
    assert.equal((await h.send('/v1/capture/remove', { sessionId: 'session-a' })).body.removed, 2);
    assert.equal(h.receiver.getPendingCaptures().length, 1);
    h.uncertain(); await h.receiver.sendPending('remove-uncertain', ['remove-0003']).catch(() => undefined);
    assert.equal((await h.send('/v1/capture/remove', { sessionId: 'session-b' })).status, 409);
    await h.receiver.stop(); const restored = h.make(); await restored.start('127.0.0.1', h.port, 'pairing-token');
    try { assert.equal((await upload('remove-0001')).body.discarded, true); assert.equal(restored.getPendingCaptures().length, 1); }
    finally { await restored.stop(); }
  } finally { await h.cleanup(); }
});

nodeTest('voice controls wait for acknowledgment, retry failure, deduplicate across reconnects and reject wrong pairing', async () => {
  const h = await harness();
  const open = async () => {
    const socket = new WebSocket(`wss://127.0.0.1:${h.port}/v1/voice`, { rejectUnauthorized: false, headers: { authorization: 'Bearer pairing-token' } });
    await new Promise<void>((done, reject) => { socket.once('open', () => done()); socket.once('error', reject); }); return socket;
  };
  const control = (socket: WebSocket, type: string, requestId: string) => new Promise<Record<string, any>>(done => {
    const listener = (data: Buffer) => { const response = JSON.parse(data.toString()); if (response.requestId === requestId) { socket.off('message', listener); done(response); } };
    socket.on('message', listener); socket.send(JSON.stringify({ type, requestId }));
  });
  try {
    let socket = await open();
    assert.equal((await control(socket, 'start', 'voice-start1')).type, 'ack'); socket.terminate(); socket = await open();
    assert.equal((await control(socket, 'start', 'voice-start1')).type, 'ack'); assert.equal(h.voiceCalls.length, 1);
    h.failVoice(); assert.equal((await control(socket, 'stop', 'voice-stop01')).type, 'error');
    assert.equal((await control(socket, 'stop', 'voice-stop01')).transcript, '测试转写');
    assert.equal((await control(socket, 'stop', 'voice-stop01')).transcript, '测试转写');
    assert.deepEqual(h.voiceCalls, ['start', 'stop', 'stop']); socket.terminate();
    const unauthorized = await h.send('/v1/status', undefined, { authorization: 'Bearer bad-token' }); assert.equal(unauthorized.status, 401);
  } finally { await h.cleanup(); }
});

nodeTest('real .NET WindowsSender stages captures, pins TLS and recovers a held key after failed transcription', { skip: process.platform !== 'win32', timeout: 180_000 }, async () => {
  const h = await harness();
  const executable = resolve('artifacts/test/windowssender/WindowsSender.Tests.dll');
  const child = spawn('dotnet', [executable, String(h.port), 'pairing-token', h.receiver.getCertificateFingerprint(), join(h.storage, 'sender')], { windowsHide: true });
  const lines = createInterface({ input: child.stdout });
  let pending: { name: string; resolve: (value: Record<string, any>) => void; reject: (error: Error) => void; timer: NodeJS.Timeout } | undefined;
  let stderr = ''; child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
  const waiting = (name: string, timeout: number) => new Promise<Record<string, any>>((resolve, reject) => {
    assert.equal(pending, undefined, 'test commands must be sequential');
    const timer = setTimeout(() => { pending = undefined; reject(new Error(`sender timed out during ${name} (${timeout}ms): ${stderr || 'no stderr'}`)); }, timeout);
    pending = { name, resolve, reject, timer };
  });
  const startup = waiting('runtime startup', 60_000);
  const fail = (error: Error) => { const current = pending; pending = undefined; if (current) { clearTimeout(current.timer); current.reject(error); } };
  child.on('error', fail);
  child.stdin.on('error', fail);
  child.on('exit', (code, signal) => fail(new Error(`sender exited during ${pending?.name || 'idle'} (${code}/${signal}): ${stderr}`)));
  lines.on('line', line => {
    let value: Record<string, any>;
    try { value = JSON.parse(line); } catch { fail(new Error(`sender emitted invalid JSON during ${pending?.name}`)); return; }
    const current = pending; pending = undefined;
    if (current) { clearTimeout(current.timer); current.resolve(value); }
  });
  const command = async (command: string) => {
    const result = waiting(command, 30_000);
    child.stdin.write(JSON.stringify({ command }) + '\n', error => { if (error) fail(error); });
    const value = await result;
    console.log(`WindowsSender integration: ${command} -> ${value.ok ? 'ok' : 'rejected'}`);
    return value;
  };
  try {
    assert.equal((await startup).ready, true);
    const seeded = await command('seed'); assert.equal(seeded.ok, true);
    assert.equal((await command('stage')).ok, true); assert.equal(h.turns.length, 0); assert.equal(h.receiver.getPendingCaptures().length, 2);
    assert.equal((await command('stage')).ok, true); assert.equal(h.receiver.getPendingCaptures().length, 2);
    h.busy(true); assert.equal((await command('send')).ok, false); h.busy(false);
    assert.equal((await command('duplicate-send')).ok, true); assert.equal(h.turns.length, 1);
    assert.deepEqual(h.turns[0].map(c => c.id), seeded.result);
    assert.equal((await command('start')).ok, true); assert.equal((await command('start')).ok, true);
    h.failVoice(); assert.equal((await command('stop')).ok, false);
    assert.equal((await command('stop')).result, '测试转写');
    assert.equal((await command('cancel')).ok, true);
    const voiceBegin = h.voiceCalls.length;
    assert.equal((await command('hold-down')).result, true);
    h.failVoice(); assert.equal((await command('hold-up')).ok, false);
    assert.equal((await command('hold-down')).result, true, 'the next key-down must restart after the failed short recording');
    assert.equal((await command('hold-down')).result, true, 'holding/repeat must not trigger another start');
    assert.equal(h.voiceCalls.at(-1), 'start', 'fresh capture starts before the held key is released');
    assert.equal((await command('hold-up')).ok, true);
    assert.deepEqual(h.voiceCalls.slice(voiceBegin), ['start', 'stop', 'start', 'stop']);
    assert.equal((await command('bad-pin')).ok, false); await command('restore-pin');
    assert.equal((await command('bad-token')).ok, false); await command('restore-token');
    await command('seed'); await command('stage');
    await h.receiver.sendPending('manual-send1');
    assert.equal((await command('stage')).ok, true);
    assert.equal((await command('send')).result, 0, 'manual client send must drain stale sender queue without duplicating');
    assert.equal(h.turns.length, 2);
    const removed = await command('seed'); await command('stage');
    assert.equal((await command('remove-last')).result, 1);
    assert.deepEqual(h.receiver.getPendingCaptures().map(c => c.id), [removed.result[0]]);
    assert.equal((await command('stage')).result, 1, 'removed images must not be staged again');
    assert.equal((await command('remove-all')).result, 1); assert.equal(h.receiver.getPendingCaptures().length, 0);
    const clientRemoved = await command('seed'); await command('stage');
    await h.receiver.removePending([clientRemoved.result[0]], 'session-a');
    assert.equal((await command('stage')).result, 1, 'client remove must drain the sender copy');
    assert.equal((await command('remove-all')).result, 1);
    assert.equal((await command('input-tests')).result.passed, 12);
    assert.equal((await command('validate-hotkeys')).ok, false);
  } finally { if (pending) clearTimeout(pending.timer); pending = undefined; child.stdin.end(); child.kill(); lines.close(); await h.cleanup(); }
});
