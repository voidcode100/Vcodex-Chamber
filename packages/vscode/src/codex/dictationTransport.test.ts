import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, type Server } from 'node:http';
import { connect } from 'node:net';
import { gzipSync } from 'node:zlib';
import { createDictationFetch, resolveDictationProxy, parseWindowsProxy } from './dictationTransport';

// Bun's node:http shim does not implement the agent/signal behavior used by the
// extension host. Run these socket tests with `bun run test:dictation-transport`.
const nodeTest = 'Bun' in globalThis ? test.skip : test;

async function listen(server: Server): Promise<string> {
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>(done => server.close(() => done()));
}

test('proxy selection honors editor settings and NO_PROXY without exposing proxy credentials', () => {
  const url = new URL('https://chatgpt.com/backend-api/transcribe');
  const env = { HTTPS_PROXY: 'http://127.0.0.1:7890' };
  assert.equal(resolveDictationProxy(url, {}, env), 'http://127.0.0.1:7890/');
  assert.equal(resolveDictationProxy(url, { proxy: 'http://127.0.0.1:7891' }, env), 'http://127.0.0.1:7891/');
  assert.equal(resolveDictationProxy(url, { noProxy: '.chatgpt.com:443' }, env), undefined);
  assert.equal(resolveDictationProxy(url, { noProxy: 'otherchatgpt.com' }, env), 'http://127.0.0.1:7890/');
  assert.equal(resolveDictationProxy(new URL('http://[::1]:80'), { noProxy: '[::1]' }, { ALL_PROXY: env.HTTPS_PROXY }), undefined);
  assert.throws(() => resolveDictationProxy(url, { proxy: 'bad-password-value' }, {}), /代理地址无效/);
  assert.equal(parseWindowsProxy('127.0.0.1:7890'), 'http://127.0.0.1:7890');
  assert.equal(parseWindowsProxy('http=127.0.0.1:7891;https=127.0.0.1:7892'), 'http://127.0.0.1:7892');
  assert.equal(parseWindowsProxy('http=127.0.0.1:7891;https=127.0.0.1:7892', 'http:'), 'http://127.0.0.1:7891');
  assert.equal(parseWindowsProxy('socks=127.0.0.1:7893'), undefined);
});

nodeTest('real HTTP transport preserves multipart bytes, content length, response decompression and error headers', async () => {
  let received: Buffer | undefined;
  let length = '';
  let contentType = '';
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    length = req.headers['content-length'] ?? '';
    contentType = req.headers['content-type'] ?? '';
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      received = Buffer.concat(chunks);
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip', 'cf-ray': 'test-ray' });
      res.end(gzipSync(JSON.stringify({ text: '你好' })));
    });
  });
  const url = await listen(server);
  try {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/wav' }), 'dictation.wav');
    form.append('language', 'zh');
    const response = await createDictationFetch({ noProxy: '*' })(url, { method: 'POST', body: form });
    assert.deepEqual(await response.json(), { text: '你好' });
    assert.equal(response.headers.get('cf-ray'), 'test-ray');
    assert.match(contentType, /^multipart\/form-data; boundary=/);
    assert.equal(Number(length), received!.length);
    assert.ok(received!.includes(Buffer.from([1, 2, 3, 4])));
    assert.match(received!.toString(), /name="language"\r\n\r\nzh/);
  } finally { await close(server); }
});

nodeTest('CONNECT proxy forwards one request and does not automatically follow authenticated redirects', async () => {
  let targetRequests = 0;
  let proxyRequests = 0;
  const target = createServer((_req, res) => {
    targetRequests++;
    res.writeHead(302, { location: 'https://example.invalid/token-leak' }).end();
  });
  const url = await listen(target);
  const proxy = createServer();
  proxy.on('connect', (req, socket, head) => {
    proxyRequests++;
    const upstream = connect(Number(new URL(url).port), '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy());
    assert.equal(req.url, new URL(url).host);
  });
  const proxyUrl = await listen(proxy);
  try {
    const response = await createDictationFetch({ proxy: proxyUrl, noProxy: '' })(url, { method: 'POST', headers: { Authorization: 'Bearer test-only' }, body: 'audio' });
    assert.equal(response.status, 302);
    assert.equal(proxyRequests, 1);
    assert.equal(targetRequests, 1);
  } finally { await close(proxy); await close(target); }
});

nodeTest('cancel closes a pending request instead of waiting for transcription indefinitely', async () => {
  const controller = new AbortController();
  const server = createServer(() => controller.abort());
  const url = await listen(server);
  try {
    await assert.rejects(createDictationFetch({ noProxy: '*' })(url, { signal: controller.signal }), /abort/i);
  } finally { await close(server); }
});
