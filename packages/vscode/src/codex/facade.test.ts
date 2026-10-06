import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OpenCode } from '@opencode/client';
import { CodexFacade } from './facade';
import type { CodexBackend } from './backend';
import { projectUserParts } from '../../../ui/src/lib/opencode/projection';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function fakeBackend() {
  const starts: unknown[] = [];
  const eventListeners: Array<(event: { method: string; params?: unknown }) => void> = [];
  const errorListeners: Array<(error: Error) => void> = [];
  return {
    starts,
    emit: (event: { method: string; params?: unknown }) => eventListeners.forEach((listener) => listener(event)),
    emitError: (error: Error) => errorListeners.forEach((listener) => listener(error)),
    capabilities: { userAgent: 'Codex Desktop/0.160.0' },
    onEvent: (listener: (event: { method: string; params?: unknown }) => void) => {
      eventListeners.push(listener);
      return { dispose() {} };
    },
    onError: (listener: (error: Error) => void) => {
      errorListeners.push(listener);
      return { dispose() {} };
    },
    modelList: async () => ({ data: [{ id: 'gpt-6.1-sol', model: 'gpt-6.1-sol', displayName: 'GPT-6.1-Sol', inputModalities: ['text', 'image'], supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] }] }),
    threadList: async () => ({ data: [{ id: 'thread-1', cwd: 'C:/workspace', path: 'C:/Users/test/.codex/rollouts/thread-1.jsonl', preview: 'Existing thread', createdAt: 1_700_000_000, updatedAt: 1_700_000_100, turns: [] }] }),
    threadStart: async (params: unknown) => { starts.push(params); return { thread: { id: 'thread-2', cwd: 'C:/workspace', preview: 'New thread', turns: [] } }; },
    threadRead: async () => ({ thread: { id: 'thread-1', cwd: 'C:/workspace', path: 'C:/Users/test/.codex/rollouts/thread-1.jsonl', preview: 'Existing thread', turns: [] } }),
    threadResume: async (params: unknown) => { starts.push({ resume: params }); return { thread: { id: 'thread-1', cwd: 'C:/workspace', path: 'C:/Users/test/.codex/rollouts/thread-1.jsonl', preview: 'Existing thread', turns: [] } }; },
    threadItemsList: async () => ({ data: undefined }),
    threadDelete: async (params: unknown) => { starts.push({ delete: params }); return {}; },
    threadArchive: async (params: unknown) => { starts.push({ archive: params }); return {}; },
    threadUnarchive: async (params: unknown) => { starts.push({ unarchive: params }); return {}; },
    threadSetName: async (params: unknown) => { starts.push({ name: params }); return {}; },
    threadSettingsUpdate: async (params: unknown) => { starts.push({ settings: params }); return {}; },
    turnStart: async (params: unknown) => { starts.push({ turn: params }); return { turn: { id: 'turn-1' } }; },
  } as unknown as CodexBackend & { starts: unknown[]; emit: (event: { method: string; params?: unknown }) => void; emitError: (error: Error) => void };
}

