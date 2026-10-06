import { EventEmitter } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import type { JsonRpcId, JsonRpcNotification, JsonRpcRequest, JsonRpcResponse, JsonRpcServerRequest } from './protocol';

export type CodexTransportOptions = {
  binary?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  args?: string[];
  onLog?: (line: string) => void;
};

export type CodexTransportEvents = {
  spawn: (binary: string, pid: number | undefined) => void;
  notification: (notification: JsonRpcNotification) => void;
  serverRequest: (request: JsonRpcServerRequest) => void;
  exit: (code: number | null, signal: NodeJS.Signals | null) => void;
  close: () => void;
  error: (error: Error) => void;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

/** Official Codex app-server JSONL transport over child-process stdio. */
export class CodexTransport {
  private child: ChildProcessWithoutNullStreams | undefined;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly emitter = new EventEmitter();
  private nextId = 1;
  private terminalError: Error | undefined;

  constructor(private readonly options: CodexTransportOptions = {}) {}

  on<K extends keyof CodexTransportEvents>(event: K, listener: CodexTransportEvents[K]): void {
    this.emitter.on(event, listener as (...args: unknown[]) => void);
  }

  off<K extends keyof CodexTransportEvents>(event: K, listener: CodexTransportEvents[K]): void {
    this.emitter.off(event, listener as (...args: unknown[]) => void);
  }

  get running(): boolean {
    const child = this.child;
    return Boolean(child && child.exitCode === null && !child.killed && !child.stdin.destroyed);
  }

  get processPath(): string | undefined { return this.child?.spawnfile; }

  start(): void {
    if (this.running) return;
    const binary = this.options.binary || 'codex';
    const args = this.options.args ?? ['app-server'];
    const isWindowsShim = process.platform === 'win32' && /\.(cmd|bat)$/i.test(binary);
    const command = isWindowsShim ? (process.env.ComSpec || 'cmd.exe') : binary;
    const commandArgs = isWindowsShim ? ['/d', '/s', '/c', 'call', binary, ...args] : args;
    this.terminalError = undefined;
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(command, commandArgs, {
        cwd: this.options.cwd,
        env: { ...process.env, ...this.options.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.fail(failure);
      throw failure;
    }
    this.child = child;
    this.emitter.emit('spawn', binary, child.pid);

    const stdout = readline.createInterface({ input: child.stdout });
    stdout.on('line', (line) => this.handleLine(line));
    child.stdout.on('error', (error) => this.fail(error));
    child.stdin.on('error', (error) => this.fail(error));
    child.stderr.on('data', (chunk) => this.options.onLog?.(String(chunk).trimEnd()));
    child.on('error', (error) => this.fail(error));
    child.on('exit', (code, signal) => {
      const error = new Error(`Codex app-server exited (${code ?? 'unknown'}${signal ? `, ${signal}` : ''})`);
      this.rejectPending(error);
      if (this.child === child) this.child = undefined;
      this.emitter.emit('exit', code, signal);
    });
    child.on('close', () => {
      if (this.child === child) this.child = undefined;
      this.emitter.emit('close');
    });
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.child = undefined;
    this.rejectPending(new Error('Codex app-server stopped'));
    if (child.exitCode !== null || child.killed) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2000);
      child.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      try { child.kill(); } catch { resolve(); }
    });
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs = 60_000): Promise<T> {
    const child = this.child;
    if (!child || !this.running) return Promise.reject(this.terminalError ?? new Error('Codex app-server is not running'));
    const id = `${Date.now()}-${this.nextId++}-${randomUUID().slice(0, 8)}`;
    const message: JsonRpcRequest = { id, method, ...(params === undefined ? {} : { params }) };
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      try {
        child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
          if (error) this.rejectOne(id, error);
        });
      } catch (error) {
        this.rejectOne(id, error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  respond(id: JsonRpcId, result?: unknown, error?: { code?: number; message?: string; data?: unknown }): void {
    const child = this.child;
    if (!child || !this.running) return;
    const message: JsonRpcResponse = error ? { id, error } : { id, result };
    try { child.stdin.write(`${JSON.stringify(message)}\n`); } catch (writeError) { this.fail(writeError instanceof Error ? writeError : new Error(String(writeError))); }
  }

  notify(method: string, params?: unknown): void {
    const child = this.child;
    if (!child || !this.running) return;
    const message: JsonRpcNotification = { method, ...(params === undefined ? {} : { params }) };
    try { child.stdin.write(`${JSON.stringify(message)}\n`); } catch (writeError) { this.fail(writeError instanceof Error ? writeError : new Error(String(writeError))); }
  }

  private fail(error: Error): void {
    this.terminalError = error;
    this.rejectPending(error);
    this.emitter.emit('error', error);
  }

  private rejectOne(id: JsonRpcId, error: Error): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.reject(error);
  }

  private rejectPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message: unknown;
    try {
      message = JSON.parse(trimmed);
    } catch {
      this.options.onLog?.(`Ignoring non-JSON app-server output: ${trimmed}`);
      return;
    }
    if (!message || typeof message !== 'object') return;
    const record = message as Record<string, unknown>;
    if ('id' in record && ('result' in record || 'error' in record)) {
      const id = record.id as JsonRpcId;
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if (record.error && typeof record.error === 'object') {
        const raw = record.error as { message?: unknown; code?: unknown; data?: unknown };
        const message = typeof raw.message === 'string' && raw.message.trim()
          ? raw.message
          : 'Codex request failed';
        const error = Object.assign(new Error(message), {
          code: raw.code,
          data: raw.data,
          raw: record.error,
        });
        pending.reject(error);
      } else {
        pending.resolve(record.result);
      }
      return;
    }
    if (typeof record.method !== 'string') return;
    if ('id' in record) this.emitter.emit('serverRequest', record as unknown as JsonRpcServerRequest);
    else this.emitter.emit('notification', record as unknown as JsonRpcNotification);
  }
}
