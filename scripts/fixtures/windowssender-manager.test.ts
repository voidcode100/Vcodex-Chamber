import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CodexManager } from '../../packages/vscode/src/codex/manager';

// The real manager, Dictation lifecycle and facade run here. Only hardware,
// authentication and Codex RPC/network responses are replaced.
async function fixture() {
  const manager = new CodexManager({
    extensionUri: { fsPath: process.cwd() }, extension: { packageJSON: { version: 'test' } },
    workspaceState: { get: (_key: string, fallback: unknown) => fallback, update: async () => undefined },
  } as never);
  const backend = manager.getBackend();
  const turns: Record<string, any>[] = [];
  let failure: Error | undefined, reads = 0, transcriptions = 0, stopping = false;
  let releaseRead: (() => void) | undefined;
  Object.defineProperty(backend, 'isRunning', { value: true });
  backend.request = (async (method: string) => method === 'account/read' ? { requiresOpenaiAuth: false } : { authMethod: 'ChatGPT', authToken: 'fixture-token' }) as never;
  backend.threadRead = (async ({ threadId }: { threadId: string }) => ({ thread: { id: threadId, cwd: process.cwd(), turns: [] } })) as never;
  backend.threadResume = (async ({ threadId }: { threadId: string }) => ({ thread: { id: threadId, cwd: process.cwd(), turns: [] } })) as never;
  backend.turnStart = (async (params: Record<string, any>) => { if (failure) throw failure; turns.push(params); return { turn: { id: 'fixture-turn' } }; }) as never;
  const options = (manager as any).dictation.options;
  options.command = async (name: string) => {
    if (name.endsWith('available')) return 1;
    if (name.endsWith('start')) { reads = 0; stopping = false; return { status: 'started', sampleRate: 24000 }; }
    if (name.endsWith('read')) {
      if (reads++ === 0) return { status: 'audio', pcm: Buffer.from([0, 0, 1, 0]).toString('base64') };
      if (!stopping) await new Promise<void>(done => { releaseRead = done; });
      return { status: 'stopped' };
    }
    if (name.endsWith('stop') || name.endsWith('cancel')) { stopping = true; releaseRead?.(); return; }
    throw new Error('Unexpected microphone command');
  };
  options.transcribe = async () => { transcriptions++; return '测试听写文字'; };
  await manager.refreshAuthState();
  manager.setActiveSession('session-a');
  manager.setSessionPrompt('session-a', '会话提示');
  return { manager, backend, turns, options, transcriptions: () => transcriptions, fail: (error?: Error) => { failure = error; },
    cleanup: () => manager.cancelVoice() };
}

test('recording is bound at start and duplicate stops send the transcript and session prompt once', async () => {
  const h = await fixture();
  try {
    assert.equal(await h.manager.startVoice(), 'session-a');
    await h.manager.startVoice('session-a');
    h.manager.setActiveSession('session-b');
    await assert.rejects(h.manager.stopVoice(true, 'session-b'), /另一会话/);
    assert.deepEqual(await Promise.all([h.manager.stopVoice(true, 'session-a'), h.manager.stopVoice(true, 'session-a')]), ['测试听写文字', '测试听写文字']);
    assert.equal(h.transcriptions(), 1); assert.equal(h.turns.length, 1);
    assert.equal(h.turns[0].threadId, 'session-a');
    assert.equal(h.turns[0].input[0].text, '会话提示\n\n测试听写文字');
    assert.equal(await h.manager.stopVoice(), '');
    assert.equal(h.manager.getVoiceState().state, 'idle');
  } finally { await h.cleanup(); }
});

test('a rejected turn retains the transcript for retry without uploading audio again', async () => {
  const h = await fixture();
  try {
    await h.manager.startVoice(); h.fail(new Error('approval required'));
    await assert.rejects(h.manager.stopVoice(true), /approval required/);
    assert.equal(h.manager.getVoiceState().canRetry, true);
    h.fail(); assert.equal(await h.manager.stopVoice(true), '测试听写文字');
    assert.equal(h.transcriptions(), 1); assert.equal(h.turns.length, 1);
  } finally { await h.cleanup(); }
});

test('manual insertion consumes retained text and permits another recording', async () => {
  const h = await fixture();
  try {
    await h.manager.startVoice(); h.fail(new Error('approval required'));
    await assert.rejects(h.manager.stopVoice(true));
    assert.equal(await h.manager.stopVoice(false), '测试听写文字');
    assert.equal(h.manager.getVoiceState().state, 'idle');
    assert.equal(await h.manager.startVoice(), 'session-a');
    assert.equal(h.turns.length, 0); assert.equal(h.transcriptions(), 1);
  } finally { await h.cleanup(); }
});

test('uncertain delivery blocks repeat turns until the retained record is discarded', async () => {
  const h = await fixture();
  try {
    await h.manager.startVoice(); h.fail(new Error('turn/start timed out'));
    await assert.rejects(h.manager.stopVoice(true), /未确认/);
    assert.equal(h.manager.getVoiceState().canRetry, false);
    h.fail(); await assert.rejects(h.manager.stopVoice(true), /未确认/);
    assert.equal(h.turns.length, 0); assert.equal(h.transcriptions(), 1);
    await h.manager.cancelVoice(); assert.equal(h.manager.getVoiceState().state, 'idle');
  } finally { await h.cleanup(); }
});

test('cancel while checking the account prevents a transcript from being submitted', async () => {
  const h = await fixture();
  try {
    await h.manager.startVoice();
    let unblock!: () => void, started!: () => void;
    const checking = new Promise<void>(done => { started = done; });
    h.backend.request = (async () => { started(); await new Promise<void>(done => { unblock = done; }); return { authMethod: 'ChatGPT', authToken: 'fixture-token' }; }) as never;
    const delivery = h.manager.stopVoice(true);
    const rejected = assert.rejects(delivery);
    await checking;
    const cancel = h.manager.cancelVoice(); unblock();
    await Promise.all([cancel, rejected]);
    assert.equal(h.turns.length, 0); assert.equal(h.manager.getVoiceState().state, 'idle');
  } finally { await h.cleanup(); }
});