test('external screenshot/voice turns reuse ownership, busy state, selected settings and user-message rendering', async () => {
  const backend = fakeBackend();
  const facade = new CodexFacade(backend);
  const base = await facade.start();
  const reader = (await fetch(`${base}/api/event`)).body!.getReader();
  await reader.read();
  const directory = await mkdtemp(join(tmpdir(), 'codex-external-input-'));
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV4cAAAAASUVORK5CYII=', 'base64');
  const imagePath = join(directory, 'capture.png');
  await writeFile(imagePath, image);
  try {
    await fetch(`${base}/api/session/thread-1/settings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-6.1-sol', effort: 'high', serviceTier: 'fast' }) });
    await facade.submitExternalInput('thread-1', [{ type: 'text', text: '会话提示\n\n测试听写' }, { type: 'localImage', path: imagePath }], 'sender-message-1');
    const turn = backend.starts.find(entry => typeof entry === 'object' && entry !== null && 'turn' in entry) as { turn: Record<string, unknown> };
    assert.equal(turn.turn.model, 'gpt-6.1-sol'); assert.equal(turn.turn.effort, 'high'); assert.equal(turn.turn.serviceTier, 'fast');
    assert.equal(turn.turn.clientUserMessageId, 'sender-message-1');
    await assert.rejects(facade.submitExternalInput('thread-1', [{ type: 'text', text: 'duplicate' }], 'sender-message-2'), /正在/);
    let wire = '';
    while (!wire.includes('session.inbox.enqueued')) wire += new TextDecoder().decode((await reader.read()).value);
    assert.ok(wire.includes('session.execution.started'));
    const event = wire.split('\n\n').map(frame => frame.split('\n').find(line => line.startsWith('data:'))?.slice(5)).filter(Boolean).map(line => JSON.parse(line!)).find(e => e.type === 'session.inbox.enqueued');
    assert.equal(event.data.inboxID, 'sender-message-1');
    const parts = projectUserParts(event.data.item.payload, { sessionID: 'thread-1', messageID: event.data.inboxID, created: Date.now() });
    assert.deepEqual(parts.map(p => p.type), ['text', 'file']);
    assert.equal(parts[0].type === 'text' && parts[0].text, '会话提示\n\n测试听写');
    assert.equal(parts[1].type === 'file' && parts[1].filename, 'capture.png');
    assert.equal(parts[1].type === 'file' && parts[1].url, 'data:image/png;base64,' + image.toString('base64'));
    backend.emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } });
    await facade.checkExternalTarget('thread-1');
    await fetch(`${base}/api/session/thread-1/archive`, { method: 'POST', body: '{}' });
    backend.threadRead = async () => ({ thread: { id: 'thread-1', status: { type: 'idle' }, turns: [] } }) as never;
    await assert.rejects(facade.checkExternalTarget('thread-1'), /归档/);
  } finally { await reader.cancel(); await facade.stop(); await rm(directory, { recursive: true, force: true }); }
});

test('external turns reject actual ownership and preserve uncertainty on an interrupted turn/start', async () => {
  const backend = fakeBackend();
  backend.threadRead = async () => ({ thread: { id: 'thread-1', canAcceptDirectInput: false, status: { type: 'idle' } } }) as never;
  backend.threadResume = async () => { throw new Error('thread is already being used by another application'); };
  const facade = new CodexFacade(backend);
  try {
    await assert.rejects(facade.submitExternalInput('thread-1', [{ type: 'text', text: 'blocked' }], 'blocked-message'), /another application/);
    assert.equal(backend.starts.some(entry => typeof entry === 'object' && entry !== null && 'turn' in entry), false);
  } finally { await facade.stop(); }
  const interrupted = fakeBackend();
  interrupted.turnStart = async () => { throw new Error('turn/start timed out'); };
  const retry = new CodexFacade(interrupted);
  try { await assert.rejects(retry.submitExternalInput('thread-1', [{ type: 'text', text: 'test' }], 'uncertain-message'), (error: unknown) => (error as { uncertain?: boolean }).uncertain === true); }
  finally { await retry.stop(); }
});

test('Codex events are emitted in the wire format consumed by OpenChamber sync', async () => {
  const backend = fakeBackend();
  const facade = new CodexFacade(backend);
  const baseUrl = await facade.start();
  const response = await fetch(`${baseUrl}/api/event`);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  try {
    await reader.read(); // facade connection comment
    backend.emit({ method: 'thread/started', params: { thread: { id: 'thread-live', cwd: 'C:/workspace', preview: 'Live thread' } } });
    backend.emit({ method: 'thread/status/changed', params: { threadId: 'thread-live', status: { type: 'active' } } });
    backend.emit({ method: 'item/started', params: { threadId: 'thread-live', startedAtMs: 100, item: { id: 'message-live', type: 'agentMessage' } } });
    backend.emit({ method: 'item/agentMessage/delta', params: { threadId: 'thread-live', itemId: 'message-live', delta: 'Codex reply' } });

    let stream = '';
    while (!stream.includes('session.text.delta')) {
      const { value, done } = await reader.read();
      assert.equal(done, false);
      stream += decoder.decode(value, { stream: true });
    }
    const events = stream.split(/\r?\n\r?\n/).flatMap((frame) => {
      const data = frame.split(/\r?\n/).find((line) => line.startsWith('data:'))?.slice(5).trim();
      return data ? [JSON.parse(data) as Record<string, unknown>] : [];
    });
    const created = events.find((event) => event.type === 'session.created');
    const active = events.find((event) => event.type === 'session.execution.started');
    const delta = events.find((event) => event.type === 'session.text.delta');
    assert.equal((created?.data as Record<string, unknown>)?.sessionID, 'thread-live');
    assert.equal((active?.data as Record<string, unknown>)?.sessionID, 'thread-live');
    assert.equal((delta?.data as Record<string, unknown>)?.delta, 'Codex reply');
    assert.equal((delta?.location as Record<string, unknown>)?.directory, 'C:/workspace');
  } finally {
    await reader.cancel();
    await facade.stop();
  }
});

test('Codex facade normalizes thread and empty catalog responses', async () => {
  const backend = fakeBackend();
  const facade = new CodexFacade(backend);
  const baseUrl = await facade.start();
  try {
    const sessions = await fetch(`${baseUrl}/api/session`).then((response) => response.json()) as { data?: Array<Record<string, unknown>> };
    assert.equal(Array.isArray(sessions.data), true);
    assert.equal(sessions.data?.[0]?.location && typeof sessions.data[0].location === 'object', true);
    assert.equal((sessions.data?.[0]?.time as { created?: unknown })?.created, 1_700_000_000_000);

    const agents = await fetch(`${baseUrl}/api/agent`).then((response) => response.json()) as { data?: unknown[] };
    assert.equal(agents.data?.length, 1);

    const created = await fetch(`${baseUrl}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then((response) => response.json()) as Record<string, unknown>;
    assert.equal((created.data as Record<string, unknown>).id, 'thread-2');
    assert.equal(((created.data as Record<string, unknown>).location as { directory?: string }).directory, 'C:/workspace');
    assert.deepEqual(backend.starts[0], { cwd: undefined });

    await fetch(`${baseUrl}/api/session/thread-2/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ parts: [{ type: 'text', text: 'hello' }] }),
    });
    assert.equal(backend.starts.some((entry) => {
      if (typeof entry !== 'object' || entry === null || !('resume' in entry)) return false;
      const resume = (entry as { resume?: { threadId?: unknown } }).resume;
      return resume?.threadId === 'thread-2';
    }), false);

    const messages = await fetch(`${baseUrl}/api/session/thread-1/message`).then((response) => response.json()) as { data?: unknown[] };
    assert.deepEqual(messages.data, []);

    const switchResponse = await fetch(`${baseUrl}/api/session/thread-1/model`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: { providerID: 'codex', id: 'gpt-6.1-sol' } }),
    });
    assert.equal(switchResponse.status, 204);
    assert.deepEqual(backend.starts.at(-1), { settings: { threadId: 'thread-1', model: 'gpt-6.1-sol', effort: null } });
  } finally {
    await facade.stop();
  }
});

test('OpenCode SDK can consume the Codex facade during new-session bootstrap', async () => {
  const backend = fakeBackend();
  const facade = new CodexFacade(backend);
  const baseUrl = await facade.start();
  const client = OpenCode.make({ baseUrl });
  try {
    const [location, agents, providers, models, sessions, active] = await Promise.all([
      client.location.get(),
      client.agent.list(),
      client.provider.list(),
      client.model.list(),
      client.session.list({ directory: 'C:/workspace' }),
      client.session.active(),
    ]);
    assert.equal(typeof location.directory, 'string');
    assert.equal(agents.data.length, 1);
    assert.equal(providers.data.length, 1);
    assert.equal(models.data.length, 1);
    assert.deepEqual(models.data[0]?.variants, [
      { id: 'low', settings: { reasoningEffort: 'low' } },
      { id: 'high', settings: { reasoningEffort: 'high' } },
      { id: 'fast', settings: { serviceTier: 'fast' } },
    ]);
    assert.equal(sessions.data.length, 1);
    assert.equal(Object.keys(active).length, 0);
    const config = await client.config.get();
    assert.deepEqual(config, []);
    const created = await client.session.create({ location: { directory: 'C:/workspace' }, model: { providerID: 'codex', id: 'gpt-6.1-sol' } });
    assert.equal(created.id, 'thread-2');
    assert.equal(created.time.created > 0, true);
    assert.deepEqual(backend.starts[0], { cwd: 'C:/workspace', model: 'gpt-6.1-sol' });
  } finally {
    await facade.stop();
  }
});

test('Codex reasoning variants are sent as app-server effort values', async () => {
  const backend = fakeBackend();
  const facade = new CodexFacade(backend);
  const baseUrl = await facade.start();
  try {
    const switchResponse = await fetch(`${baseUrl}/api/session/thread-1/model`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: { providerID: 'codex', id: 'gpt-6.1-sol', variant: 'high' } }),
    });
    assert.equal(switchResponse.status, 204);
    assert.deepEqual(backend.starts.at(-1), {
      settings: { threadId: 'thread-1', model: 'gpt-6.1-sol', effort: 'high' },
    });

    const promptResponse = await fetch(`${baseUrl}/api/session/thread-1/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        parts: [{ type: 'text', text: 'Continue' }],
        model: { providerID: 'codex', id: 'gpt-6.1-sol', variant: 'xhigh' },
      }),
    });
    assert.equal(promptResponse.status, 200);
    assert.deepEqual(backend.starts.at(-1), {
      turn: {
        threadId: 'thread-1',
        input: [{ type: 'text', text: 'Continue', text_elements: [] }],
        model: 'gpt-6.1-sol',
        effort: 'xhigh',
      },
    });

    const clearResponse = await fetch(`${baseUrl}/api/session/thread-1/model`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: { providerID: 'codex', id: 'gpt-6.1-sol' } }),
    });
    assert.equal(clearResponse.status, 204);
    assert.deepEqual(backend.starts.at(-1), {
      settings: { threadId: 'thread-1', model: 'gpt-6.1-sol', effort: null },
    });
  } finally {
    await facade.stop();
  }
});

