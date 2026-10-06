import '@/index.css';
import '@/styles/katex-css';
import './teleprompter.css';
import { renderMarkdownSync, renderMarkdownBlocks, decorateMarkdown, attachMarkdownInteractions, renderMermaidSVG, type DecorateContext } from '@/components/chat/markdown/standaloneMarkdown';
import { getMarkdownSyntaxVars } from '@/components/chat/markdown/markdownSyntaxVars';
import { iconSpriteData } from '@/components/icon/sprite';
import { readVSCodeThemePalette, buildVSCodeThemeFromPalette } from '@/lib/theme/vscode/adapter';
import { CSSVariableGenerator } from '@/lib/theme/cssGenerator';
import { getDefaultTheme } from '@/lib/theme/themes';
import { TeleprompterPlayback } from './teleprompterPlayback';
import { teleprompterDefaults, type TeleprompterSettings, type TeleprompterSnapshot } from '../src/teleprompterState';

declare const acquireVsCodeApi: () => { postMessage: (message: unknown) => void };
const bridge = acquireVsCodeApi();
// Use the same blob-worker loading path as the chat Webview.
Object.assign(window, { __VSCODE_CONFIG__: { workspaceFolder: '', theme: 'dark', connectionStatus: 'connected' } });
const stage = document.getElementById('stage')!;
const content = document.getElementById('text')!;
const status = document.getElementById('status')!;
const toggle = document.getElementById('toggle')!;
const inputs = {
  fontSize: document.getElementById('size') as HTMLInputElement,
  lineHeight: document.getElementById('line') as HTMLInputElement,
  speed: document.getElementById('speed') as HTMLInputElement,
};
let settings: TeleprompterSettings = { ...teleprompterDefaults };
let current: TeleprompterSnapshot | undefined;
let renderGeneration = 0;
let animation = 0;
const playback = new TeleprompterPlayback(stage);

const sprite = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
sprite.style.display = 'none';
sprite.innerHTML = Object.entries(iconSpriteData).map(([name, svg]) => `<symbol id="oc-${name}" viewBox="0 0 24 24">${svg}</symbol>`).join('');
document.body.append(sprite);

const themeGenerator = new CSSVariableGenerator();
function applyTheme() {
  const palette = readVSCodeThemePalette();
  const theme = palette ? buildVSCodeThemeFromPalette(palette) : getDefaultTheme(!document.body.classList.contains('vscode-light'));
  themeGenerator.apply(theme);
  for (const [key, value] of Object.entries(getMarkdownSyntaxVars(theme))) content.style.setProperty(key, value);
}
applyTheme();
new MutationObserver(applyTheme).observe(document.body, { attributes: true, attributeFilter: ['class', 'data-vscode-theme-id'] });

const decorateContext: DecorateContext = {
  labels: { copy: '复制代码', copied: '已复制', enableCodeWrap: '启用换行', disableCodeWrap: '关闭换行', copyTable: '复制表格', downloadTable: '下载表格', copyDiagram: '复制图表', downloadDiagram: '下载图表', zoomInDiagram: '放大', zoomOutDiagram: '缩小', resetDiagramView: '重置', previewLabel: '预览', previewTitle: '预览' },
  mermaidControls: { download: true, copy: true, showPanZoomControls: false },
  codeBlockLineWrap: true,
  renderMermaid: source => { try { return { svg: renderMermaidSVG(source) }; } catch { return {}; } },
  onToggleCodeBlockLineWrap: () => {
    decorateContext.codeBlockLineWrap = !decorateContext.codeBlockLineWrap;
    decorateMarkdown(content, decorateContext);
  },
};
attachMarkdownInteractions(content, decorateContext);

