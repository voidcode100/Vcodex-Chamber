// Browser regression against the actual Vite output (including CSP, worker and CSS).
// Requires playwright; set NODE_PATH when using a bundled runtime installation.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { TeleprompterState } from '../packages/vscode/src/teleprompterState.ts';
const { chromium } = createRequire(import.meta.url)('playwright');
const root = resolve('packages/vscode/dist/webview');
const csp = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' https: data:; connect-src 'self'; worker-src 'self' blob:;";
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.wasm': 'application/wasm' };
const server = createServer(async (req, res) => {
  if (req.url === '/favicon.ico') { res.writeHead(204).end(); return; }
  const file = resolve(root, '.' + new URL(req.url, 'http://localhost').pathname);
  if (!file.startsWith(root + '/'.replace('/', process.platform === 'win32' ? '\\' : '/'))) { res.writeHead(403).end(); return; }
  try {
    let bytes = await readFile(file);
    if (file.endsWith('teleprompter.html')) bytes = Buffer.from(bytes.toString().replace('<head>', `<head><meta http-equiv="Content-Security-Policy" content="${csp}">`));
    res.writeHead(200, { 'content-type': mime[extname(file)] ?? 'application/octet-stream' }).end(bytes);
  } catch { console.error('Missing build asset:', req.url); res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  await page.addInitScript(() => {
    window.messages = [];
    window.acquireVsCodeApi = () => ({ postMessage: message => window.messages.push(message) });
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/teleprompter.html`);
  await page.waitForFunction(() => window.messages.some(m => m.type === 'ready'));
  let revision = 0;
  const send = (phase, text, sessionId = 's1') => page.evaluate(snapshot => window.postMessage(snapshot, '*'), { type: 'snapshot', revision: ++revision, phase, text, sessionId });
  const body = '# 测试标题\n\n**粗体** and *斜体* and `inline`\n\n1. first\n2. second\n\n> quote\n\n| name | value |\n| --- | --- |\n| a | b |\n\n```cpp\n#include <iostream>\nint main() { return 42; }\n```\n\n' + Array.from({ length: 25 }, (_, i) => `段落 ${i}：验证持续滚动。`).join('\n\n');
  await send('streaming', body);
  await page.waitForFunction(() => document.querySelector('#text pre.shiki span[style]'));
  assert.equal(await page.locator('#text h1').innerText(), '测试标题');
  assert.equal(await page.locator('#text strong').first().innerText(), '粗体');
  assert.equal(await page.locator('#text ol li').count(), 2);
  assert.equal(await page.locator('#text table tbody tr').count(), 1);
  assert.equal(await page.locator('#text blockquote').count(), 1);
  assert.ok(await page.locator('#text pre.shiki span[style]').count() > 0, 'real Shiki highlighting');
  assert.equal(await page.locator('#text [data-md-action="copy-code"]').count(), 1, 'shared code toolbar');
  if (process.env.TELEPROMPTER_SCREENSHOT) await page.screenshot({ path: process.env.TELEPROMPTER_SCREENSHOT });
  await page.clock.install();
  await page.clock.runFor(3000);
  assert.equal(await page.locator('#stage').evaluate(el => el.scrollTop), 0, 'hold top throughout streaming');
  await send('complete', body);
  await page.clock.runFor(200);
  await page.waitForFunction(() => document.querySelector('#status').textContent === '循环滚动中');
  await page.clock.runFor(2000);
  const first = await page.locator('#stage').evaluate(el => el.scrollTop);
  assert.ok(first > 30, `scroll must advance, was ${first}`);
  await page.clock.runFor(2000);
  assert.ok(await page.locator('#stage').evaluate(el => el.scrollTop) > first, 'native scroll events must not pause playback');
  await page.locator('#toggle').click();
  const paused = await page.locator('#stage').evaluate(el => el.scrollTop);
  await page.clock.runFor(2000);
  assert.equal(await page.locator('#stage').evaluate(el => el.scrollTop), paused, 'pause button');
  await page.locator('#toggle').click();
  const max = await page.locator('#stage').evaluate(el => el.scrollHeight - el.clientHeight);
  await page.clock.runFor(Math.ceil(max / 35 * 1000) + 1000);
  const loopPosition = await page.locator('#stage').evaluate(el => el.scrollTop);
  assert.ok(loopPosition < max / 2, 'must wrap at bottom');
  // Drive the second turn through the same reducer used by the extension host.
  const turns = new TeleprompterState('s1');
  const accept = (type, data = {}) => turns.accept({ type, data: { sessionID: 's1', ...data } });
  accept('session.execution.started');
  accept('session.text.delta', { assistantMessageID: 'first', delta: body });
  accept('session.execution.succeeded');
  accept('session.execution.started');
  await send(turns.snapshot.phase, turns.snapshot.text);
  await page.clock.runFor(100);
  assert.equal(await page.locator('#text pre').count(), 0, 'new turn clears previous code blocks');
  assert.equal(await page.locator('#text').innerText(), '等待 Codex 输出…');
  const nextBody = '# 第二轮独立回答\n\n' + Array.from({ length: 25 }, (_, i) => `新内容 ${i}：只显示这一轮。`).join('\n\n');
  accept('session.text.delta', { assistantMessageID: 'second', delta: nextBody });
  await send(turns.snapshot.phase, turns.snapshot.text);
  await page.clock.runFor(1000);
  assert.equal(await page.locator('#stage').evaluate(el => el.scrollTop), 0, 'new output interrupts scrolling');
  assert.equal(await page.locator('#text h1').innerText(), '第二轮独立回答');
  assert.ok(!(await page.locator('#text').innerText()).includes('测试标题'), 'previous answer must be gone');
  accept('session.execution.succeeded');
  await send(turns.snapshot.phase, turns.snapshot.text);
  await page.clock.runFor(2500);
  assert.ok(await page.locator('#stage').evaluate(el => el.scrollTop) > 20, 'new completion restarts playback');
  await send('complete', body, 's2');
  await page.clock.runFor(500);
  assert.equal(await page.locator('#text h1').count(), 1, 'snapshot replaces content on session switch');
  await page.evaluate(() => window.postMessage({ type: 'settings', settings: { speed: 100, fontSize: 36, lineHeight: 1.6, follow: true } }, '*'));
  await page.clock.runFor(100);
  assert.equal(await page.locator('#text').evaluate(el => getComputedStyle(el).fontSize), '36px');
  await page.locator('#stage').dispatchEvent('wheel', { ctrlKey: true, deltaY: -100 });
  assert.equal(await page.locator('#size').inputValue(), '38');
  assert.equal(await page.locator('#text').evaluate(el => getComputedStyle(el).fontSize), '38px');
  assert.equal(await page.locator('#toggle').getAttribute('aria-pressed'), 'true', 'Ctrl-wheel must not pause');
  await page.locator('#stage').dispatchEvent('wheel', { ctrlKey: true, deltaY: 100 });
  assert.equal(await page.locator('#size').inputValue(), '36');
  assert.ok(await page.evaluate(() => window.messages.some(m => m.type === 'settings' && m.settings.fontSize === 36)), 'zoom saved');
  const renderingErrors = await page.evaluate(() => window.messages.filter(m => m.type === 'error'));
  assert.deepEqual(renderingErrors, [], 'page rendering errors');
  assert.deepEqual(errors, [], 'browser console / CSP / worker errors');
  console.log('PASS: built Webview Markdown, Shiki, toolbar, top hold, continuous scroll, pause, loop, new output and session switch');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