test('Codex permission settings use the official structured sandbox policy', async () => {
  const backend = fakeBackend();
  const facade = new CodexFacade(backend);
  const baseUrl = await facade.start();
  try {
    const response = await fetch(`${baseUrl}/api/session/thread-1/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        approvalPolicy: 'on-request',
        sandboxPolicy: {
          type: 'workspaceWrite',
          writableRoots: ['C:/workspace'],
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
        permissions: null,
      }),
    });
    assert.equal(response.status, 204);
    assert.deepEqual(backend.starts.at(-1), {
      settings: {
        threadId: 'thread-1',
        approvalPolicy: 'on-request',
        sandboxPolicy: {
          type: 'workspaceWrite',
          writableRoots: ['C:/workspace'],
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
        permissions: null,
      },
    });
  } finally {
    await facade.stop();
  }
});

test('Codex speed variants are sent as service tiers', async () => {
  const backend = fakeBackend();
  const facade = new CodexFacade(backend);
  const baseUrl = await facade.start();
  try {
    const switchResponse = await fetch(`${baseUrl}/api/session/thread-1/model`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: { providerID: 'codex', id: 'gpt-6.1-sol', variant: 'fast' } }),
    });
    assert.equal(switchResponse.status, 204);
    assert.deepEqual(backend.starts.at(-1), {
      settings: { threadId: 'thread-1', model: 'gpt-6.1-sol', effort: null, serviceTier: 'fast' },
    });

    const promptResponse = await fetch(`${baseUrl}/api/session/thread-1/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        parts: [{ type: 'text', text: 'Use the fast tier' }],
        model: { providerID: 'codex', id: 'gpt-6.1-sol', variant: 'priority' },
      }),
    });
    assert.equal(promptResponse.status, 200);
    assert.deepEqual(backend.starts.at(-1), {
      turn: {
        threadId: 'thread-1',
        input: [{ type: 'text', text: 'Use the fast tier', text_elements: [] }],
        model: 'gpt-6.1-sol',
        effort: null,
        serviceTier: 'priority',
      },
    });
  } finally {
    await facade.stop();
  }
});

