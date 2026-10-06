export type JsonRpcId = string | number;

export type JsonRpcRequest = {
  id: JsonRpcId;
  method: string;
  params?: unknown;
};

export type JsonRpcResponse = {
  id: JsonRpcId;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

export type JsonRpcNotification = { method: string; params?: unknown };

export type JsonRpcServerRequest = JsonRpcNotification & { id: JsonRpcId };

export function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function getString(value: unknown, key: string): string | undefined {
  if (!isJsonRecord(value)) return undefined;
  const candidate = value[key];
  return typeof candidate === 'string' ? candidate : undefined;
}
