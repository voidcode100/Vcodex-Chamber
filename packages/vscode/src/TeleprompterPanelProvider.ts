import * as vscode from 'vscode';
import { readFileSync } from 'node:fs';
import type { OpenCodeManager } from './opencode';
import { openSseProxy } from './sseProxy';
import { consumeSseFrames } from './teleprompterSse';
import { TeleprompterState, teleprompterDefaults, type TeleprompterSettings } from './teleprompterState';

export class TeleprompterPanelProvider implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private stream?: AbortController;
  private state = new TeleprompterState();
  private settings: TeleprompterSettings;
  private webviewReady = false;
  private flushTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly context: vscode.ExtensionContext, private readonly manager: OpenCodeManager) {
    this.settings = { ...teleprompterDefaults, ...context.workspaceState.get<Partial<TeleprompterSettings>>('captureCodex.teleprompter') };
  }

  createOrShow(sessionId?: string, title = 'Codex Teleprompter'): void {
    const target = sessionId?.trim() || undefined;
    if (this.panel) {
      if (target !== this.state.snapshot.sessionId) this.state = new TeleprompterState(target);
      this.panel.title = title;
      this.panel.reveal(vscode.ViewColumn.Beside);
      this.flush();
      return;
    }
    this.state = new TeleprompterState(target);
    this.webviewReady = false;
    const root = vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview');
    const panel = vscode.window.createWebviewPanel('openchamber.teleprompter', title, vscode.ViewColumn.Beside, {
      enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [root],
    });
    this.panel = panel;
    // Register before HTML assignment so even a fast page retains the handshake.
    panel.webview.onDidReceiveMessage((message) => {
      if (!message || typeof message !== 'object') return;
      if (message.type === 'ready') {
        this.webviewReady = true;
        void panel.webview.postMessage({ type: 'settings', settings: this.settings });
        this.flush();
      } else if (message.type === 'settings' && message.settings) {
        const s = message.settings;
        for (const [key, min, max] of [['speed', 1, 200], ['fontSize', 12, 72], ['lineHeight', 1, 2.5]] as const) {
          if (typeof s[key] === 'number' && Number.isFinite(s[key])) this.settings[key] = Math.min(max, Math.max(min, s[key]));
        }
        if (typeof s.follow === 'boolean') this.settings.follow = s.follow;
        void this.context.workspaceState.update('captureCodex.teleprompter', this.settings);
      } else if (message.type === 'clear') {
        this.state = new TeleprompterState(this.state.snapshot.sessionId);
        this.flush();
      }
    }, undefined, this.context.subscriptions);
    panel.onDidDispose(() => this.disposePanel(), undefined, this.context.subscriptions);
    panel.webview.html = this.html(panel.webview, root);
    this.startStream();
  }

  private startStream(): void {
    this.stream?.abort();
    const controller = new AbortController();
    this.stream = controller;
    let buffer = '';
    void openSseProxy({ manager: this.manager, path: '/api/event', signal: controller.signal,
      onChunk: (chunk) => {
        if (controller.signal.aborted) return;
        const consumed = consumeSseFrames(buffer, chunk);
        buffer = consumed.buffer;
        for (const frame of consumed.frames) {
          const json = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
          if (!json) continue;
          try {
            const event = JSON.parse(json);
            if (!this.state.accept(event)) continue;
            // Retain full content AND phase until ready; coalesce streaming updates.
            this.flushTimer ??= setTimeout(() => { this.flushTimer = undefined; this.flush(); }, 32);
          } catch { /* Ignore malformed SSE frames. */ }
        }
      },
    }).then(result => result.run).catch(error => {
      if (controller.signal.aborted) return;
      this.state.snapshot = { ...this.state.snapshot, revision: this.state.snapshot.revision + 1, phase: 'error', error: String(error) };
      this.flush();
    });
  }

  private flush(): void {
    if (!this.webviewReady || !this.panel) return;
    void this.panel.webview.postMessage(this.state.snapshot);
  }

  private html(webview: vscode.Webview, root: vscode.Uri): string {
    const html = readFileSync(vscode.Uri.joinPath(root, 'teleprompter.html').fsPath, 'utf8');
    const source = webview.cspSource;
    const csp = `default-src 'none'; script-src ${source} 'wasm-unsafe-eval'; style-src ${source} 'unsafe-inline'; font-src ${source} data:; img-src ${source} https: data:; connect-src ${source}; worker-src ${source} blob:;`;
    return html.replace('<head>', `<head><meta http-equiv="Content-Security-Policy" content="${csp}">`)
      .replace(/(src|href)="\.\/([^"\s]+)"/g, (_, attr, file) => `${attr}="${webview.asWebviewUri(vscode.Uri.joinPath(root, file))}"`);
  }

  private disposePanel(): void {
    this.stream?.abort(); this.stream = undefined;
    clearTimeout(this.flushTimer); this.flushTimer = undefined;
    this.panel = undefined; this.webviewReady = false;
  }
  dispose(): void { this.panel?.dispose(); this.disposePanel(); }
}
