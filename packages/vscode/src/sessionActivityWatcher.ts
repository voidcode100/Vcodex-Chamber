import type { OpenCodeManager } from './opencode';

// Session activity tracking (mirrors web server and desktop behavior)
type ActivityPhase = 'idle' | 'busy' | 'cooldown';

interface SessionActivity {
  sessionId: string;
  phase: ActivityPhase;
}

const sessionActivityPhases = new Map<string, { phase: ActivityPhase; updatedAt: number }>();
const sessionActivityCooldowns = new Map<string, NodeJS.Timeout>();
const SESSION_COOLDOWN_DURATION_MS = 2000;

let globalEventWatcherAbortController: AbortController | null = null;
let chatViewProvider: { postMessage: (message: unknown) => void } | null = null;
let globalEventWatcherRetryTimer: NodeJS.Timeout | null = null;
let globalEventWatcherStartToken = 0;

const clearGlobalEventWatcherRetry = (): void => {
  if (!globalEventWatcherRetryTimer) {
    return;
  }
  clearTimeout(globalEventWatcherRetryTimer);
  globalEventWatcherRetryTimer = null;
};

const setSessionActivityPhase = (sessionId: string, phase: ActivityPhase): void => {
  if (!sessionId) return;

  const existingTimer = sessionActivityCooldowns.get(sessionId);
  if (existingTimer) {
    clearTimeout(existingTimer);
    sessionActivityCooldowns.delete(sessionId);
  }

  const current = sessionActivityPhases.get(sessionId);
  if (current?.phase === phase) return;

  sessionActivityPhases.set(sessionId, { phase, updatedAt: Date.now() });

  chatViewProvider?.postMessage({
    type: 'openchamber:session-activity',
    properties: {
      sessionId,
      phase,
    },
  });

  if (phase === 'cooldown') {
    const timer = setTimeout(() => {
      const now = sessionActivityPhases.get(sessionId);
      if (now?.phase === 'cooldown') {
        sessionActivityPhases.set(sessionId, { phase: 'idle', updatedAt: Date.now() });
        chatViewProvider?.postMessage({
          type: 'openchamber:session-activity',
          properties: {
            sessionId,
            phase: 'idle',
          },
        });
      }
      sessionActivityCooldowns.delete(sessionId);
    }, SESSION_COOLDOWN_DURATION_MS);
    sessionActivityCooldowns.set(sessionId, timer);
  }
};

export const getSessionActivitySnapshot = (): Record<string, { type: ActivityPhase }> => {
  const snapshot: Record<string, { type: ActivityPhase }> = {};
  for (const [sessionId, data] of sessionActivityPhases.entries()) {
    snapshot[sessionId] = { type: data.phase };
  }
  return snapshot;
};

/**
 * Live activity comes from the live channel only.
 *
 * `session.execution.*` is the signal that matters: a normal OpenCode 2.x turn
 * emits started → succeeded and NO `session.status` or `session.idle` at all, so
 * anything waiting on those would never see the session go busy. The two status
 * events are still handled because they do arrive outside a normal turn (retry,
 * explicit status pushes) and they are cheap to honour.
 *
 * A finished run passes through `cooldown` so the UI does not flip the indicator
 * off the instant the last token lands.
 */
type CodexEvent = { method?: unknown; params?: unknown; type?: unknown; properties?: unknown; data?: unknown };

const deriveSessionActivity = (event: CodexEvent): SessionActivity | null => {
  // CodexFacade emits the OpenChamber-compatible `{ type, properties }`
  // envelope even though the underlying transport is Codex JSON-RPC.
  const method = typeof event.method === 'string'
    ? event.method
    : (typeof event.type === 'string' ? event.type : '');
  const rawParams = event.params ?? event.properties ?? event.data;
  const params = rawParams && typeof rawParams === 'object' ? rawParams as Record<string, unknown> : {};
  const sessionId = typeof params.threadId === 'string'
    ? params.threadId
    : (typeof params.sessionID === 'string' ? params.sessionID : '');
  if (!sessionId) return null;
  if (method.includes('started')) return { sessionId, phase: 'busy' };
  if (method.includes('completed') || method.includes('succeeded')) return { sessionId, phase: 'cooldown' };
  if (method.includes('failed') || method.includes('interrupted') || method.includes('stopped')) {
    return { sessionId, phase: 'idle' };
  }
  return null;
};

export const startGlobalEventWatcher = async (
  manager: OpenCodeManager,
  provider: { postMessage: (message: unknown) => void }
): Promise<void> => {
  if (globalEventWatcherAbortController) {
    return;
  }

  const startToken = ++globalEventWatcherStartToken;
  clearGlobalEventWatcherRetry();
  chatViewProvider = provider;

  globalEventWatcherAbortController = new AbortController();
  const signal = globalEventWatcherAbortController.signal;

  let attempt = 0;

  const run = async (): Promise<void> => {
    while (!signal.aborted) {
      attempt += 1;

      try {
        const baseUrl = manager.getApiUrl();
        if (!baseUrl) throw new Error('Codex facade URL not available');
        const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/event`, {
          headers: { Accept: 'text/event-stream' },
          signal,
        });
        if (!response.ok || !response.body) throw new Error(`Codex event stream failed (${response.status})`);
        attempt = 0;
        console.log('[VSCode:Activity] Codex event stream connected');
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (!signal.aborted) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          const records = buffer.split(/\r?\n\r?\n/);
          buffer = records.pop() || '';
          for (const record of records) {
            const data = record.split(/\r?\n/).find((line) => line.startsWith('data:'))?.slice(5).trim();
            if (!data) continue;
            try {
              const activity = deriveSessionActivity(JSON.parse(data) as CodexEvent);
              if (activity) setSessionActivityPhase(activity.sessionId, activity.phase);
            } catch {
              // Ignore keep-alive frames and malformed events.
            }
          }
        }
        reader.releaseLock();
      } catch (error) {
        if (signal.aborted) {
          return;
        }
        console.warn('[VSCode:Activity] disconnected', error instanceof Error ? error.message : error);
      }

      const backoffMs = Math.min(1000 * Math.pow(2, Math.min(attempt, 5)), 30000);
      await new Promise(r => setTimeout(r, backoffMs));
    }
  };

  void run();
};

export const stopGlobalEventWatcher = (): void => {
  globalEventWatcherStartToken += 1;
  clearGlobalEventWatcherRetry();

  if (globalEventWatcherAbortController) {
    try {
      globalEventWatcherAbortController.abort();
    } catch {
      // ignore
    }
  }
  globalEventWatcherAbortController = null;
  chatViewProvider = null;

  for (const timer of sessionActivityCooldowns.values()) {
    clearTimeout(timer);
  }
  sessionActivityCooldowns.clear();
  sessionActivityPhases.clear();
};

export const setChatViewProvider = (provider: { postMessage: (message: unknown) => void } | null): void => {
  chatViewProvider = provider;
};
