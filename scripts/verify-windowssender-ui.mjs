import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const build = createRequire(resolve('packages/vscode/package.json'))('esbuild').build;
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV4cAAAAASUVORK5CYII=';
const fixture = `import React from 'react'; import { createRoot } from 'react-dom/client';
import { WindowsSenderQueue } from './packages/ui/src/components/chat/WindowsSenderQueue';
import { WindowsSenderSettings } from './packages/ui/src/components/sections/openchamber/WindowsSenderSettings';
window.commands=[]; window.errors=[]; window.captures=[{id:'capture-1',monitor:'display-a',preview:'${png}',sessionId:'a'},{id:'capture-2',monitor:'display-b',preview:'${png}',sessionId:'a'}];
window.config={receiverEnabled:false,receiverAddress:'0.0.0.0',receiverPort:43127,receiverToken:'test-token',certificateSha256:'AA:BB',targetMode:'active',targetSessionId:'',status:{connection:'connected',auth:'authenticated',target:{sessionId:'a'},pendingCaptures:2}};
window.senderRuntime={runtime:{isVSCode:true},vscode:{executeCommand:async(command,...args)=>{
 window.commands.push({command,args});
 if(command==='captureCodex.getPendingCaptures')return window.captures.filter(c=>c.sessionId===args[0]);
 if(command==='captureCodex.sendPendingCaptures'){if(window.failSend)throw Error('会话忙，保留截图');window.captures=window.captures.filter(c=>c.sessionId!==args[0]);window.postMessage({type:'captureCodex.queueChanged'},'*');return {sent:true};}
 if(command==='captureCodex.resolveUncertainCapture'){window.captures=args[1]?window.captures.filter(c=>c.uncertainRequestId!==args[0]):window.captures.map(c=>({...c,uncertainRequestId:undefined}));window.postMessage({type:'captureCodex.queueChanged'},'*');return;}
 if(command==='captureCodex.removePendingCaptures'){if(window.failRemove)throw Error('移除失败');window.captures=window.captures.filter(c=>c.sessionId!==args[0]||!args[1].includes(c.id));window.postMessage({type:'captureCodex.queueChanged'},'*');return;}
 if(command==='captureCodex.getWindowsSenderSettings')return window.config;
 if(command==='captureCodex.getReceiverStatus')return window.config.status;
 if(command==='captureCodex.updateWindowsSenderSettings'){window.config={...window.config,...args[0]};return window.config;}
 if(command==='captureCodex.toggleReceiver')window.config.receiverEnabled=!window.config.receiverEnabled;
}}};
const root=createRoot(document.getElementById('root')); window.show=(mode,sessionId='a')=>root.render(mode==='queue'?React.createElement(WindowsSenderQueue,{sessionId,onShowPopup:value=>window.preview=value}):React.createElement(WindowsSenderSettings)); window.show('queue');`;
const stubs = {
 '@/hooks/useRuntimeAPIs': 'export const useRuntimeAPIs=()=>window.senderRuntime;',
 '@/lib/i18n': 'export const useI18n=()=>({t:(key)=>key});',
 '@/lib/desktop': 'export const isVSCodeRuntime=()=>true; export const isDesktopShell=()=>false; export const getDesktopHomeDirectory=()=>null;',
 '@/stores/useUIStore': 'export const useUIStore=selector=>selector({});',
 '@/stores/useDirectoryStore': 'export const useDirectoryStore=selector=>selector({});',
 '@/sync/input-store': 'export const useInputStore=selector=>selector({attachedFiles:[],removeAttachedFile:()=>{}});',
 '@/components/ui': 'export const toast={error:message=>window.errors.push(message),success:()=>{}};',
 '@/components/icon/Icon': 'export const Icon=()=>null;',
 '@/components/icons/FileTypeIcon': 'export const FileTypeIcon=()=>null;',
};
const result = await build({ stdin: { contents: fixture, resolveDir: process.cwd(), sourcefile: 'sender-ui-fixture.tsx', loader: 'tsx' },
 bundle: true, platform: 'browser', format: 'esm', write: false, alias: { '@': resolve('packages/ui/src') },
 plugins: [{ name:'host-fixture',setup(builder){builder.onResolve({filter:/.*/},args=>args.path in stubs?{path:args.path,namespace:'fixture'}:undefined);builder.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:stubs[args.path],loader:'js'}));}}] });