test('Codex facade maps session lifecycle operations to thread methods', async () => {
  const backend = fakeBackend();
  const facade = new CodexFacade(backend);
  const baseUrl = await facade.start();
  try {
    const deleted = await fetch(`${baseUrl}/api/session/thread-1`, { method: 'DELETE' });
    assert.equal(deleted.status, 204);
    await fetch(`${baseUrl}/api/openchamber/sessions/archive`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: ['thread-1'], archivedAt: 123 }),
    });
    await fetch(`${baseUrl}/api/openchamber/sessions/unarchive`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: ['thread-1'] }),
    });
    assert.deepEqual(backend.starts.filter((entry) => typeof entry === 'object' && entry !== null && ('delete' in entry || 'archive' in entry || 'unarchive' in entry)), [
      { delete: { threadId: 'thread-1' } },
      { archive: { threadId: 'thread-1' } },
      { unarchive: { threadId: 'thread-1' } },
    ]);
  } finally {
    await facade.stop();
  }
});

test('Codex resumes persisted sessions with the dynamic rollout path and cwd', async () => {
  const backend = fakeBackend();
  const facade = new CodexFacade(backend);
  const baseUrl = await facade.start();
  try {
    const list = await fetch(`${baseUrl}/api/session`).then((response) => response.json()) as { data?: unknown[] };
    assert.equal(list.data?.length, 1);
    const response = await fetch(`${baseUrl}/api/session/thread-1/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ parts: [{ type: 'text', text: 'Continue this session' }] }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(backend.starts.find((entry) => typeof entry === 'object' && entry !== null && 'resume' in entry), {
      resume: {
        threadId: 'thread-1',
        cwd: 'C:/workspace',
        path: 'C:/Users/test/.codex/rollouts/thread-1.jsonl',
      },
    });
  } finally {
    await facade.stop();
  }
});

test('Codex ownership errors publish explicit read-only metadata', async () => {
  const backend = fakeBackend();
  backend.threadResume = async () => { throw new Error('thread is already being used by another application'); };
  const facade = new CodexFacade(backend);
  const baseUrl = await facade.start();
  const response = await fetch(`${baseUrl}/api/event`);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  try {
    await reader.read();
    const prompt = fetch(`${baseUrl}/api/session/thread-1/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ parts: [{ type: 'text', text: 'continue' }] }),
    });
    let stream = '';
    while (!stream.includes('session.metadata.updated')) {
      const { value, done } = await reader.read();
      assert.equal(done, false);
      stream += decoder.decode(value, { stream: true });
    }
    const frame = stream.split(/\r?\n\r?\n/).find((chunk) => chunk.includes('session.metadata.updated')) || '';
    const data = frame.split(/\r?\n/).find((line) => line.startsWith('data:'))?.slice(5).trim();
    const event = JSON.parse(data || '{}') as { data?: { metadata?: Record<string, unknown> } };
    assert.equal((event.data?.metadata as Record<string, unknown>)?.codexReadOnly, true);
    assert.equal((await prompt).status, 409);
  } finally {
    await reader.cancel();
    await facade.stop();
  }
});

