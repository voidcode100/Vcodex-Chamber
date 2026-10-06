import * as http from 'node:http';
import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import * as os from 'node:os';
import { join } from 'node:path';
import { URL } from 'node:url';
import type { CodexBackend } from './backend';
import type { PromptFileAttachment, SessionInboxUserPayload } from '@opencode/client';
import { isJsonRecord } from './protocol';

type JsonResponse = { status: number; body: unknown; headers?: Record<string, string> };

const json = (status: number, body: unknown): JsonResponse => ({ status, body });
const noContent = (): JsonResponse => ({ status: 204, body: null });

// Codex's thread/list defaults to interactive sources only. That hides older
// CLI and app-server rollouts, which are still valid sessions for OpenChamber.
const ALL_CODEX_THREAD_SOURCES = ['cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview', 'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown'];

function readBody(request: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function threadIdFrom(value: unknown): string | undefined {
  if (!isJsonRecord(value)) return undefined;
  const thread = isJsonRecord(value.thread) ? value.thread : value;
  const id = thread.id;
  return typeof id === 'string' ? id : undefined;
}

function textFromPrompt(body: unknown): string {
  if (!isJsonRecord(body)) return '';
  if (typeof body.text === 'string') return body.text;
  const parts = Array.isArray(body.parts) ? body.parts : [];
  return parts.map((part) => {
    if (!isJsonRecord(part)) return '';
    if (typeof part.text === 'string') return part.text;
    if (typeof part.content === 'string') return part.content;
    if (part.type === 'file' && typeof part.url === 'string') return `\n[附件] ${part.url}`;
    return '';
  }).filter(Boolean).join('\n');
}

function localPathFromUri(value: string): string {
  try {
    if (/^file:/i.test(value)) {
      const parsed = new URL(value);
      const decoded = decodeURIComponent(parsed.pathname);
      return /^[A-Za-z]:\//.test(decoded.slice(1)) ? decoded.slice(1) : decoded;
    }
  } catch { /* fall through to the compatibility form below */ }
  return value.replace(/^file:\/\//i, '');
}

/** Find a persisted Codex rollout when app-server cannot list/read a locked thread. */
async function discoverLocalRollout(threadId: string): Promise<{ path: string; metadata: Record<string, unknown> } | null> {
  const root = join(os.homedir(), '.codex', 'sessions');
  const visit = async (directory: string, depth: number): Promise<string | null> => {
    if (depth > 4) return null;
    let entries: Array<import('node:fs').Dirent>;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch { return null; }
    for (const entry of entries) {
      const candidate = join(directory, entry.name);
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        if (entry.name.includes(threadId)) return candidate;
        // Some Codex versions use a timestamp-only rollout filename. Inspect
        // only a small prefix so a deep-link can still recover that history.
        try {
          const handle = await fs.open(candidate, 'r');
          const buffer = Buffer.allocUnsafe(8192);
          const read = await handle.read(buffer, 0, buffer.length, 0);
          await handle.close();
          if (buffer.subarray(0, read.bytesRead).toString('utf8').includes(threadId)) return candidate;
        } catch { /* ignore files that disappear during the scan */ }
      }
      if (entry.isDirectory()) {
        const found = await visit(candidate, depth + 1);
        if (found) return found;
      }
    }
    return null;
  };
  const path = await visit(root, 0);
  if (!path) return null;
  const metadata: Record<string, unknown> = { id: threadId, path };
  try {
    const text = await fs.readFile(path, 'utf8');
    for (const line of text.split(/\r?\n/).slice(0, 24)) {
      let record: unknown;
      try { record = JSON.parse(line); } catch { continue; }
      const value = asRecord(record);
      const payload = value && asRecord(value.payload);
      if (value?.type === 'session_meta' && payload) {
        for (const key of ['cwd', 'createdAt', 'updatedAt', 'preview', 'model', 'reasoningEffort', 'serviceTier']) {
          if (payload[key] !== undefined) metadata[key] = payload[key];
        }
        if (metadata.createdAt === undefined && typeof value.timestamp === 'string') metadata.createdAt = value.timestamp;
        if (metadata.updatedAt === undefined && typeof value.timestamp === 'string') metadata.updatedAt = value.timestamp;
        break;
      }
    }
  } catch { /* The history reader will report an empty read if the file disappears. */ }
  return { path, metadata };
}

function inputFromPrompt(body: unknown): Array<Record<string, unknown>> {
  if (!isJsonRecord(body)) return [];
  const input: Array<Record<string, unknown>> = [];
  const text = textFromPrompt(body);
  if (text) input.push({ type: 'text', text, text_elements: [] });
  const files = Array.isArray(body.files) ? body.files : [];
  for (const candidate of files) {
    if (!isJsonRecord(candidate)) continue;
    const url = typeof candidate.url === 'string' ? candidate.url.trim() : typeof candidate.uri === 'string' ? candidate.uri.trim() : '';
    if (!url) continue;
    if (/^(?:https?:|data:|blob:)/i.test(url)) input.push({ type: 'image', url });
    else input.push({ type: 'localImage', path: localPathFromUri(url) });
  }
  // Preserve the older facade request shape used by capture attachments.
  if (input.length === 0) {
    const parts = Array.isArray(body.parts) ? body.parts : [];
    for (const part of parts) {
      if (!isJsonRecord(part) || part.type !== 'file' || typeof part.url !== 'string') continue;
      input.push({ type: 'localImage', path: localPathFromUri(part.url) });
    }
  }
  return input;
}

type ModelSelection = { id?: string; effort?: string | null; serviceTier?: string | null; hasEffort: boolean };
const CODEX_SERVICE_TIER_VARIANTS = new Set(['fast', 'priority', 'flex']);
const DEFAULT_CODEX_SERVICE_TIER_VARIANTS = ['fast'];

/**
 * OpenChamber still calls the Codex reasoning control a `variant`. Keep that
 * compatibility at the HTTP boundary and translate it to the official
 * app-server field (`effort`) before it reaches Codex.
 */
function modelSelection(value: unknown): ModelSelection {
  if (typeof value === 'string') return { id: value, effort: undefined, hasEffort: false };
  if (!isJsonRecord(value)) return { hasEffort: false };
  const id = typeof value.modelID === 'string'
    ? value.modelID
    : (typeof value.id === 'string' ? value.id : undefined);
  const rawVariant = value.variant;
  const isServiceTier = typeof rawVariant === 'string' && CODEX_SERVICE_TIER_VARIANTS.has(rawVariant);
  const hasEffort = Object.prototype.hasOwnProperty.call(value, 'variant') && !isServiceTier;
  const serviceTier = isServiceTier ? rawVariant : undefined;
  const effort = typeof rawVariant === 'string' && rawVariant.trim()
    ? rawVariant.trim()
    : (rawVariant === null ? null : undefined);
  return { id, effort, serviceTier, hasEffort };
}

function addEffort(params: Record<string, unknown>, selection: ModelSelection): void {
  if (!selection.hasEffort) return;
  // `null` is the app-server instruction to clear a previously selected
  // effort. An omitted value preserves the current setting.
  params.effort = selection.effort ?? null;
}

function addServiceTier(params: Record<string, unknown>, selection: ModelSelection): void {
  if (selection.serviceTier !== undefined) params.serviceTier = selection.serviceTier;
}

function codexModelList(result: unknown): Array<Record<string, unknown>> {
  const data = isJsonRecord(result) && Array.isArray(result.data) ? result.data : [];
  return data.flatMap((entry) => {
    if (!isJsonRecord(entry) || typeof entry.id !== 'string') return [];
    const modelId = typeof entry.model === 'string' && entry.model ? entry.model : entry.id;
    const efforts = Array.isArray(entry.supportedReasoningEfforts)
      ? entry.supportedReasoningEfforts.flatMap((effort) => {
        const value = typeof effort === 'string'
          ? effort
          : (isJsonRecord(effort) && typeof effort.reasoningEffort === 'string' ? effort.reasoningEffort : undefined);
        return value ? [{ id: value, settings: { reasoningEffort: value } }] : [];
      })
      : [];
    const advertisedTiers = Array.isArray(entry.serviceTiers)
      ? entry.serviceTiers.flatMap((tier) => {
        const id = typeof tier === 'string' ? tier : isJsonRecord(tier) && typeof tier.id === 'string' ? tier.id : undefined;
        return id && id !== 'default' ? [{ id, settings: { serviceTier: id } }] : [];
      })
      : (Array.isArray(entry.additionalSpeedTiers) ? entry.additionalSpeedTiers.flatMap((tier) => typeof tier === 'string' && tier !== 'default' ? [{ id: tier, settings: { serviceTier: tier } }] : []) : DEFAULT_CODEX_SERVICE_TIER_VARIANTS.map((id) => ({ id, settings: { serviceTier: id } })));
    const tiers = advertisedTiers.length > 0 ? advertisedTiers : DEFAULT_CODEX_SERVICE_TIER_VARIANTS.map((id) => ({ id, settings: { serviceTier: id } }));
    return [{
      id: entry.id,
      modelID: modelId,
      providerID: 'codex',
      name: typeof entry.displayName === 'string' && entry.displayName ? entry.displayName : modelId,
      capabilities: {
        tools: true,
        input: Array.isArray(entry.inputModalities) ? entry.inputModalities : ['text'],
        output: ['text'],
      },
      variants: [...efforts, ...tiers.filter((tier) => !efforts.some((effort) => effort.id === tier.id))],
      time: { released: 0 },
      cost: [],
      status: entry.hidden === true ? 'deprecated' : 'active',
      enabled: entry.hidden !== true,
      limit: { context: 400000, output: 100000 },
    }];
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isJsonRecord(value) ? value : null;
}

function timestampMs(value: unknown, fallback: number): number {
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return value < 10_000_000_000 ? Math.round(value * 1000) : Math.round(value);
}

/** Convert a Codex thread into the SessionInfo shape expected by OpenChamber. */
function codexSessionInfo(value: unknown, archived = false): Record<string, unknown> | null {
  const raw = asRecord(value);
  if (!raw || typeof raw.id !== 'string') return null;
  const now = Date.now();
  const cwd = typeof raw.cwd === 'string' && raw.cwd ? raw.cwd : process.cwd();
  const created = timestampMs(raw.createdAt, now);
  const updated = timestampMs(raw.updatedAt, created);
  const model = typeof raw.model === 'string' && raw.model
    ? {
      providerID: 'codex',
      id: raw.model,
      ...(typeof raw.reasoningEffort === 'string' && raw.reasoningEffort
        ? { variant: raw.reasoningEffort }
        : (typeof raw.serviceTier === 'string' && raw.serviceTier ? { variant: raw.serviceTier } : {})),
    }
    : undefined;
  const turns = Array.isArray(raw.turns) ? raw.turns : [];
  const directInput = raw.canAcceptDirectInput;
  return {
    id: raw.id,
    parentID: typeof raw.parentThreadId === 'string' ? raw.parentThreadId : undefined,
    projectID: typeof raw.projectId === 'string' && raw.projectId ? raw.projectId : cwd,
    agent: typeof raw.agentNickname === 'string' ? raw.agentNickname : 'codex',
    model,
    title: typeof raw.name === 'string' && raw.name ? raw.name : (typeof raw.preview === 'string' ? raw.preview.slice(0, 120) : 'Codex session'),
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created, updated, ...(archived ? { archived: updated } : {}) },
    location: { directory: cwd },
    metadata: {
      codexStatus: raw.status ?? null,
      codexPath: raw.path ?? null,
      codexServiceTier: raw.serviceTier ?? null,
      turnCount: turns.length,
      codexArchived: archived,
      ...(directInput === false ? { codexReadOnly: true, codexOwnershipError: 'Codex 会话正在其他进程中使用' } : {}),
    },
    permissions: [],
  };
}

function codexSessionList(result: unknown, archived = false): Array<Record<string, unknown>> {
  const record = asRecord(result);
  const data = record && Array.isArray(record.data) ? record.data : Array.isArray(result) ? result : [];
  return data.flatMap((entry) => {
    const session = codexSessionInfo(entry, archived);
    return session ? [session] : [];
  });
}

function codexSessionFromStart(result: unknown): Record<string, unknown> | null {
  const record = asRecord(result);
  const thread = asRecord(record?.thread ?? result);
  if (!thread) return null;
  const serviceTier = record && typeof record.serviceTier === 'string' ? record.serviceTier : undefined;
  return codexSessionInfo(serviceTier ? { ...thread, serviceTier } : thread);
}

function jsonErrorBody(value: unknown): string {
  try {
    const encoded = JSON.stringify(value);
    return encoded && encoded !== '{}' ? encoded : String(value);
  } catch {
    return String(value);
  }
}

/** Preserve the app-server error object for the UI's expandable error card. */
function codexErrorDetails(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    return { type: 'CodexError', message: value, response: { body: value } };
  }
  const raw = asRecord(value) ?? {};
  const message = [raw.message, raw.additionalDetails, raw.detail, raw.reason]
    .find((candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0)
    ?.trim() || jsonErrorBody(value);
  const original = jsonErrorBody(value);
  const ownership = /already (?:being )?used|in use|another (?:application|client)|locked|no rollout found/i.test(message)
    ? 'thread-owned-by-another-client'
    : undefined;
  return {
    type: typeof raw.type === 'string' && raw.type.trim() ? raw.type : 'CodexError',
    message,
    // Keep the exact app-server object available to the expandable UI card;
    // the short message above is only the headline.
    response: { body: original },
    ...(ownership ? { code: ownership } : {}),
  };
}

type CodexFileChange = { file: string; diff: string };

/** Codex has used both `diff` and `patch` for file changes across releases. */
function fileChangesFromItem(item: Record<string, unknown>, fallback: CodexFileChange[] = []): CodexFileChange[] {
  const source = Array.isArray(item.changes)
    ? item.changes
    : isJsonRecord(item.changes)
      ? Object.entries(item.changes).map(([path, value]) => ({ path, ...(isJsonRecord(value) ? value : { diff: value }) }))
      : [];
  const changes = source.flatMap((change): CodexFileChange[] => {
    const value = asRecord(change);
    if (!value) return [];
    const file = typeof value.path === 'string' ? value.path
      : typeof value.file === 'string' ? value.file
        : typeof value.filename === 'string' ? value.filename : undefined;
    if (!file) return [];
    const diff = typeof value.diff === 'string' ? value.diff
      : typeof value.patch === 'string' ? value.patch
        : typeof value.content === 'string' ? value.content : '';
    return [{ file, diff }];
  });
  if (changes.length > 0) return changes;
  const file = typeof item.path === 'string' ? item.path : typeof item.file === 'string' ? item.file : undefined;
  const patch = typeof item.diff === 'string' ? item.diff : typeof item.patch === 'string' ? item.patch : undefined;
  return file && patch !== undefined ? [{ file, diff: patch }] : fallback;
}

function fileChangeStatus(item: Record<string, unknown>): string {
  return typeof item.status === 'string' ? item.status.toLowerCase() : '';
}

function threadItemMessage(entry: unknown, threadId: string, model?: string, messageIdAlias?: (id: string) => string): Record<string, unknown> | null {
  const record = asRecord(entry);
  const item = record && (asRecord(record.item) ?? (typeof record.type === 'string' ? record : undefined));
  if (!item || typeof item.id !== 'string' || typeof item.type !== 'string') return null;
  const started = timestampMs(record.startedAtMs, Date.now());
  const completed = record.completedAtMs == null ? undefined : timestampMs(record.completedAtMs, started);
  const base = { sessionID: threadId };
  const messageId = messageIdAlias?.(item.id) ?? item.id;
  if (item.type === 'userMessage') {
    const parts: Array<Record<string, unknown>> = Array.isArray(item.content) ? item.content.flatMap((content, index): Array<Record<string, unknown>> => {
      const input = asRecord(content);
      if (!input) return [];
      if (input.type === 'text' && typeof input.text === 'string') return [{ id: `${messageId}:text:${index}`, ...base, messageID: messageId, type: 'text', text: input.text }];
      if (input.type === 'localImage' && typeof input.path === 'string') return [{ id: `${messageId}:file:${index}`, ...base, messageID: messageId, type: 'file', mime: 'image/*', filename: input.path.split(/[\\/]/).pop(), url: input.path }];
      if (input.type === 'image' && typeof input.url === 'string') return [{ id: `${messageId}:file:${index}`, ...base, messageID: messageId, type: 'file', mime: 'image/*', url: input.url }];
      return [];
    }) : [];
    return { info: { id: messageId, ...base, role: 'user', time: { created: started } }, parts };
  }
  if (item.type === 'agentMessage') {
    const text = typeof item.text === 'string' ? item.text : '';
    return {
      info: { id: messageId, ...base, role: 'assistant', time: { created: started, ...(completed ? { completed } : {}) }, agent: 'codex', providerID: 'codex', modelID: model || 'codex', finish: completed ? 'stop' : undefined },
      parts: [{ id: `${messageId}:text:0`, ...base, messageID: messageId, type: 'text', text, time: { start: started, ...(completed ? { end: completed } : {}) } }],
    };
  }
  if (item.type === 'reasoning') {
    const text = [...(Array.isArray(item.summary) ? item.summary : []), ...(Array.isArray(item.content) ? item.content : [])].filter((part): part is string => typeof part === 'string').join('\n');
    return {
      info: { id: messageId, ...base, role: 'assistant', time: { created: started, ...(completed ? { completed } : {}) }, agent: 'codex', providerID: 'codex', modelID: model || 'codex', finish: completed ? 'stop' : undefined },
      parts: [{ id: `${messageId}:reasoning:0`, ...base, messageID: messageId, type: 'reasoning', text, time: { start: started, ...(completed ? { end: completed } : {}) } }],
    };
  }
  if (item.type === 'plan') {
    const text = typeof item.text === 'string' ? item.text : '';
    return { info: { id: messageId, ...base, role: 'assistant', time: { created: started, ...(completed ? { completed } : {}) }, agent: 'codex', providerID: 'codex', modelID: model || 'codex', finish: completed ? 'stop' : undefined }, parts: [{ id: `${messageId}:text:0`, ...base, messageID: messageId, type: 'text', text }] };
  }
  if (item.type === 'commandExecution') {
    const command = typeof item.command === 'string' ? item.command : '';
    const cwd = typeof item.cwd === 'string' ? item.cwd : undefined;
    const output = typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : '';
    const status = typeof item.status === 'string' ? item.status.toLowerCase() : '';
    const succeeded = status === 'completed' || status === 'succeeded' || status === 'success' || status === 'exited' && item.exitCode === 0;
    const input = { command, ...(cwd ? { cwd } : {}) };
    const metadata = { ...(cwd ? { cwd } : {}), ...(typeof item.exitCode === 'number' ? { exit: item.exitCode } : {}) };
    const state = succeeded
      ? { status: 'completed', input, output, metadata, time: { start: started, end: completed ?? started } }
      : { status: 'error', input, output: output || undefined, error: status || 'Command did not complete', metadata, time: { start: started, end: completed ?? started } };
    return {
      info: { id: messageId, ...base, role: 'assistant', time: { created: started, ...(completed ? { completed } : {}) }, agent: 'codex', providerID: 'codex', modelID: model || 'codex', finish: completed ? 'stop' : undefined },
      parts: [{ id: `${messageId}:tool:0`, ...base, messageID: messageId, type: 'tool', callID: messageId, tool: 'shell', executed: true, state }],
    };
  }
  if (item.type === 'fileChange') {
    const files = fileChangesFromItem(item);
    const status = fileChangeStatus(item);
    const succeeded = !status || !/(fail|reject|error)/i.test(status);
    const state = succeeded
      ? { status: 'completed', input: { changes: files }, output: files.map((file) => file.diff ? `${file.file}\n${file.diff}` : file.file).join('\n'), metadata: { files }, time: { start: started, end: completed ?? started } }
      : { status: 'error', input: { changes: files }, error: status, metadata: { files }, time: { start: started, end: completed ?? started } };
    return {
      info: { id: messageId, ...base, role: 'assistant', time: { created: started, ...(completed ? { completed } : {}) }, agent: 'codex', providerID: 'codex', modelID: model || 'codex', finish: completed ? 'stop' : undefined },
      parts: [{ id: `${messageId}:tool:0`, ...base, messageID: messageId, type: 'tool', callID: messageId, tool: 'patch', executed: true, state }],
    };
  }
  // Tool items still need a stable renderable shape after a resume. Preserve
  // their complete payload in a text part instead of dropping the history.
  return { info: { id: messageId, ...base, role: 'assistant', time: { created: started, ...(completed ? { completed } : {}) }, agent: 'codex', providerID: 'codex', modelID: model || 'codex', finish: completed ? 'stop' : undefined }, parts: [{ id: `${messageId}:text:0`, ...base, messageID: messageId, type: 'text', text: `[Codex ${item.type}]\n${jsonErrorBody(item)}` }] };
}

function itemsFromThreadRead(result: unknown): Array<Record<string, unknown>> {
  const thread = asRecord(asRecord(result)?.thread);
  const turns = thread && Array.isArray(thread.turns) ? thread.turns : [];
  return itemsFromTurns(turns);
}

function itemsFromTurns(turns: unknown[]): Array<Record<string, unknown>> {
  return turns.flatMap((turn) => {
    const value = asRecord(turn);
    const items = value && Array.isArray(value.items) ? value.items : [];
    return items.flatMap((item) => {
      if (!isJsonRecord(item)) return [];
      return [{
        item,
        ...(typeof value?.startedAt === 'number' ? { startedAtMs: value.startedAt } : {}),
        ...(typeof value?.completedAt === 'number' ? { completedAtMs: value.completedAt } : {}),
      }];
    });
  });
}

function textFromRolloutContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!isJsonRecord(value)) return '';
  if (typeof value.text === 'string') return value.text;
  if (typeof value.content === 'string') return value.content;
  return '';
}