const css=Buffer.concat(await Promise.all(['renderVSCodeApp.css','cssGenerator.css'].map(file=>readFile('packages/vscode/dist/webview/assets/'+file))));
const server=createServer((req,res)=>{if(req.url==='/main.js')res.writeHead(200,{'content-type':'text/javascript'}).end(result.outputFiles[0].text);else if(req.url==='/style.css')res.writeHead(200,{'content-type':'text/css'}).end(css);else res.writeHead(200,{'content-type':'text/html'}).end('<html><head><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script type="module" src="/main.js"></script></body></html>');});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
const browser=await chromium.launch({headless:true,channel:process.platform==='win32'?'msedge':undefined});
try{
 const page=await browser.newPage();const errors=[];page.on('pageerror',error=>errors.push(String(error)));
 await page.goto(`http://127.0.0.1:${server.address().port}`);
 await page.waitForFunction(()=>document.querySelectorAll('[data-windowssender-queue] img').length===2);
 assert.equal(await page.locator('[data-windowssender-queue] button[title]').count(),2,'every screenshot must have a remove button');
 await page.locator('[data-windowssender-queue] img').first().click();await page.waitForFunction(()=>window.preview?.image?.gallery?.length===2);
 await page.evaluate(()=>window.failRemove=true);await page.locator('[data-windowssender-queue] button[title]').first().click();await page.waitForFunction(()=>window.errors.includes('移除失败'));
 assert.equal(await page.locator('[data-windowssender-queue] img').count(),2);
 await page.evaluate(()=>window.failRemove=false);await page.locator('[data-windowssender-queue] button[title]').first().click();await page.waitForFunction(()=>document.querySelectorAll('[data-windowssender-queue] img').length===1);
 assert.equal(await page.evaluate(()=>window.commands.filter(c=>c.command==='captureCodex.removePendingCaptures').at(-1).args[0]),'a');
 await page.getByRole('button',{name:'清空截图'}).click();await page.waitForFunction(()=>!document.querySelector('[data-windowssender-queue]'));
 await page.evaluate(preview=>{window.captures=[{id:'send-1',monitor:'a',preview,sessionId:'a'},{id:'send-2',monitor:'b',preview,sessionId:'a'}];window.postMessage({type:'captureCodex.queueChanged'},'*');},png);
 await page.waitForFunction(()=>document.querySelectorAll('[data-windowssender-queue] img').length===2);
 await page.evaluate(()=>window.failSend=true);await page.getByRole('button',{name:'发送全部截图'}).click();await page.waitForFunction(()=>window.errors.length>0);
 assert.equal(await page.locator('[data-windowssender-queue] img').count(),2);
 await page.evaluate(()=>window.failSend=false);await page.getByRole('button',{name:'发送全部截图'}).click();await page.waitForFunction(()=>!document.querySelector('[data-windowssender-queue]'));
 await page.evaluate(preview=>{window.captures=[{id:'new',monitor:'display',preview,sessionId:'b'}];window.show('queue','b');},png);
 await page.waitForFunction(()=>document.querySelectorAll('[data-windowssender-queue] img').length===1);
 assert.ok((await page.evaluate(()=>window.commands.filter(c=>c.command==='captureCodex.sendPendingCaptures'))).every(c=>c.args[0]==='a'));
 await page.evaluate(()=>{window.captures[0].uncertainRequestId='uncertain-request';window.postMessage({type:'captureCodex.queueChanged'},'*');});
 await page.getByRole('button',{name:'确认未收到，允许重试'}).waitFor();
 assert.equal(await page.getByRole('button',{name:'发送全部截图'}).isDisabled(),true);
 await page.getByRole('button',{name:'确认未收到，允许重试'}).click();
 await page.waitForFunction(()=>!document.querySelector('button[disabled]'));
 assert.equal(await page.locator('[data-windowssender-queue] img').count(),1);
 await page.evaluate(()=>{window.captures[0].uncertainRequestId='uncertain-received';window.postMessage({type:'captureCodex.queueChanged'},'*');});
 await page.getByRole('button',{name:'确认已收到，清除队列'}).click();await page.waitForFunction(()=>!document.querySelector('[data-windowssender-queue]'));
 await page.evaluate(()=>window.show('settings'));await page.getByRole('button',{name:'保存并应用'}).waitFor();
 const port=page.locator('input[type=number]');await port.fill('0');await page.getByRole('button',{name:'保存并应用'}).click();await page.waitForFunction(()=>window.errors.some(e=>e.includes('端口')));
 await port.fill('43127');await page.getByRole('button',{name:'启动接收端'}).click();await page.getByRole('button',{name:'停止接收端'}).waitFor();
 await page.getByRole('button',{name:'麦克风 / 听写设置'}).click();await page.getByRole('button',{name:'打开提词器',exact:true}).click();
 assert.ok(await page.evaluate(()=>window.commands.some(c=>c.command==='captureCodex.configureVoice')));
 assert.ok(await page.evaluate(()=>window.commands.some(c=>c.command==='captureCodex.openPrompter')));
 assert.deepEqual(errors,[]);console.log('PASS: actual queue/ImagePreview rendering, gallery, failure retention, send, uncertain receipt resolution, session switch and settings actions');
}finally{await browser.close();server.closeAllConnections();await new Promise(done=>server.close(done));}
