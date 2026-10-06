import * as https from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import selfsigned from 'selfsigned';
import type * as vscode from 'vscode';
import { certificateSha256Fingerprint, isPng, isValidCaptureId } from './captureProtocol';

export type CapturePayload = { id: string; monitor: string; batchId: string; sessionId?: string; bytes: Buffer };
export type CaptureRecord = Omit<CapturePayload, 'bytes' | 'sessionId'> & { sessionId: string; path: string };
export type VoiceFrame = { kind: 'start' | 'stop' | 'cancel'; sessionId?: string; requestId: string };
type Receipt = { state: 'submitting' | 'sent' | 'uncertain'; captureIds: string[]; sessionId: string; count: number };
type ReceiverState = { captures: CaptureRecord[]; receipts: Record<string, Receipt>; discarded: Record<string, string> };
type ReceiverOptions = {
  onCapture: (payload: CapturePayload) => Promise<{ sessionId: string; path: string }>;
  onBatchSend: (requestId: string, captures: CaptureRecord[]) => Promise<void>;
  onVoiceFrame: (frame: VoiceFrame) => Promise<{ sessionId?: string; transcript?: string } | void>;
  getStatus: () => Record<string, unknown>;
  onChanged?: () => void;
};

/** HTTPS receiver. The persisted manifest is an operational outbox, not a log. */
export class CaptureReceiver implements vscode.Disposable {
  private server?: https.Server;
  private voiceServer?: WebSocketServer;
  private fingerprint = '';
  private serial: Promise<unknown> = Promise.resolve();
  private voiceControls: Promise<unknown> = Promise.resolve();
  private readonly voiceRequests = new Map<string, { signature: string; task: Promise<unknown> }>();
  private state: ReceiverState = { captures: [], receipts: {}, discarded: {} };
  private loaded = false;
  constructor(private readonly context: Pick<vscode.ExtensionContext, 'globalStorageUri'>,
    private readonly output: Pick<vscode.OutputChannel, 'appendLine'>, private readonly options: ReceiverOptions) {}