/** Normalize the persisted JSONL response-item format to app-server items. */
function rolloutItem(value: unknown): Record<string, unknown> | null {
  const item = asRecord(value);
  if (!item) return null;
  const rawType = typeof item.type === 'string' ? item.type : '';
  const normalizedType = rawType.toLowerCase();
  const id = typeof item.id === 'string' ? item.id : undefined;
  if (!id) return null;
  if (rawType === 'userMessage' || rawType === 'agentMessage' || rawType === 'reasoning' || rawType === 'plan') return item;
  if (rawType === 'UserMessage' || (rawType === 'message' && item.role === 'user')) {
    const content = Array.isArray(item.content) ? item.content.flatMap((part) => {
      const text = textFromRolloutContent(part);
      return text ? [{ type: 'text', text, text_elements: [] }] : [];
    }) : [];
    return { type: 'userMessage', id, content };
  }
  if (rawType === 'AgentMessage' || (rawType === 'message' && item.role === 'assistant')) {
    const text = Array.isArray(item.content) ? item.content.map(textFromRolloutContent).filter(Boolean).join('') : textFromRolloutContent(item);
    return { type: 'agentMessage', id, text };
  }
  if (normalizedType === 'reasoning') {
    const summary = Array.isArray(item.summary) ? item.summary.filter((part): part is string => typeof part === 'string') : [];
    const content = Array.isArray(item.content) ? item.content.map(textFromRolloutContent).filter(Boolean) : [];
    return { type: 'reasoning', id, summary, content };
  }
  if (normalizedType === 'filechange') return { ...item, type: 'fileChange' };
  if (normalizedType === 'commandexecution') return { ...item, type: 'commandExecution' };
  return item;
}

function itemsFromRolloutText(text: string): Array<Record<string, unknown>> {
  const entries: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let record: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isJsonRecord(parsed)) continue;
      record = parsed;
    } catch {
      continue;
    }
    const payload = asRecord(record.payload);
    const candidate = record.type === 'response_item'
      ? payload
      : payload?.type === 'item_completed' ? payload.item : null;
    const item = rolloutItem(candidate);
    if (!item) continue;
    const itemId = typeof item.id === 'string' ? item.id : '';
    if (itemId && seen.has(itemId)) continue;
    if (itemId) seen.add(itemId);
    const timestamp = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : Date.now();
    const started = typeof payload?.started_at_ms === 'number' ? payload.started_at_ms : timestamp;
    const completed = typeof payload?.completed_at_ms === 'number' ? payload.completed_at_ms : timestamp;
    entries.push({ item, startedAtMs: started, completedAtMs: completed });
  }
  return entries;
}

