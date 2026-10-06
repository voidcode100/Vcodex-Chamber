// Browser regression for the shared login gate with the real host HTML/CSS.
// Does not sign out the user's account or initiate real authorization.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, relative, extname, sep } from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const { build } = createRequire(resolve('packages/vscode/package.json'))('esbuild');
const root = resolve('packages/vscode/dist/webview');
const htmlBundle = await build({ entryPoints: ['packages/vscode/src/webviewHtml.ts'], bundle: true, platform: 'node', format: 'cjs', write: false,
  plugins: [{ name: 'vscode-fixture', setup(builder) {
    builder.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `
      import { join } from 'node:path';
      export const Uri = { joinPath: (base, ...parts) => ({ fsPath: join(base.fsPath, ...parts) }) };
      export const ColorThemeKind = { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 };
      export const window = { activeColorTheme: { kind: 2 } };
      export const env = { language: 'zh-CN' };
    ` }));
  } }],
});
const hostModule = { exports: {} };
new Function('require', 'module', 'exports', htmlBundle.outputFiles[0].text)(require, hostModule, hostModule.exports);
const html = hostModule.exports.getWebviewHtml({
  webview: { cspSource: "'self'", asWebviewUri: uri => '/' + relative(root, uri.fsPath).split(sep).join('/') },
  extensionUri: { fsPath: resolve('packages/vscode') }, workspaceFolder: 'C:/workspace', initialStatus: 'connected', cliAvailable: true,
});
const gateBundle = await build({ entryPoints: ['packages/vscode/webview/authGate.ts'], bundle: true, platform: 'browser', format: 'esm', write: false });
const fixture = `
import { installCodexAuthGate } from '/gate.js';
window.mounts = 0; window.commands = []; window.connection = {status:'connected'};
document.getElementById('initial-loading').remove();
window.gate = installCodexAuthGate({language:'zh-CN',
 connection: () => window.connection,
 execute: async (command, ...args) => {
   window.commands.push({command,args});
   if (command === 'captureCodex.getAuthState') return {status:'login-required'};
   if (window.failCommand) throw Error(window.failCommand);
 },
 mount: async () => { window.mounts++; document.getElementById('root').innerHTML = '<textarea aria-label="聊天输入"></textarea>'; },
});`;
const mime = { '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.ttf': 'font/ttf' };
const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === '/' || pathname === '/production') {
    res.writeHead(200, { 'content-type': 'text/html' }).end(pathname === '/production' ? html.replace('"/assets/index.js"', '"/assets/index.js?production"') : html); return;
  }
  if ((pathname === '/assets/index.js' && !req.url.includes('?production')) || pathname === '/gate.js') {
    res.writeHead(200, { 'content-type': 'text/javascript' }).end(pathname === '/gate.js' ? gateBundle.outputFiles[0].text : fixture); return;
  }
  const file = resolve(root, '.' + pathname);
  if (!file.startsWith(root + sep)) { res.writeHead(403).end(); return; }
  try { const bytes = await readFile(file); res.writeHead(200, { 'content-type': mime[extname(file)] ?? 'application/octet-stream' }).end(bytes); }
  catch { res.writeHead(404).end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 360, height: 650 } });
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => {
      document.documentElement.style.cssText = '--vscode-editor-background:#181818;--vscode-foreground:#eee;--vscode-descriptionForeground:#aaa;--vscode-button-background:#e7e7e7;--vscode-button-hoverBackground:#fff;--vscode-button-foreground:#181818;--vscode-button-secondaryBackground:#303030;--vscode-button-secondaryHoverBackground:#393939;--vscode-button-secondaryForeground:#eee;--vscode-font-family:Segoe UI;--vscode-errorForeground:#f48771';
    });
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.locator('#codex-auth-login').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#root').isVisible(), false);
  assert.equal(await page.evaluate(() => window.mounts), 0, 'do not mount chat before auth');
  await page.locator('#codex-auth-login').click();
  assert.ok(await page.evaluate(() => window.commands.some(c => c.command === 'captureCodex.login')));
  const send = state => page.evaluate(state => window.postMessage({type:'codexAuth',state}, '*'), state);
  await send({status:'signing-in',loginId:'test',loginUrl:'https://auth.openai.com/test',userCode:'ABC-123'});
  await page.locator('#codex-auth-code').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#codex-auth-code').innerText(), 'ABC-123');
  await page.locator('#codex-auth-cancel').click();
  assert.ok(await page.evaluate(() => window.commands.some(c => c.command === 'captureCodex.cancelLogin')));
  await send({status:'login-required',error:'授权未完成'});
  await page.locator('#codex-auth-error').waitFor({state:'visible'});
  await page.locator('#codex-auth-device').click();
  assert.ok(await page.evaluate(() => window.commands.some(c => c.command === 'captureCodex.login' && c.args[0] === true)));
  await page.evaluate(() => { window.failCommand = '无法打开浏览器'; });
  await page.locator('#codex-auth-login').click();
  await page.waitForFunction(() => document.getElementById('codex-auth-error').textContent === '无法打开浏览器');
  await page.evaluate(() => { window.failCommand = ''; });
  await send({status:'authenticated',account:{type:'chatgpt'}});
  await page.getByRole('textbox', {name:'聊天输入'}).waitFor({state:'visible'});
  assert.equal(await page.locator('#codex-auth-gate').isVisible(), false);
  await send({status:'login-required'});
  await page.locator('#codex-auth-login').waitFor({state:'visible'});
  assert.equal(await page.getByRole('textbox', {name:'聊天输入'}).count(), 0, 'logout hides chat from the accessibility tree');
  assert.equal(await page.locator('#root').evaluate(el => el.inert), true);
  await send({status:'not-required'});
  await page.locator('#root').waitFor({state:'visible'});
  assert.equal(await page.evaluate(() => window.mounts), 1, 'provider without auth can use the existing chat root');
  await page.evaluate(() => { window.connection = {status:'error',error:'Codex stopped'}; window.dispatchEvent(new Event('openchamber:connection-status')); });
  await page.locator('#codex-auth-retry').waitFor({state:'visible'});
  assert.equal(await page.locator('#root').isVisible(), false);
  assert.equal(await page.locator('#codex-auth-error').innerText(), 'Codex stopped');
  await page.evaluate(() => { window.connection = {status:'connected'}; window.dispatchEvent(new Event('openchamber:connection-status')); });
  await send({status:'login-required'});
  await page.locator('#codex-auth-login').waitFor({state:'visible'});
  if (process.env.AUTH_SCREENSHOT) await page.screenshot({path:process.env.AUTH_SCREENSHOT});
  // Also execute the packaged main entry, not just the component fixture.
  await page.addInitScript(() => {
    window.acquireVsCodeApi = () => ({ postMessage(message) {
      if (message.type === 'webview:ready') {
        window.postMessage({type:'connectionStatus', status:'connected'}, '*');
        window.postMessage({type:'codexAuth', state:{status:'login-required'}}, '*');
      }
      if (message.id) {
        const data = message.type === 'vscode:command' ? {result:{status:'login-required'}} : {};
        window.postMessage({id:message.id,type:message.type,success:true,data}, '*');
      }
    }, getState: () => ({}), setState: () => {} });
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/production`);
  await page.locator('#codex-auth-login').waitFor({state:'visible'});
  assert.equal(await page.locator('#root').isVisible(), false);
  assert.equal(await page.locator('#root').evaluate(el => el.childNodes.length), 0, 'production main must delay the React mount');
  assert.deepEqual(errors, []);
  console.log('PASS: real host HTML/CSS, sign-in/device/cancel actions, errors, auto-entry, logout, no-auth provider, disconnection, no duplicate mount.');
} finally { await browser.close(); await new Promise(done => server.close(done)); }
