export type CodexCapability =
  | 'thread/start' | 'thread/resume' | 'thread/list' | 'thread/read' | 'thread/archive'
  | 'thread/unarchive' | 'thread/fork' | 'thread/goal/get' | 'thread/goal/set' | 'thread/goal/clear'
  | 'thread/items/list' | 'thread/turns/list' | 'turn/start' | 'turn/steer' | 'turn/interrupt'
  | 'model/list' | 'review/start' | 'fs/readFile' | 'fs/writeFile' | 'fs/readDirectory'
  | 'thread/realtime/start' | 'thread/realtime/appendAudio' | 'thread/realtime/stop';

export type CapabilityMatrix = Record<CodexCapability, boolean> & { initialized: boolean; userAgent: string | null };

const METHODS: CodexCapability[] = [
  'thread/start', 'thread/resume', 'thread/list', 'thread/read', 'thread/archive', 'thread/unarchive', 'thread/fork',
  'thread/goal/get', 'thread/goal/set', 'thread/goal/clear', 'thread/items/list', 'thread/turns/list',
  'turn/start', 'turn/steer', 'turn/interrupt', 'model/list', 'review/start', 'fs/readFile', 'fs/writeFile',
  'fs/readDirectory', 'thread/realtime/start', 'thread/realtime/appendAudio', 'thread/realtime/stop',
];

export function emptyCapabilities(): CapabilityMatrix {
  return Object.fromEntries([...METHODS.map((method) => [method, false]), ['initialized', false], ['userAgent', null]]) as CapabilityMatrix;
}

export function probeCapabilities(supportedMethods: unknown, initialized: boolean, userAgent: string | null): CapabilityMatrix {
  const matrix = emptyCapabilities();
  matrix.initialized = initialized;
  matrix.userAgent = userAgent;
  if (Array.isArray(supportedMethods)) {
    for (const method of supportedMethods) {
      if (typeof method === 'string' && method in matrix) (matrix as Record<string, boolean | string | null>)[method] = true;
    }
  }
  // Current app-server does not advertise methods in initialize. A supported
  // initialize means these stable methods can be attempted and older servers
  // still downgrade naturally on a method-not-found response.
  if (initialized) for (const method of METHODS) matrix[method] = true;
  return matrix;
}