test('Codex session reads probe ownership before rendering an unloaded thread', async () => {
  const backend = fakeBackend();
  backend.threadResume = async () => { throw new Error('thread is already being used by another application'); };
  const facade = new CodexFacade(backend);
  const baseUrl = await facade.start();
  const response = await fetch(`${baseUrl}/api/event`);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  try {
    await reader.read();
    const session = await fetch(`${baseUrl}/api/session/thread-1`).then((result) => result.json()) as {
      data?: { metadata?: Record<string, unknown> };
    };
    assert.equal(session.data?.metadata?.codexReadOnly, true);
    let stream = '';
    while (!stream.includes('session.metadata.updated')) {
      const { value, done } = await reader.read();
      assert.equal(done, false);
      stream += decoder.decode(value, { stream: true });
    }
    assert.match(stream, /session\.metadata\.updated/);
  } finally {
    await reader.cancel();
    await facade.stop();
  }
});

test('Codex session reads recheck ownership after an earlier resume', async () => {
  const backend = fakeBackend();
  let resumeCount = 0;
  backend.threadResume = async () => {
    resumeCount += 1;
    if (resumeCount > 1) throw new Error('thread is already being used by another application');
    return { thread: { id: 'thread-1', cwd: 'C:/workspace', path: 'C:/Users/test/.codex/rollouts/thread-1.jsonl', preview: 'Existing thread', turns: [] } };
  };
  const facade = new CodexFacade(backend);
  const baseUrl = await facade.start();
  const response = await fetch(`${baseUrl}/api/event`);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  try {
    await reader.read();
    await fetch(`${baseUrl}/api/session/thread-1`);
    const session = await fetch(`${baseUrl}/api/session/thread-1`).then((result) => result.json()) as {
      data?: { metadata?: Record<string, unknown> };
    };
    assert.equal(resumeCount, 2);
    assert.equal(session.data?.metadata?.codexReadOnly, true);
    let stream = '';
    while (!stream.includes('session.metadata.updated')) {
      const { value, done } = await reader.read();
      assert.equal(done, false);
      stream += decoder.decode(value, { stream: true });
    }
    assert.match(stream, /session\.metadata\.updated/);
  } finally {
    await reader.cancel();
    await facade.stop();
  }
});