/** Small OpenCode-shaped HTTP facade so OpenChamber's existing UI can remain upstream-compatible. */
export class CodexFacade {
  private server: http.Server | undefined;
  private readonly clients = new Set<http.ServerResponse>();
  private readonly eventDisposable: { dispose(): void };
  private readonly errorDisposable: { dispose(): void };
  private port = 0;
  private sequence = 0;
  private readonly turns = new Map<string, { messageId: string; text: string; startedAt: number; model?: string; variant?: string }>();
  private readonly threadDirectories = new Map<string, string>();
  /** Persisted rollout paths are required when app-server resumes an unloaded thread. */
  private readonly threadPaths = new Map<string, string>();
  private readonly archivedThreads = new Set<string>();
  private readonly resumedThreads = new Set<string>();
  private readonly threadSettings = new Map<string, Record<string, unknown>>();
  /** Last metadata returned by thread/list or thread/read, used for read-only history fallback. */
  private readonly threadMetadata = new Map<string, Record<string, unknown>>();
  private readonly readOnlyThreads = new Set<string>();
  private readonly ownershipErrors = new Map<string, string>();
  private readonly resumeRequests = new Map<string, Promise<unknown | null>>();
  private readonly activeTurnIds = new Map<string, string>();
  private readonly pendingApprovals = new Map<string | number, { method: string; params?: unknown }>();
  /** Codex assigns user-message UUIDs independently of OpenChamber's optimistic ids. */
  private readonly pendingUserMessages = new Map<string, Array<{ clientMessageId: string; text: string }>>();
  private readonly userMessageAliases = new Map<string, Map<string, string>>();
  /** Errors arrive before the authoritative turn/completed notification on some app-server versions. */
  private readonly pendingTurnErrors = new Map<string, unknown>();
  private readonly inflightTurnSessions = new Set<string>();
  /** Codex tool items are attached to the assistant message for their turn. */
  private readonly toolAssistants = new Map<string, string>();
  private readonly toolOutputs = new Map<string, string>();
  private readonly toolFileChanges = new Map<string, CodexFileChange[]>();
  private readonly finalizedTools = new Set<string>();
  private readonly toolProcesses = new Map<string, string>();
  private readonly toolThreads = new Map<string, string>();

  private aliasMessageID(threadId: string, messageId: string): string {
    return this.userMessageAliases.get(threadId)?.get(messageId) ?? messageId;
  }

  private rememberUserMessage(threadId: string, clientMessageId: string, text: string): void {
    const pending = this.pendingUserMessages.get(threadId) ?? [];
    pending.push({ clientMessageId, text });
    this.pendingUserMessages.set(threadId, pending);
  }

  private matchUserMessage(threadId: string, item: Record<string, unknown>): void {
    const itemId = typeof item.id === 'string' ? item.id : undefined;
    if (!itemId) return;
    const content = Array.isArray(item.content) ? item.content : [];
    const text = content.map((part) => {
      const record = asRecord(part);
      return record && typeof record.text === 'string' ? record.text : '';
    }).join('');
    const pending = this.pendingUserMessages.get(threadId) ?? [];
    const index = pending.findIndex((candidate) => !candidate.text || candidate.text === text);
    if (index < 0) return;
    const [candidate] = pending.splice(index, 1);
    if (pending.length > 0) this.pendingUserMessages.set(threadId, pending);
    else this.pendingUserMessages.delete(threadId);
    const aliases = this.userMessageAliases.get(threadId) ?? new Map<string, string>();
    aliases.set(itemId, candidate.clientMessageId);
    this.userMessageAliases.set(threadId, aliases);
  }

  private reconcileUserMessageAliases(threadId: string, entries: unknown[]): void {
    for (const entry of entries) {
      const entryRecord = asRecord(entry);
      const item = entryRecord && (asRecord(entryRecord.item) ?? (typeof entryRecord.type === 'string' ? entryRecord : undefined));
      if (item && String(item.type).toLowerCase() === 'usermessage') this.matchUserMessage(threadId, item);
    }
  }

  constructor(private readonly backend: CodexBackend, private readonly logger?: (line: string) => void) {
    this.eventDisposable = backend.onEvent((event) => this.broadcast(event));
    this.errorDisposable = backend.onError((error) => {
      const sessions = new Set([...this.inflightTurnSessions, ...this.turns.keys(), ...this.activeTurnIds.keys()]);
      for (const sessionID of sessions) {
        this.broadcastWire('session.execution.failed', { sessionID, error: codexErrorDetails(error) });
      }
      // A transport failure invalidates all in-memory turn state. Keeping an
      // old turn id here would make a later interrupt target a dead request,
      // and retaining the text entry can make the next stream look resumed.
      this.turns.clear();
      this.activeTurnIds.clear();
      this.inflightTurnSessions.clear();
      this.pendingTurnErrors.clear();
      this.toolAssistants.clear();
      this.toolOutputs.clear();
      this.toolFileChanges.clear();
      this.finalizedTools.clear();
      this.toolProcesses.clear();
      this.toolThreads.clear();
      this.log(`TRANSPORT_ERROR ${jsonErrorBody(error)}`);
    });
  }