function updateControls() {
  toggle.textContent = playback.enabled ? '暂停滚动' : '开始滚动';
  toggle.setAttribute('aria-pressed', String(playback.enabled));
  status.textContent = playback.phase === 'streaming' ? '正在输出 · 固定顶部'
    : playback.phase === 'complete' ? (playback.enabled ? '循环滚动中' : '已暂停')
    : playback.phase === 'error' ? (current?.error || '输出中断') : '等待 Codex 输出';
}
function applySettings() {
  for (const key of Object.keys(inputs) as Array<keyof typeof inputs>) inputs[key].value = String(settings[key]);
  content.style.setProperty('--text-markdown', `${settings.fontSize}px`);
  content.style.setProperty('--text-code', `${settings.fontSize * .85}px`);
  content.style.fontSize = `${settings.fontSize}px`;
  content.style.lineHeight = String(settings.lineHeight);
  playback.speed = settings.speed;
  playback.enabled = settings.follow;
  updateControls();
}
function saveSettings() { settings.follow = playback.enabled; bridge.postMessage({ type: 'settings', settings }); }
for (const [key, input] of Object.entries(inputs) as Array<[keyof typeof inputs, HTMLInputElement]>) {
  input.addEventListener('change', () => {
    settings[key] = Math.max(Number(input.min), Math.min(Number(input.max), Number(input.value) || teleprompterDefaults[key]));
    applySettings(); saveSettings();
  });
}
toggle.addEventListener('click', () => { playback.enabled = !playback.enabled; updateControls(); saveSettings(); });
document.getElementById('clear')!.addEventListener('click', () => bridge.postMessage({ type: 'clear' }));
// Only actual user input pauses playback. Native scroll notifications never do.
const pause = () => { if (playback.phase === 'complete') { playback.enabled = false; updateControls(); saveSettings(); } };
document.addEventListener('wheel', event => {
  if (event.ctrlKey) {
    event.preventDefault();
    if (!event.deltaY) return;
    settings.fontSize = Math.max(12, Math.min(72, settings.fontSize + (event.deltaY < 0 ? 2 : -2)));
    settings.follow = playback.enabled;
    applySettings(); saveSettings();
  } else if (stage.contains(event.target as Node)) pause();
}, { passive: false });
stage.addEventListener('touchstart', pause, { passive: true });
stage.addEventListener('keydown', event => { if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) pause(); });
stage.addEventListener('scroll', () => { if (playback.phase === 'streaming' && stage.scrollTop !== 0) stage.scrollTop = 0; });

async function render(snapshot: TeleprompterSnapshot) {
  const previous = current;
  if (previous?.sessionId === snapshot.sessionId && previous?.revision === snapshot.revision && previous.text === snapshot.text && previous.phase === snapshot.phase) return;
  const generation = ++renderGeneration;
  current = snapshot;
  const newOutput = snapshot.phase === 'streaming' && previous?.phase !== 'streaming';
  if (newOutput || (snapshot.phase === 'complete' && snapshot.text && (!previous || previous.sessionId !== snapshot.sessionId || previous.text !== snapshot.text))) playback.enabled = true;
  // Stop before awaiting Shiki. New snapshots invalidate every outstanding render.
  playback.reset(snapshot.phase === 'complete' ? 'streaming' : snapshot.phase);
  updateControls();
  content.innerHTML = snapshot.text ? renderMarkdownSync(snapshot.text) : '<p>等待 Codex 输出…</p>';
  decorateMarkdown(content, decorateContext);
  stage.scrollTop = 0;
  try {
    const blocks = await renderMarkdownBlocks(snapshot.text, snapshot.phase === 'streaming');
    if (generation !== renderGeneration) return;
    if (snapshot.text) content.innerHTML = blocks.map(block => block.html).join('');
    decorateMarkdown(content, decorateContext);
    playback.reset(snapshot.phase);
    updateControls();
  } catch (error) {
    if (generation !== renderGeneration) return;
    playback.reset(snapshot.phase);
    updateControls();
    console.error('Teleprompter Markdown rendering failed', error);
  }
}
window.addEventListener('message', event => {
  const message = event.data;
  if (message?.type === 'settings') { settings = { ...settings, ...message.settings }; applySettings(); }
  if (message?.type === 'snapshot') void render(message);
});
function animate(now: number) {
  playback.frame(now);
  animation = requestAnimationFrame(animate);
}
applySettings();
animation = requestAnimationFrame(animate);
window.addEventListener('pagehide', () => cancelAnimationFrame(animation));
bridge.postMessage({ type: 'ready' });