  get running() { return Boolean(this.server?.listening); }
  async initialize() { await this.load(); }
  getCertificateFingerprint() { return this.fingerprint; }
  getPendingCaptures(sessionId?: string) { return this.state.captures.filter(c => !sessionId || c.sessionId === sessionId).map(c => ({ ...c })); }
  getUncertainRequest(captureId: string) { return Object.entries(this.state.receipts).find(([, r]) => r.state === 'uncertain' && r.captureIds.includes(captureId))?.[0]; }
  resolveUncertain(requestId: string, received: boolean) {
    return this.exclusive(async () => {
      const receipt = this.state.receipts[requestId];
      if (!receipt || receipt.state !== 'uncertain') throw new Error('没有待确认的提交。');
      if (received) { receipt.state = 'sent'; this.state.captures = this.state.captures.filter(c => !receipt.captureIds.includes(c.id)); }
      else delete this.state.receipts[requestId];
      await this.save();
    });
  }
  getStatus() {
    return { ...this.options.getStatus(), pendingBatches: new Set(this.state.captures.map(c => c.batchId)).size,
      pendingCaptures: this.state.captures.length, certificateSha256: this.fingerprint, receiverRunning: this.running,
      uncertainRequests: Object.values(this.state.receipts).filter(r => r.state !== 'sent').length };
  }
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.serial.then(operation);
    this.serial = task.catch(() => undefined);
    return task;
  }
  private get statePath() { return path.join(this.context.globalStorageUri.fsPath, 'capture-outbox.json'); }
  private async load() {
    if (this.loaded) return;
    try { this.state = JSON.parse(await fs.readFile(this.statePath, 'utf8')) as ReceiverState; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    this.state.discarded ??= {};
    for (const receipt of Object.values(this.state.receipts)) if (receipt.state === 'submitting') receipt.state = 'uncertain';
    this.loaded = true;
  }
  private async save() {
    await fs.mkdir(this.context.globalStorageUri.fsPath, { recursive: true });
    await fs.writeFile(this.statePath + '.tmp', JSON.stringify(this.state), { mode: 0o600 });
    await fs.rename(this.statePath + '.tmp', this.statePath);
    this.options.onChanged?.();
  }
  async start(address: string, port: number, token: string): Promise<string> {
    await this.stop();
    if (!token.trim()) throw new Error('请先设置配对令牌。');
    await this.load();
    const tls = await this.getCertificate();
    this.fingerprint = certificateSha256Fingerprint(tls.cert);
    const server = https.createServer(tls, (request, response) => {
      void this.handle(request, response, token).catch(error => {
        if (!response.headersSent) this.json(response, 409, { error: error instanceof Error ? error.message : String(error) });
        else response.end();
      });
    });
    this.server = server;
    this.voiceServer = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
    this.voiceServer.on('connection', socket => {
      socket.on('message', (data, binary) => {
        if (binary) { socket.send(JSON.stringify({ type: 'error', message: '只接受录音控制，音频由客户端采集。' })); return; }
        void this.handleVoiceMessage(socket, data.toString());
      });
      socket.on('error', () => undefined);
      socket.send(JSON.stringify({ type: 'ready', ...this.options.getStatus() }));
    });
    server.on('upgrade', (request, socket, head) => {
      if (request.url?.split('?')[0] !== '/v1/voice' || !this.authorize(request, token)) { socket.destroy(); return; }
      this.voiceServer?.handleUpgrade(request, socket, head, client => this.voiceServer?.emit('connection', client, request));
    });
    try {
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, address, () => { server.removeListener('error', reject); resolve(); }); });
      server.on('error', error => this.output.appendLine(`接收端错误：${error.message}`));
    } catch (error) { await this.stop(); throw error; }
    this.options.onChanged?.();
    return this.fingerprint;
  }
  private async getCertificate(): Promise<{ key: string; cert: string }> {
    const directory = this.context.globalStorageUri.fsPath;
    const keyPath = path.join(directory, 'receiver-key.pem'), certPath = path.join(directory, 'receiver-cert.pem');
    await fs.mkdir(directory, { recursive: true });
    try { return { key: await fs.readFile(keyPath, 'utf8'), cert: await fs.readFile(certPath, 'utf8') }; }
    catch {
      const pair = await selfsigned.generate([{ name: 'commonName', value: 'Vcodex-Chamber Receiver' }], { notAfterDate: new Date(Date.now() + 365 * 86400000), keySize: 2048, algorithm: 'sha256' });
      await fs.writeFile(keyPath, pair.private, { mode: 0o600 }); await fs.writeFile(certPath, pair.cert, { mode: 0o600 });
      return { key: pair.private, cert: pair.cert };
    }
  }
  private json(response: ServerResponse, status: number, value: unknown) { response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value)); }
  private async read(request: IncomingMessage, limit: number) {
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > limit) throw new Error('请求数据过大。');
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  private async handle(request: IncomingMessage, response: ServerResponse, token: string) {
    if (!this.authorize(request, token)) { this.json(response, 401, { error: '配对令牌无效。' }); return; }
    const url = request.url?.split('?')[0];
    if (request.method === 'GET' && url === '/v1/status') { this.json(response, 200, this.getStatus()); return; }
    if (request.method !== 'POST') { this.json(response, 404, { error: '未知接口。' }); return; }
    if (url === '/v1/capture/remove') {
      const body = JSON.parse((await this.read(request, 16384)).toString());
      this.json(response, 200, await this.removePending(body.captureIds, body.sessionId, body.mode)); return;
    }
    if (url === '/v1/capture/send') {
      const bytes = await this.read(request, 16384);
      const body = bytes.length ? JSON.parse(bytes.toString()) : {};
      const requestId = String(body.requestId || request.headers['x-request-id'] || request.headers['x-capture-batch-id'] || '');
      const result = await this.sendPending(requestId, body.captureIds, body.sessionId, String(body.batchId || request.headers['x-capture-batch-id'] || ''));
      this.json(response, 202, result); return;
    }
    if (url !== '/v1/capture') { this.json(response, 404, { error: '未知接口。' }); return; }
    const id = String(request.headers['x-capture-id'] || ''), batchId = String(request.headers['x-capture-batch-id'] || id);
    if (!isValidCaptureId(id) || !isValidCaptureId(batchId)) { this.json(response, 400, { error: '截图 ID 无效。' }); return; }
    const bytes = await this.read(request, 25 * 1024 * 1024);
    if (request.headers['content-type']?.split(';')[0] !== 'image/png' || !isPng(bytes)) { this.json(response, 415, { error: '仅支持 PNG 截图。' }); return; }
    const result = await this.exclusive(async () => {
      const pending = this.state.captures.find(c => c.id === id);
      const discarded = this.state.discarded[id];
      if (discarded) return { duplicate: true, discarded: true, id, sessionId: discarded };
      const receipt = Object.values(this.state.receipts).find(r => r.captureIds.includes(id));
      if (pending || receipt) return { duplicate: true, id, sessionId: pending?.sessionId || receipt?.sessionId, sent: receipt?.state === 'sent' };
      if (this.state.captures.length >= 100) throw new Error('客户端截图队列已满，请先发送。');
      const stored = await this.options.onCapture({ id, batchId, monitor: String(request.headers['x-monitor-name'] || 'display'),
        sessionId: typeof request.headers['x-target-session'] === 'string' ? request.headers['x-target-session'] : undefined, bytes });
      this.state.captures.push({ id, batchId, monitor: String(request.headers['x-monitor-name'] || 'display'), ...stored });
      await this.save();
      return { received: true, id, batchId, sessionId: stored.sessionId };
    });
    this.json(response, result.duplicate ? 200 : 201, result);
  }
  sendPending(requestId: string, captureIds?: string[], sessionId?: string, batchId?: string) {
    return this.exclusive(async () => {
      if (!isValidCaptureId(requestId)) throw new Error('发送请求必须包含唯一 requestId。');
      const receipt = this.state.receipts[requestId];
      if (receipt) {
        if (captureIds && JSON.stringify(receipt.captureIds) !== JSON.stringify(captureIds)) throw new Error('requestId 已用于另一组截图。');
        if (receipt.state === 'sent') return { sent: true, duplicate: true, count: receipt.count, sessionId: receipt.sessionId };
        throw new Error('上次提交结果尚未确认，请检查会话；队列保留，已阻止重复发送。');
      }
      if (captureIds !== undefined && (!Array.isArray(captureIds) || captureIds.some(id => !isValidCaptureId(id)))) throw new Error('截图列表无效。');
      const ids = captureIds ? new Set(captureIds) : undefined;
      if (ids?.size && [...ids].every(id => Object.values(this.state.receipts).some(r => r.state === 'sent' && r.captureIds.includes(id)))) {
        return { sent: true, duplicate: true, count: ids.size };
      }
      const captures = this.state.captures.filter(c => (!ids || ids.has(c.id)) && (!batchId || c.batchId === batchId) && (!sessionId || c.sessionId === sessionId));
      if (!captures.length) throw new Error('没有待发送截图。');
      if (ids && captures.length !== ids.size) throw new Error('部分截图尚未接收，保留队列后重试。');
      if (new Set(captures.map(c => c.sessionId)).size !== 1) throw new Error('截图属于不同会话，请分别在对应会话发送。');
      if (Object.values(this.state.receipts).some(r => r.state !== 'sent' && r.captureIds.some(id => captures.some(c => c.id === id)))) throw new Error('这些截图提交状态未确认，已阻止重复发送。');
      const staged: Receipt = { state: 'submitting', captureIds: captures.map(c => c.id), sessionId: captures[0].sessionId, count: captures.length };
      this.state.receipts[requestId] = staged; await this.save();
      try { await this.options.onBatchSend(requestId, captures); }
      catch (error) {
        if ((error as { uncertain?: boolean }).uncertain) staged.state = 'uncertain';
        else delete this.state.receipts[requestId];
        await this.save(); throw error;
      }
      staged.state = 'sent';
      this.state.captures = this.state.captures.filter(c => !staged.captureIds.includes(c.id));
      // Keep image files for Codex's delayed reads and persisted history.
      await this.save();
      return { sent: true, count: captures.length, sessionId: staged.sessionId };
    });
  }
  removePending(captureIds?: string[], sessionId?: string, mode: 'all' | 'last' = 'all') {
    return this.exclusive(async () => {
      if (mode !== 'all' && mode !== 'last') throw new Error('移除模式无效。');
      if (captureIds !== undefined && (!Array.isArray(captureIds) || captureIds.some(id => !isValidCaptureId(id)))) throw new Error('截图列表无效。');
      if (!sessionId || typeof sessionId !== 'string') throw new Error('移除截图需要目标会话。');
      const ids = captureIds && new Set(captureIds);
      let captures = this.state.captures.filter(c => c.sessionId === sessionId && (!ids || ids.has(c.id)));
      if (mode === 'last') captures = captures.slice(-1);
      const selected = new Set(captures.map(c => c.id));
      if (Object.values(this.state.receipts).some(r => r.state !== 'sent' && r.captureIds.some(id => selected.has(id)))) throw new Error('截图提交结果未确认，请先确认是否已收到，再移除。');
      // Also remember explicit IDs not yet uploaded, so an interrupted upload
      // or sender retry cannot bring a removed screenshot back.
      const markIds = mode === 'last' ? selected : ids || selected;
      for (const id of markIds) {
        const other = this.state.captures.find(c => c.id === id);
        if (other && other.sessionId !== sessionId) throw new Error('截图属于另一会话。');
        const receipt = Object.values(this.state.receipts).find(r => r.captureIds.includes(id));
        if (receipt && receipt.state !== 'sent') throw new Error('截图提交结果未确认。');
      }
      for (const id of markIds) if (!Object.values(this.state.receipts).some(r => r.captureIds.includes(id))) this.state.discarded[id] = sessionId;
      this.state.captures = this.state.captures.filter(c => !selected.has(c.id));
      await this.save();
      return { removed: captures.length, captureIds: [...selected], sessionId };
    });
  }
  private authorize(request: IncomingMessage, token: string) {
    const authorization = request.headers.authorization || '';
    const supplied = Buffer.from(authorization.startsWith('Bearer ') ? authorization.slice(7) : '');
    const expected = Buffer.from(token);
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  }
  private async handleVoiceMessage(socket: WebSocket, data: string) {
    let requestId: string | undefined;
    try {
      const value = JSON.parse(data) as { type: string; requestId: string; sessionId?: string };
      requestId = value.requestId;
      if (!['start', 'stop', 'cancel'].includes(value.type) || !isValidCaptureId(requestId)) throw new Error('录音控制消息或 requestId 无效。');
      const key = `${value.type}:${requestId}`, signature = JSON.stringify([value.type, value.sessionId || '']);
      let cached = this.voiceRequests.get(key);
      if (cached && cached.signature !== signature) throw new Error('请求 ID 已用于另一会话。');
      if (!cached) {
        const task = this.voiceControls.then(() => this.options.onVoiceFrame({ kind: value.type as VoiceFrame['kind'], requestId: value.requestId, sessionId: value.sessionId }));
        this.voiceControls = task.catch(() => undefined);
        cached = { signature, task }; this.voiceRequests.set(key, cached);
        void task.catch(() => { if (this.voiceRequests.get(key)?.task === task) this.voiceRequests.delete(key); });
        if (this.voiceRequests.size > 256) this.voiceRequests.delete(this.voiceRequests.keys().next().value!);
      }
      const result = await cached.task;
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ack', action: value.type, requestId, ...(result || {}) }));
    } catch (error) {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'error', requestId, message: error instanceof Error ? error.message : String(error) }));
    }
  }
  async stop() {
    for (const socket of this.voiceServer?.clients || []) socket.terminate();
    this.voiceServer?.close(); this.voiceServer = undefined;
    const server = this.server; this.server = undefined;
    if (server?.listening) await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    await this.serial;
  }
  dispose() { void this.stop(); }
}