  async start(): Promise<string> {
    if (this.server) return `http://127.0.0.1:${this.port}`;
    this.server = http.createServer((request, response) => void this.handle(request, response));
    await new Promise<void>((resolve, reject) => {
      const server = this.server!;
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        const address = server.address();
        this.port = typeof address === 'object' && address ? address.port : 0;
        resolve();
      });
    });
    return `http://127.0.0.1:${this.port}`;
  }

  async stop(): Promise<void> {
    for (const client of this.clients) client.end();
    this.clients.clear();
    this.turns.clear();
    this.threadDirectories.clear();
    this.threadPaths.clear();
    this.archivedThreads.clear();
    this.resumedThreads.clear();
    this.threadSettings.clear();
    this.threadMetadata.clear();
    this.readOnlyThreads.clear();
    this.ownershipErrors.clear();
    this.resumeRequests.clear();
    this.activeTurnIds.clear();
    this.pendingApprovals.clear();
    this.pendingTurnErrors.clear();
    this.inflightTurnSessions.clear();
    this.toolAssistants.clear();
    this.toolOutputs.clear();
    this.toolFileChanges.clear();
    this.finalizedTools.clear();
    this.toolProcesses.clear();
    this.toolThreads.clear();
    const server = this.server;
    this.server = undefined;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  dispose(): void {
    this.eventDisposable.dispose();
    this.errorDisposable.dispose();
    void this.stop();
  }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const method = (request.method || 'GET').toUpperCase();
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    this.log(`HTTP ${method} ${url.pathname}${url.search}`);
    // OpenChamber's generated client scopes directory reads through the
    // historical header rather than a query parameter. Preserve that scope
    // at the facade boundary so Codex thread/list is filtered consistently
    // for global and directory-scoped refreshes.
    if (!url.searchParams.has('directory')) {
      const directoryHeader = request.headers['x-opencode-directory'];
      const encodedDirectory = Array.isArray(directoryHeader) ? directoryHeader[0] : directoryHeader;
      if (encodedDirectory) {
        try {
          url.searchParams.set('directory', decodeURIComponent(encodedDirectory));
        } catch {
          url.searchParams.set('directory', encodedDirectory);
        }
      }
    }
    if (url.pathname === '/api/event' && method === 'GET') {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      response.write(': codex facade connected\n\n');
      this.clients.add(response);
      const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 15_000);
      heartbeat.unref();
      response.on('close', () => { clearInterval(heartbeat); this.clients.delete(response); });
      return;
    }
    try {
      const body = method === 'GET' || method === 'HEAD' ? undefined : JSON.parse((await readBody(request)).toString('utf8') || '{}');
      const result = await this.route(method, url, body);
      this.log(`HTTP ${method} ${url.pathname} -> ${result.status}`);
      response.writeHead(result.status, { 'content-type': 'application/json', 'x-capture-codex-backend': 'codex', ...result.headers });
      // Node intentionally suppresses bodies for 204. Passing null here also
      // keeps the response empty for clients which validate the no-content
      // contract strictly.
      response.end(result.status === 204 || result.status === 205 || result.status === 304 ? undefined : JSON.stringify(result.body));
    } catch (error) {
      const details = codexErrorDetails(error);
      // The generated compatibility client only decodes declared error
      // statuses. Returning a 500 makes it discard the body and surface the
      // misleading generic `UnexpectedStatus`; 400 is declared by every
      // session operation and still carries the complete Codex payload.
      response.writeHead(400, { 'content-type': 'application/json', 'x-capture-codex-backend': 'codex' });
      response.end(JSON.stringify({
        _tag: details.type,
        error: details.message,
        message: details.message,
        type: details.type,
        response: details.response,
        backend: 'codex',
        capability: 'codex-facade',
        method: `${method} ${url.pathname}`,
      }));
      this.log(`HTTP ${method} ${url.pathname} -> 400 ${details.message}`);
    }
  }

  private async route(method: string, url: URL, body: unknown): Promise<JsonResponse> {
    const workingDirectory = url.searchParams.get('directory') || process.cwd();
    if (url.pathname === '/api/location' && method === 'GET') {
      return json(200, {
        directory: workingDirectory,
        project: { id: workingDirectory, directory: workingDirectory, canonical: workingDirectory },
      });
    }
    if (url.pathname === '/api/project' && method === 'GET') {
      return json(200, { data: [{ id: workingDirectory, name: workingDirectory.split(/[\\/]/).pop() || 'Workspace', canonical: workingDirectory, vcs: 'git', time: { created: 0, updated: Date.now() }, sandboxes: [] }] });
    }
    if (url.pathname === '/api/fs/home' && method === 'GET') {
      const home = os.homedir();
      return json(200, { home, chatsRoot: home });
    }
    if (url.pathname === '/api/session/status' && method === 'GET') return json(200, { data: this.activeSessionSnapshot() });
    if (url.pathname === '/api/session/active' && method === 'GET') return json(200, { data: this.activeSessionSnapshot() });
    if (url.pathname === '/api/permission' && method === 'GET') return json(200, { data: [] });
    if (url.pathname === '/api/permission/request' && method === 'GET') return json(200, { data: [] });
    if (url.pathname === '/api/form' && method === 'GET') return json(200, { data: [] });
    if (url.pathname === '/api/vcs' && method === 'GET') return json(200, { data: { branch: { current: null, default: null } } });
    if (url.pathname === '/api/info' && method === 'GET') {
      return json(200, { version: this.backend.capabilities.userAgent?.match(/Codex[^/]*\/([^ ]+)/)?.[1] || null });
    }
    if (url.pathname === '/api/health' && method === 'GET') return json(200, { healthy: true });
    if (url.pathname === '/api/model' && method === 'GET') {
      // `model/list` is global in the Codex app-server protocol. Passing the
      // OpenCode-only `cwd` field makes strict newer servers reject the request.
      const result = await this.backend.modelList({ includeHidden: false });
      return json(200, { location: { directory: url.searchParams.get('directory') || undefined }, data: codexModelList(result) });
    }
    if (url.pathname === '/api/model/default' && method === 'GET') {
      const result = await this.backend.modelList({ includeHidden: false });
      const model = codexModelList(result)[0] ?? null;
      return json(200, { location: { directory: url.searchParams.get('directory') || undefined }, data: model });
    }
    if (url.pathname === '/api/codex/permission-profiles' && method === 'GET') {
      return json(200, await this.backend.request('permissionProfile/list', { cwd: workingDirectory }));
    }
    if (url.pathname === '/api/codex/capabilities' && method === 'GET') {
      return json(200, { backend: 'codex', capabilities: this.backend.capabilities });
    }
    if (url.pathname === '/api/codex/review' && method === 'POST') {
      const source = isJsonRecord(body) ? body : {};
      const target = isJsonRecord(source.target) ? source.target : { type: 'uncommittedChanges' };
      return json(200, await this.backend.reviewStart({ threadId: String(source.threadId || ''), target }));
    }
    if (url.pathname === '/api/provider' && method === 'GET') {
      return json(200, {
        location: { directory: url.searchParams.get('directory') || undefined },
        data: [{ id: 'codex', name: 'Codex', activation: 'enabled', package: 'codex', models: {} }],
      });
    }
    if (url.pathname === '/api/agent' && method === 'GET') {
      return json(200, {
        location: { directory: url.searchParams.get('directory') || undefined },
        data: [{
          id: 'codex',
          name: 'Codex',
          mode: 'primary',
          hidden: false,
          description: 'Codex app-server agent',
          request: { settings: {}, headers: {}, body: {} },
          permissions: [],
        }],
      });
    }
    if (url.pathname === '/api/session' && method === 'GET') {
      const cwd = url.searchParams.get('directory') || undefined;
      const cursor = url.searchParams.get('cursor') || undefined;
      const limitValue = Number.parseInt(url.searchParams.get('limit') || '', 10);
      const limit = Number.isFinite(limitValue) && limitValue > 0 ? limitValue : undefined;
      const [activeResult, archivedResult] = await Promise.all([
        this.backend.threadList({ cwd, cursor, limit, archived: false, sourceKinds: ALL_CODEX_THREAD_SOURCES }),
        // Archived threads are merged into the compatibility list only on the
        // first page. Subsequent pages follow the active Codex cursor; sending
        // that cursor to the independent archived query is invalid and can
        // make an otherwise healthy refresh fail.
        this.backend.threadList({ cwd, cursor: undefined, limit, archived: true, sourceKinds: ALL_CODEX_THREAD_SOURCES }).catch((error) => {
          this.log(`thread/list archived unavailable: ${error instanceof Error ? error.message : String(error)}`);
          return null;
        }),
      ]);
      this.rememberThreads(activeResult, false);
      if (archivedResult) this.rememberThreads(archivedResult, true);
      const sessions = [...codexSessionList(activeResult, false), ...(archivedResult ? codexSessionList(archivedResult, true) : [])];
      const unique = new Map<string, Record<string, unknown>>();
      for (const session of sessions) {
        if (typeof session.id !== 'string') continue;
        this.decorateSessionAccess(session.id, session);
        unique.set(session.id, session);
      }
      const list = asRecord(activeResult) ?? {};
      const nextCursor = typeof list.nextCursor === 'string' && list.nextCursor ? list.nextCursor : undefined;
      const previousCursor = typeof list.backwardsCursor === 'string' && list.backwardsCursor ? list.backwardsCursor : undefined;
      // OpenChamber's generated HTTP client is based on the OpenCode v2
      // schema and requires a cursor object even when Codex has no next page.
      // Translate the official Codex cursors at this compatibility boundary.
      return json(200, {
        data: [...unique.values()],
        cursor: { ...(previousCursor ? { previous: previousCursor } : {}), ...(nextCursor ? { next: nextCursor } : {}) },
      });
    }
    if (url.pathname === '/api/session' && method === 'POST') {
      // OpenCode's session.create body is intentionally not forwarded to
      // Codex. It contains UI-only keys such as `location`, while the
      // app-server's thread/start schema is strict and only accepts `cwd`,
      // `model`, approval/sandbox settings, and thread configuration fields.
      const source = isJsonRecord(body) ? body : {};
      const location = isJsonRecord(source.location) ? source.location : {};
      const metadata = isJsonRecord(source.metadata) ? source.metadata : {};
      const permissionChoice = typeof metadata.codexPermissionChoice === 'string' ? metadata.codexPermissionChoice : undefined;
      const selection = modelSelection(source.model);
      const model = selection.id;
      const params: Record<string, unknown> = {
        cwd: typeof location.directory === 'string'
          ? location.directory
          : (url.searchParams.get('directory') || undefined),
      };
      if (model) params.model = model;
      if (typeof source.approvalPolicy === 'string') params.approvalPolicy = source.approvalPolicy;
      if (typeof source.sandbox === 'string') params.sandbox = source.sandbox;
      if (typeof source.permissions === 'string') params.permissions = source.permissions;
      if (permissionChoice && params.approvalPolicy === undefined && params.sandbox === undefined && params.permissions === undefined) {
        if (permissionChoice === 'ask') {
          params.approvalPolicy = 'on-request';
          params.sandbox = 'workspace-write';
        } else if (permissionChoice === 'help') {
          params.approvalPolicy = 'untrusted';
          params.sandbox = 'workspace-write';
        } else if (permissionChoice === 'full') {
          params.approvalPolicy = 'never';
          params.sandbox = 'danger-full-access';
        } else if (permissionChoice.startsWith('profile:')) {
          params.permissions = permissionChoice.slice('profile:'.length);
        }
      }
      addServiceTier(params, selection);
      const result = await this.backend.threadStart(params);
      this.rememberThreads(result);
      const session = codexSessionFromStart(result);
      // `thread/start` has no reasoning-effort field in the current Codex
      // protocol. Apply it immediately after creation when the picker sent
      // one, so a new session starts with the same choice as an existing one.
      const createdThreadId = threadIdFrom(result);
      // `thread/start` creates an already-loaded in-memory thread. It has no
      // rollout path until its first turn, so calling thread/resume here would
      // incorrectly produce "no rollout found" for the first message.
      if (createdThreadId) this.resumedThreads.add(createdThreadId);
      if (createdThreadId && (selection.hasEffort || selection.serviceTier !== undefined)) {
        const settings: Record<string, unknown> = { threadId: createdThreadId };
        addEffort(settings, selection);
        addServiceTier(settings, selection);
        await this.backend.threadSettingsUpdate(settings);
      }
      return session ? json(200, { data: session }) : json(502, { error: 'Codex did not return a valid thread.' });
    }
    if ((url.pathname === '/api/openchamber/sessions/archive' || url.pathname === '/api/openchamber/sessions/unarchive') && method === 'POST') {
      const source = isJsonRecord(body) ? body : {};
      const ids = Array.isArray(source.ids) ? source.ids.filter((id): id is string => typeof id === 'string' && id.length > 0) : [];
      const archived = url.pathname.endsWith('/archive');
      const archivedAt = typeof source.archivedAt === 'number' ? source.archivedAt : Date.now();
      const failedIds: string[] = [];
      const changed: Array<Record<string, unknown>> = [];
      for (const id of ids) {
        try {
          if (archived) {
            await this.backend.threadArchive({ threadId: id });
            this.archivedThreads.add(id);
            changed.push({ id, archivedAt });
          } else {
            await this.backend.threadUnarchive({ threadId: id });
            this.archivedThreads.delete(id);
            changed.push({ id, archivedAt: null });
          }
        } catch {
          failedIds.push(id);
        }
      }
      return archived ? json(200, { archived: changed, failedIds }) : json(200, { restored: changed, failedIds });
    }
    const sessionMatch = url.pathname.match(/^\/api\/session\/([^/]+)(?:\/(.*))?$/);
    if (sessionMatch) {
      const sessionID = decodeURIComponent(sessionMatch[1]);
      const action = sessionMatch[2] || '';
      if (action === '' && method === 'GET') {
        let result: unknown;
        try {
          result = await this.backend.threadRead({ threadId: sessionID });
          this.rememberThreads(result);
        } catch (error) {
          // A thread may be owned by another Codex process. Its metadata from
          // thread/list is still valid and should keep the conversation
          // readable instead of turning the whole session row into an error.
          let cached = this.threadMetadata.get(sessionID);
          if (!cached) {
            // A deep link after extension restart has no directory cache yet.
            // A cwd-filtered list can hide a valid old rollout, so discover it
            // globally first and only use the scoped list as a fallback.
            const listed = await this.backend.threadList({ sourceKinds: ALL_CODEX_THREAD_SOURCES }).catch(() => null);
            this.rememberThreads(listed);
            if (!this.threadMetadata.has(sessionID)) {
              const scoped = await this.backend.threadList({ cwd: workingDirectory, sourceKinds: ALL_CODEX_THREAD_SOURCES }).catch(() => null);
              this.rememberThreads(scoped);
            }
            cached = this.threadMetadata.get(sessionID);
          }
          if (!this.threadPaths.has(sessionID)) {
            const discovered = await discoverLocalRollout(sessionID);
            if (discovered) {
              this.rememberThreads(discovered.metadata);
              cached = discovered.metadata;
            }
          }
          if (!cached) throw error;
          this.markThreadReadOnly(sessionID, error);
          result = { thread: cached };
        }
        // `thread/read` deliberately reports persisted metadata without
        // loading the thread, so an unloaded thread has
        // `canAcceptDirectInput: null` even when another app already owns it.
        // Probe ownership while opening the session; Codex's resume response
        // is the authoritative signal for the read-only UI state.
        // A thread can change owner after this facade has already resumed it.
        // Rejoin the running thread on every session read so ownership is
        // refreshed instead of being hidden by the local resumed-thread cache.
        try {
          const resumed = await this.resumeThread(sessionID, true, true);
          if (resumed && this.readOnlyThreads.has(sessionID)) this.markThreadWritable(sessionID, resumed);
        } catch (probeError) {
          if (this.isThreadOwnershipError(probeError)) {
            this.markThreadReadOnly(sessionID, probeError);
          } else {
            this.log(`session ownership probe failed for ${sessionID}: ${codexErrorDetails(probeError).message}`);
          }
        }
        const session = codexSessionFromStart(result);
        if (session) this.decorateSessionAccess(sessionID, session);
        if (session && this.archivedThreads.has(sessionID)) {
          const time = asRecord(session.time) || {};
          session.time = { ...time, archived: time.updated || Date.now() };
        }
        return session ? json(200, { data: session }) : json(404, { error: 'Codex thread was not found.' });
      }
      if (action === '' && method === 'PATCH') {
        const source = isJsonRecord(body) ? body : {};
        const title = typeof source.title === 'string' ? source.title : '';
        await this.backend.threadSetName({ threadId: sessionID, name: title });
        // The generated session.update contract is a 204 empty response.
        return noContent();
      }
      if (action === '' && method === 'DELETE') {
        await this.backend.threadDelete({ threadId: sessionID });
        this.archivedThreads.delete(sessionID);
        this.resumedThreads.delete(sessionID);
        this.threadDirectories.delete(sessionID);
        this.threadPaths.delete(sessionID);
        this.threadMetadata.delete(sessionID);
        this.readOnlyThreads.delete(sessionID);
        this.ownershipErrors.delete(sessionID);
        // @opencode/client's session.remove contract is a 204 empty response.
        // The UI still calls this through the compatibility facade, so a 200
        // body makes the generated client throw `UnexpectedStatus` even after
        // Codex has deleted the thread successfully.
        return noContent();
      }
      if ((action === 'archive' || action === 'unarchive') && method === 'POST') {
        if (action === 'archive') {
          await this.backend.threadArchive({ threadId: sessionID });
          this.archivedThreads.add(sessionID);
          return json(200, { archived: [{ id: sessionID, archivedAt: Date.now() }], failedIds: [] });
        }
        await this.backend.threadUnarchive({ threadId: sessionID });
        this.archivedThreads.delete(sessionID);
        return json(200, { restored: [{ id: sessionID, archivedAt: null }], failedIds: [] });
      }
      if (action === 'message' && method === 'GET') {
        // History reads must not acquire a writer or subscribe to a thread.
        // Desktop/CLI may own one conversation while other histories remain readable.
        if (!this.threadPaths.has(sessionID) && !this.threadMetadata.has(sessionID)) {
          const listed = await this.backend.threadList({ sourceKinds: ALL_CODEX_THREAD_SOURCES }).catch(() => null);
          this.rememberThreads(listed);
        }
        if (!this.threadPaths.has(sessionID)) {
          const discovered = await discoverLocalRollout(sessionID);
          if (discovered) this.rememberThreads(discovered.metadata);
        }
        const limit = Number(url.searchParams.get('limit')) || undefined;
        const readItems = () => this.backend.threadItemsList({ threadId: sessionID, limit, cursor: url.searchParams.get('cursor') || undefined, sortDirection: url.searchParams.get('order') === 'asc' ? 'asc' : 'desc' });
        let result: unknown = null;
        let readError: unknown;
        try {
          result = await readItems();
        } catch (error) {
          readError = error;
        }
        let record = asRecord(result);
        let entries = record && Array.isArray(record.data) ? record.data : [];
        // thread/read is a read-only operation and can expose persisted turns
        // even when thread/items/list rejects because another process owns the
        // live thread. Prefer that path before attempting an exclusive resume.
        if (readError || entries.length === 0) {
          try {
            const readResult = await this.backend.threadRead({ threadId: sessionID, includeTurns: true });
            this.rememberThreads(readResult);
            const readEntries = itemsFromThreadRead(readResult);
            if (readEntries.length > 0) {
              result = { data: readEntries };
              record = asRecord(result);
              entries = readEntries;
              if (readError) {
                this.markThreadReadOnly(sessionID, readError);
              }
            }
          } catch {
            // The optional read-only hydration is best effort. The normal
            // retry below still handles servers that require thread/resume.
          }
        }
        if (entries.length === 0 && !url.searchParams.get('cursor')) {
          // `thread/turns/list(itemsView: full)` is the current read-only
          // history API. It works for persisted threads that are not loaded
          // into this app-server process, where items/list and resume may be
          // rejected because another client owns the thread.
          try {
            const turnsResult = await this.backend.threadTurnsList({
              threadId: sessionID,
              limit,
              cursor: undefined,
              sortDirection: url.searchParams.get('order') === 'asc' ? 'asc' : 'desc',
              itemsView: 'full',
            });
            const turnsRecord = asRecord(turnsResult);
            const turns = turnsRecord && Array.isArray(turnsRecord.data) ? turnsRecord.data : [];
            const turnEntries = itemsFromTurns(turns);
            if (turnEntries.length > 0) {
              entries = turnEntries;
              record = { data: turnEntries, nextCursor: turnsRecord?.nextCursor };
              if (readError) {
                this.markThreadReadOnly(sessionID, readError);
              }
            }
          } catch {
            // Older app-server builds do not expose turns/list.
          }
        }
        if (entries.length === 0 && !url.searchParams.get('cursor')) {
          // The official read methods can be unavailable while another
          // app-server owns the thread. `thread/list` already gave us the
          // canonical rollout path, so reading that immutable JSONL directly
          // keeps old conversations visible without acquiring a writer lock.
          const rolloutEntries = await this.readRolloutHistory(sessionID);
          if (rolloutEntries.length > 0) {
            entries = rolloutEntries;
            record = { data: rolloutEntries };
            this.markThreadReadOnly(sessionID);
          }
        }
        if (entries.length === 0 && !url.searchParams.get('cursor')) {
          // If the read-only endpoints are implemented but return no items,
          // hydrate once as a best-effort compatibility path for older
          // app-server builds. A lock/ownership failure is intentionally
          // swallowed so it cannot turn a readable session into a hard error.
          try {
            const resumed = await this.resumeThread(sessionID, false);
            if (resumed) {
              result = await readItems();
              record = asRecord(result);
              entries = record && Array.isArray(record.data) ? record.data : [];
            }
          } catch (error) {
            this.markThreadReadOnly(sessionID, error);
          }
        }
        if (readError && entries.length === 0) {
          try {
            await this.resumeThread(sessionID, false);
            result = await readItems();
            record = asRecord(result);
            entries = record && Array.isArray(record.data) ? record.data : [];
          } catch {
            // Keep the read-only empty result. A locked thread must remain
            // navigable even when no turns are exposed by this server build.
            this.markThreadReadOnly(sessionID, readError);
            if (!result) result = { data: [] };
          }
        }
        if (entries.length === 0 && !url.searchParams.get('cursor')) {
          // Some older builds return an empty page for an unloaded persisted
          // thread. One final read-only attempt covers that shape without
          // requiring a writer lock.
          try {
            entries = itemsFromThreadRead(await this.backend.threadRead({ threadId: sessionID, includeTurns: true }));
          } catch { /* preserve an empty history */ }
        }
        if (entries.length === 0 && readError && !url.searchParams.get('cursor')) {
          const details = codexErrorDetails(readError);
          this.log(`HISTORY_READ_FAILED thread=${sessionID} ${details.message}`);
          return json(409, {
            _tag: 'CodexHistoryReadError',
            error: details.message,
            message: details.message,
            type: details.type,
            response: details.response,
            readOnly: true,
          });
        }
        this.reconcileUserMessageAliases(sessionID, entries);
        const thread = await this.backend.threadRead({ threadId: sessionID }).catch(() => null);
        const threadRecord = asRecord(thread);
        const threadValue = threadRecord && asRecord(threadRecord.thread);
        const model = threadValue && typeof threadValue.model === 'string' ? threadValue.model : undefined;
        const nextCursor = record && typeof record.nextCursor === 'string' && record.nextCursor ? record.nextCursor : undefined;
        const previousCursor = record && typeof record.backwardsCursor === 'string' && record.backwardsCursor ? record.backwardsCursor : undefined;
        return json(200, {
          data: entries.flatMap((entry) => { const message = threadItemMessage(entry, sessionID, model, (id) => this.aliasMessageID(sessionID, id)); return message ? [message] : []; }),
          cursor: { ...(previousCursor ? { previous: previousCursor } : {}), ...(nextCursor ? { next: nextCursor } : {}) },
        });
      }
      if (action.startsWith('message/') && method === 'GET') {
        const messageID = decodeURIComponent(action.slice('message/'.length));
        const result = await this.backend.threadItemsList({ threadId: sessionID });
        const record = asRecord(result);
        const entries = record && Array.isArray(record.data) ? record.data : [];
        this.reconcileUserMessageAliases(sessionID, entries);
        const thread = await this.backend.threadRead({ threadId: sessionID }).catch(() => null);
        const threadRecord = asRecord(thread);
        const threadValue = threadRecord && asRecord(threadRecord.thread);
        const model = threadValue && typeof threadValue.model === 'string' ? threadValue.model : undefined;
        const message = entries.map((entry) => threadItemMessage(entry, sessionID, model, (id) => this.aliasMessageID(sessionID, id))).find((entry) => asRecord(asRecord(entry)?.info)?.id === messageID);
        return message ? json(200, message) : json(404, { error: 'Codex message was not found.' });
      }
      if (action === 'prompt' && method === 'POST') {
        try {
          await this.resumeThread(sessionID, true);
        } catch (error) {
          if (!this.isThreadOwnershipError(error)) throw error;
          this.markThreadReadOnly(sessionID, error);
          return json(409, {
            _tag: 'CodexThreadOwnedByAnotherClient',
            error: codexErrorDetails(error).message,
            message: codexErrorDetails(error).message,
            readOnly: true,
          });
        }
        const input = inputFromPrompt(body);
        const params: Record<string, unknown> = { threadId: sessionID, input };
        Object.assign(params, this.threadSettings.get(sessionID));
        const selection: ModelSelection = isJsonRecord(body) ? modelSelection(body.model) : { hasEffort: false };
        addServiceTier(params, selection);
        if (isJsonRecord(body) && typeof body.messageID === 'string') {
          params.clientUserMessageId = body.messageID;
          this.rememberUserMessage(sessionID, body.messageID, textFromPrompt(body));
        }
        if (selection.id) params.model = selection.id;
        addEffort(params, selection);
        // Publish the busy state before waiting on JSON-RPC. This matches the
        // official Codex client, which shows "thinking" while the server is
        // still preparing a turn and has not produced text yet.
        this.broadcastWire('session.execution.started', { sessionID: sessionID });
        // The app-server acknowledges turn/start immediately on current
        // versions, but older builds can hold the JSON-RPC response until the
        // first model event. Keep the HTTP prompt request responsive so the UI
        // can render its thinking state; lifecycle notifications remain the
        // source of truth for completion and errors.
        this.inflightTurnSessions.add(sessionID);
        const turnRequest = this.backend.turnStart(params).catch((error) => {
          // Some app-server versions can reject/timeout the JSON-RPC request
          // after they have already accepted the turn and started streaming.
          // Hold the error briefly; output or turn/completed will either clear
          // it or replace it with the authoritative terminal result.
          this.pendingTurnErrors.set(sessionID, error);
          if (this.isThreadOwnershipError(error)) this.markThreadReadOnly(sessionID, error);
          const timer = setTimeout(() => {
            if (this.pendingTurnErrors.get(sessionID) !== error) return;
            this.pendingTurnErrors.delete(sessionID);
            if (!this.turns.has(sessionID) && !this.activeTurnIds.has(sessionID)) {
              this.broadcastWire('session.execution.failed', { sessionID, error: codexErrorDetails(error) });
            }
          }, 10_000);
          timer.unref();
          return null;
        });
        const result = await Promise.race([
          turnRequest,
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 750)),
        ]);
        return json(200, result ?? { turn: { id: `codex-pending-${Date.now()}` } });
      }
      if (action === 'model' && method === 'POST') {
        const source = isJsonRecord(body) ? body : {};
        const selection = modelSelection(source.model);
        const modelId = selection.id || '';
        if (!modelId.trim()) {
          return json(400, { error: 'A Codex model id is required.' });
        }
        const settings: Record<string, unknown> = { threadId: sessionID, model: modelId.trim() };
        // A model switch from the UI represents the complete picker state.
        // OpenChamber omits an optional `variant` when Default is selected, so
        // explicitly clear the previous Codex effort in that case.
        if (selection.hasEffort) addEffort(settings, selection);
        else settings.effort = null;
        addServiceTier(settings, selection);
        // Persist picker state without loading/locking every selected history.
        this.threadSettings.set(sessionID, { ...this.threadSettings.get(sessionID), ...settings });
        try {
          await this.resumeThread(sessionID, true);
        } catch (error) {
          if (!this.isThreadOwnershipError(error)) throw error;
          this.markThreadReadOnly(sessionID, error);
          return noContent();
        }
        await this.backend.threadSettingsUpdate(settings);
        return noContent();
      }
      if (action === 'settings' && method === 'POST') {
        const source = isJsonRecord(body) ? body : {};
        const allowed = ['approvalPolicy', 'approvalsReviewer', 'sandboxPolicy', 'permissions', 'serviceTier', 'effort', 'model'] as const;
        const settings: Record<string, unknown> = { threadId: sessionID };
        for (const key of allowed) if (Object.prototype.hasOwnProperty.call(source, key)) settings[key] = source[key];
        this.threadSettings.set(sessionID, { ...this.threadSettings.get(sessionID), ...settings });
        // A listed thread may be owned by another process and therefore not
        // resumable here. Keep the choice for the next writable turn.
        try {
          await this.resumeThread(sessionID, true);
          await this.backend.threadSettingsUpdate(settings);
        } catch (error) {
          if (!this.isThreadOwnershipError(error)) throw error;
          this.markThreadReadOnly(sessionID, error);
        }
        return noContent();
      }
      if ((action === 'abort' || action === 'interrupt') && method === 'POST') {
        return json(200, await this.backend.turnInterrupt({ threadId: sessionID, turnId: url.searchParams.get('turnId') || this.activeTurnIds.get(sessionID) || '' }));
      }
      if (action === 'diff' && method === 'GET') {
        // OpenChamber's existing DiffView consumes the OpenCode session.diff
        // array. Reconstruct the same shape from persisted Codex fileChange
        // items without resuming a thread owned by another process.
        let entries: Array<Record<string, unknown>> = [];
        try {
          entries = itemsFromThreadRead(await this.backend.threadRead({ threadId: sessionID, includeTurns: true }));
        } catch {
          entries = await this.readRolloutHistory(sessionID);
        }
        const files = new Map<string, { file: string; patch: string; status: string; additions: number; deletions: number }>();
        for (const entry of entries) {
          const item = asRecord(entry.item);
          if (!item || String(item.type).toLowerCase() !== 'filechange') continue;
          for (const change of fileChangesFromItem(item)) {
            const patch = change.diff;
            let additions = 0;
            let deletions = 0;
            for (const line of patch.split(/\r?\n/)) {
              if (line.startsWith('+') && !line.startsWith('+++')) additions++;
              if (line.startsWith('-') && !line.startsWith('---')) deletions++;
            }
            files.set(change.file, { file: change.file, patch, status: 'modified', additions, deletions });
          }
        }
        return json(200, [...files.values()]);
      }
      if (action === 'fork' && method === 'POST') {
        const source = isJsonRecord(body) ? body : {};
        const result = await this.backend.threadFork({
          threadId: sessionID,
          ...(typeof source.lastTurnId === 'string' ? { lastTurnId: source.lastTurnId } : {}),
          ...(typeof source.beforeTurnId === 'string' ? { beforeTurnId: source.beforeTurnId } : {}),
          ...(this.threadPaths.has(sessionID) ? { path: this.threadPaths.get(sessionID) } : {}),
          excludeTurns: true,
        });
        this.rememberThreads(result);
        const session = codexSessionFromStart(result);
        return session ? json(200, { data: session }) : json(502, { error: 'Codex did not return a forked thread.' });
      }
      const permissionReplyMatch = action.match(/^permission\/([^/]+)\/reply$/);
      if ((action === 'permission' || permissionReplyMatch) && method === 'POST') {
        const source = isJsonRecord(body) ? body : {};
        const pathRequestID = permissionReplyMatch ? decodeURIComponent(permissionReplyMatch[1]) : undefined;
        let requestID: string | number | undefined = pathRequestID
          ?? (typeof source.requestID === 'string' || typeof source.requestID === 'number' ? source.requestID : undefined);
        let pending = requestID === undefined ? undefined : this.pendingApprovals.get(requestID);
        // URL path parameters are strings, while Codex commonly uses numeric
        // JSON-RPC ids for server requests. Preserve the original key type in
        // the response; JSON-RPC ids are matched by both value and type.
        if (!pending && typeof requestID === 'string') {
          const numericID = Number(requestID);
          if (Number.isFinite(numericID)) {
            pending = this.pendingApprovals.get(numericID);
            if (pending) requestID = numericID;
          }
        }
        if (!pending && typeof requestID === 'number') {
          const stringID = String(requestID);
          pending = this.pendingApprovals.get(stringID);
          if (pending) requestID = stringID;
        }
        const requestIDType = requestID === undefined ? 'undefined' : typeof requestID;
        this.log(`PERMISSION_REPLY requestId=${String(requestID ?? '')} requestIdType=${requestIDType} decision=${String(source.decision ?? source.reply ?? '')} pending=${pending ? 'yes' : 'no'}`);
        if (requestID !== undefined && pending) {
          const requestedDecision = source.decision ?? source.reply;
          const reply = requestedDecision === 'reject' ? 'reject' : requestedDecision === 'always' ? 'always' : 'once';
          if (pending.method === 'item/permissions/requestApproval') {
            // This request has a different Codex response contract from shell
            // and file approvals: it grants the requested profile for one turn
            // or the whole session. A rejection is a JSON-RPC error so Codex
            // does not interpret an empty profile as permission granted.
            if (reply === 'reject') {
              this.backend.respondToServerRequest(requestID, undefined, { code: -32800, message: 'Permission request declined' });
              this.log(`PERMISSION_RPC_REPLY requestId=${String(requestID)} result=error`);
            } else {
              const permissionParams = asRecord(pending.params);
              const requested = isJsonRecord(permissionParams?.permissions) ? permissionParams.permissions : {};
              this.backend.respondToServerRequest(requestID, {
                permissions: requested,
                scope: reply === 'always' ? 'session' : 'turn',
              });
              this.log(`PERMISSION_RPC_REPLY requestId=${String(requestID)} result=granted scope=${reply === 'always' ? 'session' : 'turn'}`);
            }
          } else {
            const decision = reply === 'reject' ? 'decline' : reply === 'always' ? 'acceptForSession' : 'accept';
            this.backend.respondToServerRequest(requestID, { decision });
            this.log(`PERMISSION_RPC_REPLY requestId=${String(requestID)} result=${decision}`);
          }
          this.pendingApprovals.delete(requestID);
          this.pendingApprovals.delete(typeof requestID === 'string' ? Number(requestID) : String(requestID));
          const permissionParams = asRecord(pending.params);
          const permissionSessionID = typeof permissionParams?.threadId === 'string'
            ? permissionParams.threadId
            : typeof permissionParams?.conversationId === 'string' ? permissionParams.conversationId : undefined;
          if (permissionSessionID) {
            this.broadcastWire('permission.replied', {
              sessionID: permissionSessionID,
              requestID: String(requestID),
            });
          }
        } else if (requestID !== undefined) {
          this.log(`PERMISSION_REPLY_IGNORED requestId=${String(requestID)} reason=pending-not-found`);
        }
        return json(200, { ok: true });
      }
    }
    // `config.get` is one of the older OpenCode endpoints whose generated
    // client consumes the response directly as `ConfigEntry[]` (there is no
    // `{ data: ... }` envelope). Returning an envelope here makes the shared
    // bootstrap code treat the object as a config list and fail during the
    // first new-session render.
    if (url.pathname === '/api/config') return json(200, []);
    if (url.pathname.startsWith('/api/config/')) {
      return json(200, url.pathname.endsWith('/settings') ? {} : { data: [] });
    }
    // These catalogs are optional in the Codex adapter, but OpenChamber
    // fetches them lazily from the composer and settings surfaces. Returning
    // an empty, correctly enveloped catalog keeps those surfaces usable and
    // lets the UI show the real Codex capability state instead of dereferencing
    // an absent response payload.
    if (url.pathname === '/api/command' && method === 'GET') return json(200, { data: [] });
    if (url.pathname === '/api/skill' && method === 'GET') return json(200, { data: [] });
    if (url.pathname === '/api/mcp' && method === 'GET') return json(200, { data: [] });
    return json(404, { error: 'Codex backend does not support this OpenCode endpoint', capability: 'codex-facade' });
  }

  /** External inputs use the same ownership, model and lifecycle state as chat. */
  async checkExternalTarget(sessionID: string, allowBusy = false): Promise<void> {
    const result = await this.backend.threadRead({ threadId: sessionID });
    this.rememberThreads(result);
    if (this.archivedThreads.has(sessionID)) throw new Error('目标会话已归档，请恢复后再发送。');
    const thread = asRecord(asRecord(result)?.thread);
    if (thread?.status && asRecord(thread.status)?.type === 'archived') throw new Error('目标会话已归档，请恢复后再发送。');
    if (!allowBusy && (this.inflightTurnSessions.has(sessionID) || this.activeTurnIds.has(sessionID))) throw new Error('目标会话正在回复，请完成后再次发送。');
    try { await this.resumeThread(sessionID, true, this.readOnlyThreads.has(sessionID)); }
    catch (error) {
      if (this.isThreadOwnershipError(error)) this.markThreadReadOnly(sessionID, error);
      throw error;
    }
    if (this.readOnlyThreads.has(sessionID)) throw new Error('目标会话正在另一个应用中使用。');
  }

  async submitExternalInput(sessionID: string, input: Array<Record<string, unknown>>, messageID: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    await this.checkExternalTarget(sessionID);
    // Webviews cannot read workspace paths as image URLs. Build renderable
    // attachments before submitting so a missing file cannot look like a
    // rejected turn after Codex has already accepted it.
    const files: PromptFileAttachment[] = await Promise.all(input.filter(part => part.type === 'localImage' && typeof part.path === 'string').map(async part => {
      const data = (await fs.readFile(String(part.path))).toString('base64');
      return { mime: 'image/png', data, name: String(part.path).split(/[\\/]/).pop(), source: { type: 'inline' as const } };
    }));
    const payload: SessionInboxUserPayload = { text: input.filter(part => part.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n'), files };
    signal?.throwIfAborted();
    if (this.inflightTurnSessions.has(sessionID)) throw new Error('目标会话正在提交，请稍后重试。');
    const createdAt = Date.now();
    this.inflightTurnSessions.add(sessionID);
    this.broadcastWire('session.execution.started', { sessionID });
    this.rememberUserMessage(sessionID, messageID, input.map(part => typeof part.text === 'string' ? part.text : '').join(''));
    try {
      const result = await this.backend.turnStart({ ...this.threadSettings.get(sessionID), threadId: sessionID, input, clientUserMessageId: messageID });
      this.broadcastWire('session.inbox.enqueued', { sessionID, inboxID: messageID, item: { type: 'user', delivery: 'queue', payload } }, undefined, createdAt);
      const turn = asRecord(asRecord(result)?.turn);
      if (this.inflightTurnSessions.has(sessionID) && typeof turn?.id === 'string') this.activeTurnIds.set(sessionID, turn.id);
    } catch (error) {
      if (this.isThreadOwnershipError(error)) this.markThreadReadOnly(sessionID, error);
      // An interrupted transport may have accepted the request. Never report it
      // as safe to automatically resend; the receiver keeps an uncertain receipt.
      if (/timed out|timeout|app-server stopped|app-server exited|not running|ECONN|socket/i.test(String(error))) {
        throw Object.assign(new Error('Codex 提交结果未确认，请检查会话后处理；队列已保留，避免重复发送。'), { uncertain: true });
      }
      this.inflightTurnSessions.delete(sessionID);
      this.broadcastWire('session.execution.failed', { sessionID, error: codexErrorDetails(error) });
      throw error;
    }
  }

  private async resumeThread(threadId: string, required = false, force = false): Promise<unknown | null> {
    if (!force && this.resumedThreads.has(threadId)) return null;
    const pending = this.resumeRequests.get(threadId);
    if (pending) return pending;
    const request = this.resumeThreadOnce(threadId, required, force).finally(() => this.resumeRequests.delete(threadId));
    this.resumeRequests.set(threadId, request);
    return request;
  }

  private async resumeThreadOnce(threadId: string, required = false, force = false): Promise<unknown | null> {
    if (!force && this.resumedThreads.has(threadId)) return null;
    const resume = (this.backend as CodexBackend & { threadResume?: (params: Record<string, unknown>) => Promise<unknown> }).threadResume;
    if (typeof resume !== 'function') return null;
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const params: Record<string, unknown> = { threadId };
      const cwd = this.threadDirectories.get(threadId);
      const path = this.threadPaths.get(threadId);
      // Keep these values dynamic: they come from Codex's thread/list/read
      // records and are never inferred from a fixed workspace path.
      if (cwd) params.cwd = cwd;
      if (path) params.path = path;
      try {
        const result = await resume.call(this.backend, params);
        this.resumedThreads.add(threadId);
        this.rememberThreads(result);
        return result;
      } catch (error) {
        lastError = error;
        // A deep link or a freshly restored UI may not have loaded thread/list
        // first. Ask Codex for metadata once, cache its real rollout path, and
        // retry with that path before surfacing the original server error.
        if (attempt === 0 && !path) {
          const read = (this.backend as CodexBackend & { threadRead?: (params: Record<string, unknown>) => Promise<unknown> }).threadRead;
          if (typeof read === 'function') {
            try {
              const metadata = await read.call(this.backend, { threadId });
              this.rememberThreads(metadata);
              continue;
            } catch {
              // Keep the resume error: it contains the actionable Codex
              // rollout diagnostic and is shown by the facade error card.
            }
          }
        }
        break;
      }
    }
    if (required) throw lastError instanceof Error ? lastError : new Error(String(lastError));
    return null;
  }

  private activeSessionSnapshot(): Record<string, { type: 'running' }> {
    const active = new Set<string>([...this.inflightTurnSessions, ...this.activeTurnIds.keys()]);
    for (const pending of this.pendingApprovals.values()) {
      const params = asRecord(pending.params);
      const threadId = typeof params?.threadId === 'string'
        ? params.threadId
        : typeof params?.conversationId === 'string' ? params.conversationId : undefined;
      if (threadId) active.add(threadId);
    }
    return Object.fromEntries([...active].map((id) => [id, { type: 'running' as const }]));
  }

  private async readRolloutHistory(threadId: string): Promise<Array<Record<string, unknown>>> {
    const path = this.threadPaths.get(threadId);
    if (!path) return [];
    try {
      return itemsFromRolloutText(await fs.readFile(localPathFromUri(path), 'utf8'));
    } catch (error) {
      this.log(`read-only rollout history unavailable for ${threadId}: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  private isThreadOwnershipError(error: unknown): boolean {
    const message = String(codexErrorDetails(error).message || '');
    return /already (?:being )?used|in use|another (?:application|client)|locked|owned by|exclusive|writer/i.test(message);
  }

  private markThreadReadOnly(sessionID: string, error?: unknown): void {
    this.readOnlyThreads.add(sessionID);
    if (error !== undefined) this.ownershipErrors.set(sessionID, String(codexErrorDetails(error).message));
    const thread = this.threadMetadata.get(sessionID) ?? { id: sessionID };
    this.broadcastOwnershipMetadata(sessionID, thread);
  }

  private markThreadWritable(sessionID: string, thread: unknown): void {
    if (!this.readOnlyThreads.delete(sessionID)) return;
    this.ownershipErrors.delete(sessionID);
    const metadata = asRecord(thread) ?? this.threadMetadata.get(sessionID) ?? { id: sessionID };
    this.broadcastOwnershipMetadata(sessionID, metadata);
  }

  private broadcast(event: { method: string; params?: unknown }): void {
    const params = asRecord(event.params);
    const item = asRecord(params?.item);
    this.log(`EVENT ${JSON.stringify({
      method: event.method,
      threadId: typeof params?.threadId === 'string' ? params.threadId : undefined,
      turnId: typeof params?.turnId === 'string' ? params.turnId : undefined,
      itemId: typeof params?.itemId === 'string' ? params.itemId : typeof item?.id === 'string' ? item.id : undefined,
      requestId: typeof (event as { id?: unknown }).id === 'string' || typeof (event as { id?: unknown }).id === 'number'
        ? (event as unknown as { id: string | number }).id : typeof params?.requestId === 'string' || typeof params?.requestId === 'number' ? params.requestId : undefined,
      itemType: typeof item?.type === 'string' ? item.type : undefined,
      itemStatus: typeof item?.status === 'string' ? item.status : undefined,
      exitCode: typeof item?.exitCode === 'number' ? item.exitCode : typeof params?.exitCode === 'number' ? params.exitCode : undefined,
      deltaLength: typeof params?.delta === 'string' ? params.delta.length : undefined,
      willRetry: params?.willRetry === true ? true : undefined,
      error: params?.error ? codexErrorDetails(params.error).message : undefined,
    })}`);
    if (!params) return;
    if (event.method === 'item/commandExecution/requestApproval'
      || event.method === 'item/fileChange/requestApproval'
      || event.method === 'item/permissions/requestApproval'
      || event.method === 'execCommandApproval'
      || event.method === 'applyPatchApproval') {
      const request = event as { method: string; id?: string | number; params?: unknown };
      // A permission card without a server request id cannot be answered and
      // would later be mistaken for a resolved request. Keep it out of the
      // OpenChamber blocking-request store until Codex gives us a real id.
      if (request.id === undefined) return;
      this.pendingApprovals.set(request.id, { method: request.method, params: request.params });
      const approvalThreadId = typeof params.threadId === 'string' ? params.threadId : typeof params.conversationId === 'string' ? params.conversationId : undefined;
      if (approvalThreadId) {
        const action = request.method.includes('fileChange') || request.method === 'applyPatchApproval' ? 'edit' : request.method.includes('permissions') ? 'permissions' : 'bash';
        const resources = Array.isArray(params.resources)
          ? params.resources.filter((resource): resource is string => typeof resource === 'string')
          : typeof params.command === 'string' && params.command ? [params.command]
            : typeof params.grantRoot === 'string' && params.grantRoot ? [params.grantRoot] : [];
        // OpenChamber's permission store expects the flattened OpenCode shape.
        // Keeping the raw Codex request in metadata preserves the rich command,
        // cwd and requested-profile details for the card without losing its id.
        this.broadcastWire('session.execution.started', { sessionID: approvalThreadId });
        this.broadcastWire('permission.asked', {
          id: String(request.id),
          requestID: String(request.id),
          sessionID: approvalThreadId,
          action,
          resources,
          metadata: params,
        });
      }
      return;
    }
    const threadId = typeof params.threadId === 'string'
      ? params.threadId
      : (isJsonRecord(params.turn) && typeof params.turn.threadId === 'string' ? params.turn.threadId : undefined);

    // Emit OpenCode wire envelopes because OpenChamber's sync pipeline first
    // validates and translates the wire event before updating its stores.
    if (event.method === 'thread/started' && isJsonRecord(params.thread)) {
      const thread = params.thread;
      if (typeof thread.id === 'string') {
        // A live thread/started notification represents a loaded thread too.
        // Mark it before any prompt arrives so the first turn is not preceded
        // by an invalid resume attempt.
        this.resumedThreads.add(thread.id);
        const directory = typeof thread.cwd === 'string' && thread.cwd ? thread.cwd : process.cwd();
        this.threadDirectories.set(thread.id, directory);
        this.broadcastWire('session.created', {
          sessionID: thread.id,
          projectID: directory,
          location: { directory },
          title: typeof thread.preview === 'string' ? thread.preview : '',
          agent: 'codex',
          model: typeof thread.model === 'string' ? { providerID: 'codex', id: thread.model, variant: thread.reasoningEffort } : undefined,
        }, directory);
      }
      return;
    }
    if (event.method === 'thread/closed' && threadId) {
      this.resumedThreads.delete(threadId);
      this.activeTurnIds.delete(threadId);
      this.inflightTurnSessions.delete(threadId);
      return;
    }
    if (event.method === 'serverRequest/resolved') {
      const requestID = params.requestId;
      if (typeof requestID === 'string' || typeof requestID === 'number') {
        const pending = this.pendingApprovals.get(requestID);
        this.log(`PERMISSION_RESOLVED requestId=${String(requestID)} pending=${pending ? 'yes' : 'no'}`);
        this.pendingApprovals.delete(requestID);
        this.pendingApprovals.delete(typeof requestID === 'string' ? Number(requestID) : String(requestID));
        const pendingParams = asRecord(pending?.params);
        const resolvedThreadId = typeof params.threadId === 'string'
          ? params.threadId
          : typeof pendingParams?.threadId === 'string' ? pendingParams.threadId : undefined;
        if (resolvedThreadId) this.broadcastWire('permission.replied', { sessionID: resolvedThreadId, requestID: String(requestID) });
      }
      return;
    }
    if (event.method === 'thread/status/changed' && threadId) {
      const status = asRecord(params.status);
      if (status?.type === 'active') {
        this.inflightTurnSessions.add(threadId);
        this.broadcastWire('session.execution.started', { sessionID: threadId });
      }
      return;
    }
    if (event.method === 'turn/started' && threadId) {
      this.inflightTurnSessions.add(threadId);
      const turn = asRecord(params.turn);
      if (typeof turn?.id === 'string') this.activeTurnIds.set(threadId, turn.id);
      // `turn/started` is the official Codex notification. Keep accepting the
      // older status envelope for recorded fixtures and mixed-version servers.
      this.broadcastWire('session.execution.started', { sessionID: threadId });
      return;
    }
    if (event.method === 'thread/archived' && threadId) {
      this.archivedThreads.add(threadId);
      this.resumedThreads.delete(threadId);
      this.threadPaths.delete(threadId);
      this.broadcastWire('session.patched', { sessionID: threadId, patch: { time: { archived: Date.now() } } });
      return;
    }
    if (event.method === 'thread/unarchived' && threadId) {
      this.archivedThreads.delete(threadId);
      this.resumedThreads.delete(threadId);
      this.threadPaths.delete(threadId);
      this.broadcastWire('session.patched', { sessionID: threadId, patch: { time: { archived: null } } });
      return;
    }
    if (event.method === 'thread/deleted' && threadId) {
      this.archivedThreads.delete(threadId);
      this.resumedThreads.delete(threadId);
      this.threadPaths.delete(threadId);
      this.threadSettings.delete(threadId);
      this.pendingUserMessages.delete(threadId);
      this.userMessageAliases.delete(threadId);
      this.broadcastWire('session.deleted', { sessionID: threadId });
      return;
    }
    if (event.method === 'thread/name/updated' && threadId) {
      const name = typeof params.name === 'string' ? params.name : undefined;
      if (name !== undefined) this.broadcastWire('session.patched', { sessionID: threadId, patch: { title: name, time: { updated: Date.now() } } });
      return;
    }
    if ((event.method === 'item/started' || event.method === 'item/completed') && threadId && isJsonRecord(params.item)
      && String(params.item.type).toLowerCase() === 'usermessage') {
      this.matchUserMessage(threadId, params.item);
      return;
    }
    if (event.method === 'item/started' && threadId && isJsonRecord(params.item)
      && ['commandexecution', 'filechange'].includes(String(params.item.type).toLowerCase())) {
      this.inflightTurnSessions.add(threadId);
      const item = params.item;
      const itemId = typeof item.id === 'string' ? item.id : `codex-tool-${Date.now()}`;
      const current = this.turns.get(threadId);
      const assistantMessageID = current?.messageId ?? `codex-message-${threadId}`;
      if (!current) {
        const startedAt = typeof params.startedAtMs === 'number' ? params.startedAtMs : Date.now();
        this.turns.set(threadId, { messageId: assistantMessageID, text: '', startedAt });
        this.broadcastWire('session.step.started', {
          sessionID: threadId,
          assistantMessageID,
          model: { providerID: 'codex', id: 'codex' },
          agent: 'codex',
        }, undefined, startedAt);
      }
      this.toolAssistants.set(itemId, assistantMessageID);
      this.toolThreads.set(itemId, threadId);
      const isCommand = String(item.type).toLowerCase() === 'commandexecution';
      const name = isCommand ? 'shell' : 'patch';
      const input = isCommand
        ? { command: typeof item.command === 'string' ? item.command : '', ...(typeof item.cwd === 'string' ? { cwd: item.cwd } : {}) }
        : { changes: Array.isArray(item.changes) ? item.changes : [] };
      if (!isCommand) this.toolFileChanges.set(itemId, fileChangesFromItem(item));
      if (isCommand && typeof item.processId === 'string' && item.processId) this.toolProcesses.set(item.processId, itemId);
      this.broadcastWire('session.tool.input.started', { sessionID: threadId, assistantMessageID, id: itemId, name });
      this.broadcastWire('session.tool.input.ended', { sessionID: threadId, assistantMessageID, id: itemId, text: JSON.stringify(input) });
      this.broadcastWire('session.tool.called', { sessionID: threadId, assistantMessageID, id: itemId, input, executed: true });
      return;
    }
    if ((event.method === 'item/commandExecution/outputDelta' || event.method === 'command/exec/outputDelta') && threadId) {
      const itemId = typeof params.itemId === 'string' ? params.itemId : undefined;
      const assistantMessageID = itemId ? this.toolAssistants.get(itemId) : undefined;
      const delta = typeof params.delta === 'string' ? params.delta : '';
      if (itemId && assistantMessageID && delta) {
        const output = `${this.toolOutputs.get(itemId) ?? ''}${delta}`;
        this.toolOutputs.set(itemId, output);
        this.broadcastWire('session.tool.progress', { sessionID: threadId, assistantMessageID, id: itemId, metadata: { output } });
      }
      return;
    }
    if (event.method === 'item/fileChange/patchUpdated' && threadId) {
      const itemId = typeof params.itemId === 'string' ? params.itemId : undefined;
      const assistantMessageID = itemId ? this.toolAssistants.get(itemId) : undefined;
      if (itemId && assistantMessageID) {
        const files = fileChangesFromItem({ changes: params.changes as unknown }, this.toolFileChanges.get(itemId));
        this.toolFileChanges.set(itemId, files);
        this.broadcastWire('session.tool.progress', { sessionID: threadId, assistantMessageID, id: itemId, metadata: { files } });
      }
      return;
    }
    if (event.method === 'process/exited') {
      const processId = typeof params.processHandle === 'string'
        ? params.processHandle
        : typeof params.processId === 'string' ? params.processId : undefined;
      const itemId = typeof params.itemId === 'string' ? params.itemId : processId ? this.toolProcesses.get(processId) : undefined;
      const resolvedThreadId = threadId || (itemId ? this.toolThreads.get(itemId) : undefined);
      const assistantMessageID = itemId ? this.toolAssistants.get(itemId) : undefined;
      if (resolvedThreadId && itemId && assistantMessageID && !this.finalizedTools.has(itemId)) {
        const exitCode = typeof params.exitCode === 'number' ? params.exitCode : undefined;
        const output = this.toolOutputs.get(itemId) ?? '';
        const failed = exitCode !== undefined && exitCode !== 0;
        this.finalizedTools.add(itemId);
        this.broadcastWire(failed ? 'session.tool.failed' : 'session.tool.success', {
          sessionID: resolvedThreadId,
          assistantMessageID,
          id: itemId,
          ...(failed
            ? { error: `Command exited with code ${exitCode}`, content: output ? [{ type: 'text', text: output }] : [] }
            : { content: output ? [{ type: 'text', text: output }] : [] }),
          ...(exitCode !== undefined ? { metadata: { exit: exitCode } } : {}),
          executed: true,
        });
      }
      return;
    }
    if (event.method === 'item/started' && threadId && isJsonRecord(params.item) && String(params.item.type).toLowerCase() === 'agentmessage') {
      // A few app-server versions emit a non-terminal `error` notification
      // while the model is still preparing its answer. Actual agent output is
      // authoritative evidence that the turn is alive, so do not fail it when
      // the later turn/completed notification arrives.
      this.inflightTurnSessions.add(threadId);
      this.pendingTurnErrors.delete(threadId);
      const messageId = typeof params.item.id === 'string' ? params.item.id : `codex-message-${Date.now()}`;
      const startedAt = typeof params.startedAtMs === 'number' ? params.startedAtMs : Date.now();
      const model = this.turns.get(threadId)?.model;
      const variant = this.turns.get(threadId)?.variant;
      this.turns.set(threadId, { messageId, text: '', startedAt, model, variant });
      this.broadcastWire('session.step.started', {
        sessionID: threadId,
        assistantMessageID: messageId,
        model: { providerID: 'codex', id: model || 'codex', variant },
        agent: 'codex',
      }, undefined, startedAt);
      this.broadcastWire('session.text.started', { sessionID: threadId, assistantMessageID: messageId, ordinal: 0 }, undefined, startedAt);
      return;
    }
    if (event.method === 'item/agentMessage/delta' && threadId) {
      this.inflightTurnSessions.add(threadId);
      this.pendingTurnErrors.delete(threadId);
      const delta = typeof params.delta === 'string' ? params.delta : '';
      const itemId = typeof params.itemId === 'string' ? params.itemId : undefined;
      const current = this.turns.get(threadId) ?? { messageId: itemId || `codex-message-${Date.now()}`, text: '', startedAt: Date.now() };
      if (itemId && current.messageId !== itemId) current.messageId = itemId;
      current.text += delta;
      this.turns.set(threadId, current);
      this.broadcastWire('session.text.delta', {
        sessionID: threadId,
        assistantMessageID: current.messageId,
        ordinal: 0,
        delta,
      });
      return;
    }
    if (event.method === 'item/completed' && threadId && isJsonRecord(params.item)
      && ['commandexecution', 'filechange'].includes(String(params.item.type).toLowerCase())) {
      const item = params.item;
      const itemId = typeof item.id === 'string' ? item.id : undefined;
      if (!itemId) return;
      const assistantMessageID = this.toolAssistants.get(itemId) ?? this.turns.get(threadId)?.messageId;
      if (!assistantMessageID) return;
      if (this.finalizedTools.has(itemId)) {
        this.toolAssistants.delete(itemId);
        this.toolOutputs.delete(itemId);
        this.toolFileChanges.delete(itemId);
        this.toolThreads.delete(itemId);
        for (const [processId, mappedItem] of this.toolProcesses) if (mappedItem === itemId) this.toolProcesses.delete(processId);
        return;
      }
      const completedAt = typeof params.completedAtMs === 'number' ? params.completedAtMs : Date.now();
      if (String(item.type).toLowerCase() === 'commandexecution') {
        const output = typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : this.toolOutputs.get(itemId) ?? '';
        const exit = typeof item.exitCode === 'number' ? item.exitCode : undefined;
        const status = typeof item.status === 'string' ? item.status.toLowerCase() : '';
        const succeeded = !/fail|error|reject|declin|cancel|interrupt/i.test(status)
          && (exit === undefined || exit === 0);
        const content = output;
        const metadata = { ...(typeof item.cwd === 'string' ? { cwd: item.cwd } : {}), ...(exit !== undefined ? { exit } : {}) };
        this.broadcastWire(succeeded ? 'session.tool.success' : 'session.tool.failed', {
          sessionID: threadId,
          assistantMessageID,
          id: itemId,
          ...(succeeded
            ? { content: content ? [{ type: 'text', text: content }] : [] }
            : { error: status || 'Command failed', content: content ? [{ type: 'text', text: content }] : [] }),
          metadata,
          executed: true,
        }, undefined, completedAt);
      } else {
        const status = fileChangeStatus(item);
        const failed = /fail|reject|declin|error/i.test(status);
        const files = fileChangesFromItem(item, this.toolFileChanges.get(itemId));
        const metadata = { files };
        this.broadcastWire(failed ? 'session.tool.failed' : 'session.tool.success', {
          sessionID: threadId,
          assistantMessageID,
          id: itemId,
          ...(failed
            ? { error: status || 'File change failed' }
            : (() => {
              const content = files.map((change) => change.diff).filter(Boolean).join('\n');
              return { content: content ? [{ type: 'text', text: content }] : [] };
            })()),
          metadata,
          executed: true,
        }, undefined, completedAt);
      }
      this.toolAssistants.delete(itemId);
      this.toolOutputs.delete(itemId);
      this.toolFileChanges.delete(itemId);
      this.finalizedTools.delete(itemId);
      this.toolThreads.delete(itemId);
      for (const [processId, mappedItem] of this.toolProcesses) if (mappedItem === itemId) this.toolProcesses.delete(processId);
      return;
    }
    if (event.method === 'item/completed' && threadId && isJsonRecord(params.item) && String(params.item.type).toLowerCase() === 'agentmessage') {
      const itemId = typeof params.item.id === 'string' ? params.item.id : undefined;
      const current = this.turns.get(threadId);
      if (!current || (itemId && current.messageId !== itemId)) return;
      const completedAt = typeof params.completedAtMs === 'number' ? params.completedAtMs : Date.now();
      const finalText = typeof params.item.text === 'string' ? params.item.text : current.text;
      current.text = finalText;
      this.broadcastWire('session.text.ended', {
        sessionID: threadId,
        assistantMessageID: current.messageId,
        ordinal: 0,
        text: finalText,
      }, undefined, completedAt);
      this.broadcastWire('session.step.ended', {
        sessionID: threadId,
        assistantMessageID: current.messageId,
        finish: 'stop',
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      }, undefined, completedAt);
      return;
    }
    if (event.method === 'turn/completed' && threadId) {
      // A completed turn is the final lifecycle boundary. Some app-server
      // versions can omit an item/completed notification when the stream is
      // briefly interrupted, leaving the UI's tool timer running forever.
      // Settle any command/file item still associated with this turn so the
      // reducer receives the same terminal transition it would have received
      // from item/completed.
      for (const [itemId, itemThreadId] of this.toolThreads) {
        if (itemThreadId !== threadId || this.finalizedTools.has(itemId)) continue;
        const assistantMessageID = this.toolAssistants.get(itemId);
        if (!assistantMessageID) continue;
        const output = this.toolOutputs.get(itemId) ?? '';
        this.broadcastWire('session.tool.success', {
          sessionID: threadId,
          assistantMessageID,
          id: itemId,
          content: output ? [{ type: 'text', text: output }] : [],
          ...(this.toolFileChanges.has(itemId) ? { metadata: { files: this.toolFileChanges.get(itemId) } } : {}),
          executed: true,
        });
        this.finalizedTools.add(itemId);
      }
      this.activeTurnIds.delete(threadId);
      this.inflightTurnSessions.delete(threadId);
      const turn = isJsonRecord(params.turn) ? params.turn : {};
      const error = turn.error ?? this.pendingTurnErrors.get(threadId) ?? null;
      this.pendingTurnErrors.delete(threadId);
      if (error) {
        this.broadcastWire('session.execution.failed', { sessionID: threadId, error: codexErrorDetails(error) });
      } else {
        // `item/completed` only closes the assistant message. The turn itself
        // is the authoritative lifecycle boundary and must always settle the
        // session, including after a streamed response.
        this.broadcastWire('session.execution.succeeded', { sessionID: threadId });
      }
      this.turns.delete(threadId);
      return;
    }
    if (event.method === 'error') {
      const error = params.error ?? params;
      const errorThreadId = threadId || (this.inflightTurnSessions.size === 1 ? [...this.inflightTurnSessions][0] : undefined);
      // Codex explicitly marks recoverable model/transport errors with
      // willRetry. They are progress notifications, not terminal failures;
      // keeping them out of the UI error path preserves the official thinking
      // state while the retry produces the next stream event.
      if (params.willRetry === true) {
        if (errorThreadId) this.pendingTurnErrors.delete(errorThreadId);
        return;
      }
      // `error` can be an informational transport/model event immediately
      // before turn/completed. Hold it until that lifecycle boundary so a
      // transient lack of text is shown as thinking rather than failure.
      if (errorThreadId) this.pendingTurnErrors.set(errorThreadId, error);
      return;
    }
  }

  private rememberThreads(result: unknown, archived?: boolean): void {
    const values = isJsonRecord(result) && Array.isArray(result.data)
      ? result.data
      : [isJsonRecord(result) && isJsonRecord(result.thread) ? result.thread : result];
    for (const value of values) {
      if (!isJsonRecord(value) || typeof value.id !== 'string') continue;
      if (typeof value.cwd === 'string' && value.cwd) this.threadDirectories.set(value.id, value.cwd);
      if (typeof value.path === 'string' && value.path) this.threadPaths.set(value.id, value.path);
      this.threadMetadata.set(value.id, value);
      const wasReadOnly = this.readOnlyThreads.has(value.id);
      // Codex reports this explicitly for a persisted thread owned by another
      // app-server process. Remember it so the subsequent session GET can
      // decorate the record even when thread/read itself succeeds.
      if (value.canAcceptDirectInput === false) {
        this.readOnlyThreads.add(value.id);
        if (!this.ownershipErrors.has(value.id)) this.ownershipErrors.set(value.id, 'Codex 会话正在其他进程中使用');
      } else if (value.canAcceptDirectInput === true) {
        this.readOnlyThreads.delete(value.id);
        this.ownershipErrors.delete(value.id);
      }
      const isReadOnly = this.readOnlyThreads.has(value.id);
      if (wasReadOnly !== isReadOnly) {
        this.broadcastOwnershipMetadata(value.id, value);
      }
      // Execution status (idle/active) is independent from archive status.
      // Only a list explicitly queried with archived:false clears that flag.
      if (archived === true || (typeof value.path === 'string' && /[\\/]archived_sessions[\\/]/.test(value.path))) this.archivedThreads.add(value.id);
      else if (archived === false) this.archivedThreads.delete(value.id);
    }
  }

  private decorateSessionAccess(sessionID: string, session: Record<string, unknown>): void {
    const metadata = isJsonRecord(session.metadata) ? session.metadata : {};
    if (this.readOnlyThreads.has(sessionID)) {
      session.metadata = {
        ...metadata,
        codexReadOnly: true,
        ...(this.ownershipErrors.has(sessionID) ? { codexOwnershipError: this.ownershipErrors.get(sessionID) } : {}),
      };
    }
  }

  private broadcastOwnershipMetadata(sessionID: string, thread: Record<string, unknown>): void {
    const session = codexSessionInfo(thread);
    const base = session && isJsonRecord(session.metadata) ? session.metadata : {};
    const metadata = this.readOnlyThreads.has(sessionID)
      ? {
        ...base,
        codexReadOnly: true,
        ...(this.ownershipErrors.has(sessionID) ? { codexOwnershipError: this.ownershipErrors.get(sessionID) } : {}),
      }
      : Object.fromEntries(Object.entries(base).filter(([key]) => key !== 'codexReadOnly' && key !== 'codexOwnershipError'));
    this.broadcastWire('session.metadata.updated', { sessionID, metadata });
  }

  private broadcastWire(type: string, data: Record<string, unknown>, directory?: string, created = Date.now()): void {
    const payload = {
      id: `codex-${created}-${++this.sequence}`,
      type,
      created,
      location: { directory: directory || this.workingDirectoryFromThread(data.sessionID) },
      data,
    };
    const frame = `id: ${payload.id}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const client of this.clients) client.write(frame);
  }

  private workingDirectoryFromThread(sessionId: unknown): string {
    if (typeof sessionId === 'string') {
      const thread = this.threadDirectories.get(sessionId);
      if (thread) return thread;
    }
    return process.cwd();
  }

  private log(line: string): void {
    this.logger?.(`[CodexFacade] ${line}`);
  }
}
