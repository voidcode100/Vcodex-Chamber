import * as vscode from 'vscode';
import * as os from 'os';
import { webviewStyles } from './webviewStyles';
import { getThemeKindName } from './theme';
import type { ConnectionStatus } from './opencode';
import type { WorkspaceFolderCandidate } from './workspaceResolver';

export interface WebviewHtmlOptions {
  webview: vscode.Webview;
  extensionUri: vscode.Uri;
  workspaceFolder: string;
  workspaceFolders?: WorkspaceFolderCandidate[];
  initialStatus: ConnectionStatus;
  cliAvailable: boolean;
  initialSessionId?: string;
  /** A new-session editor tab that opens its draft in "Run on several models" mode. */
  initialComposer?: 'parallel';
  viewMode?: 'sidebar' | 'editor';
  devServerUrl?: string | null;
  extensionVersion?: string;
}

const asCspToken = (value: string | null | undefined): string | null => {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const toOrigin = (value: string | null | undefined): string | null => {
  if (!value) {
    return null;
  }
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
};

const uniqueTokens = (values: Array<string | null | undefined>): string => {
  return Array.from(new Set(values.map(asCspToken).filter((value): value is string => Boolean(value)))).join(' ');
};

export function getWebviewHtml(options: WebviewHtmlOptions): string {
  const {
    webview,
    extensionUri,
    workspaceFolder,
    workspaceFolders = [],
    initialStatus,
    cliAvailable,
    initialSessionId,
    initialComposer,
    viewMode = 'sidebar',
    devServerUrl,
    extensionVersion = '',
  } = options;
  const workspaceFoldersJson = JSON.stringify(workspaceFolders).replace(/</g, '\\u003c');

  const scriptPath = vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'assets', 'index.js');
  const scriptUri = webview.asWebviewUri(scriptPath);
  // Vite emits the app entry as a stable chunk name. Preloading it removes a
  // request waterfall between the small bootstrap and the React application.
  const renderChunkPath = vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'assets', 'renderVSCodeApp.js');
  const renderChunkUri = webview.asWebviewUri(renderChunkPath);
  const normalizedDevServerUrl = asCspToken(devServerUrl)?.replace(/\/$/, '') ?? null;
  const devServerOrigin = toOrigin(normalizedDevServerUrl);
  const styleSrc = uniqueTokens([webview.cspSource, "'unsafe-inline'", devServerOrigin]);
  const scriptSrc = uniqueTokens([webview.cspSource, "'unsafe-inline'", "'unsafe-eval'", devServerOrigin]);
  const connectSrc = uniqueTokens(['*', 'ws:', 'wss:', 'http:', 'https:', devServerOrigin]);
  const imgSrc = uniqueTokens([webview.cspSource, 'data:', 'https:', devServerOrigin]);
  const fontSrc = uniqueTokens([webview.cspSource, 'data:', devServerOrigin]);
  // fflate's async browser inflater creates blob-backed workers. Keep blob:
  // scoped to worker-src so document decompression works without allowing blob scripts.
  const workerSrc = uniqueTokens([webview.cspSource, 'blob:', devServerOrigin]);

  const themeKind = getThemeKindName(vscode.window.activeColorTheme.kind);

  // Use VS Code CSS variables for proper theme integration
  // These variables are automatically provided by VS Code to webviews
  // 
  // Logo geometry matches OpenChamberLogo.tsx:
  // edge=48, cos30=0.866, sin30=0.5, centerY=50
  // top=(50, 2), left=(8.432, 26), right=(91.568, 26), center=(50, 50)
  // bottomLeft=(8.432, 74), bottomRight=(91.568, 74), bottom=(50, 98)
  // topFaceCenterY = (2 + 26 + 50 + 26) / 4 = 26
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${styleSrc}; script-src ${scriptSrc}; connect-src ${connectSrc}; img-src ${imgSrc}; font-src ${fontSrc}; worker-src ${workerSrc};">
  ${webviewStyles(vscode.Uri.joinPath(extensionUri, 'dist', 'webview').fsPath).map(file => `<link rel="stylesheet" href="${webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview', file))}">`).join('\n')}
  <link rel="modulepreload" href="${renderChunkUri}">
  <style>
    html, body, #root { height: 100%; width: 100%; margin: 0; padding: 0; }
    body { 
      overflow: hidden; 
      background: var(--vscode-editor-background, var(--vscode-sideBar-background)); 
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
      color: var(--vscode-foreground);
    }
    
    /* Initial loading screen styles - uses VS Code theme variables */
    #initial-loading {
      position: fixed;
      inset: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 16px;
      z-index: 9999;
      background: var(--vscode-editor-background, var(--vscode-sideBar-background));
      transition: opacity 0.3s ease-out;
    }
    #initial-loading.fade-out {
      opacity: 0;
      pointer-events: none;
    }
    /* Glow pulse on the OpenCode mark on the cube's top face — signals loading without text. */
    @keyframes oc-logo-glow {
      0%, 100% { filter: drop-shadow(0 0 0 transparent); }
      50% { filter: drop-shadow(0 0 4px var(--vscode-foreground)); }
    }
    #initial-loading .logo-inner {
      animation: oc-logo-glow 1.8s ease-in-out infinite;
    }
    @media (prefers-reduced-motion: reduce) {
      #initial-loading .logo-inner { animation: none; }
    }
    /* Logo colors use VS Code foreground color */
    #initial-loading .logo-stroke {
      stroke: var(--vscode-foreground);
    }
    #initial-loading .logo-fill {
      fill: var(--vscode-foreground);
      opacity: 0.15;
    }
    #initial-loading .logo-fill-solid {
      fill: var(--vscode-foreground);
    }
    #initial-loading .logo-fill-dim {
      fill: var(--vscode-foreground);
      opacity: 0.4;
    }
    #initial-loading .status-text {
      font-size: 13px;
      color: var(--vscode-descriptionForeground, var(--vscode-foreground));
      text-align: center;
    }
    #initial-loading .error-text {
      font-size: 12px;
      color: var(--vscode-errorForeground, #f48771);
      text-align: center;
      max-width: 280px;
    }
    #initial-loading .loading-actions {
      display: flex;
      gap: 8px;
      margin-top: 4px;
      flex-wrap: wrap;
      justify-content: center;
    }
    #initial-loading .loading-actions button {
      border: 1px solid var(--vscode-button-border, transparent);
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      padding: 5px 10px;
      cursor: pointer;
    }
    #root[hidden], #codex-auth-gate[hidden], #codex-auth-gate [hidden] { display: none !important; }
    #codex-auth-gate {
      position: fixed; inset: 0; z-index: 10000; overflow-y: auto;
      display: grid; place-items: center; padding: 28px 20px; box-sizing: border-box;
      background: var(--vscode-editor-background); color: var(--vscode-foreground);
      font-family: var(--vscode-font-family); font-size: 13px;
    }
    .codex-auth-card { width: 100%; max-width: 360px; margin: auto; }
    .codex-auth-brand { font-size: 15px; font-weight: 600; margin-bottom: 36px; }
    .codex-auth-brand span { color: var(--vscode-descriptionForeground); font-weight: 400; }
    #codex-auth-title { font-size: 24px; line-height: 1.3; font-weight: 600; margin: 0 0 12px; }
    #codex-auth-copy, .codex-auth-note { color: var(--vscode-descriptionForeground); line-height: 1.7; }
    .codex-auth-note { margin-top: 24px; font-size: 12px; }
    .codex-auth-actions { display: flex; flex-direction: column; gap: 10px; margin-top: 24px; }
    #codex-auth-gate button {
      font: inherit; border-radius: 8px; padding: 10px 14px; min-height: 40px;
      border: 1px solid var(--vscode-button-border, transparent); cursor: pointer;
      color: var(--vscode-button-foreground); background: var(--vscode-button-background);
    }
    #codex-auth-gate button:hover { background: var(--vscode-button-hoverBackground); }
    #codex-auth-gate button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    #codex-auth-gate button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    #codex-auth-gate button:disabled { opacity: .55; cursor: wait; }
    #codex-auth-gate button:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 3px; }
    #codex-auth-error { color: var(--vscode-errorForeground); overflow-wrap: anywhere; line-height: 1.6; }
    #codex-auth-code { display: block; font-size: 24px; letter-spacing: 3px; padding: 12px; text-align: center; background: var(--vscode-textCodeBlock-background); user-select: all; }
  </style>
  <title>Vcodex-Chamber</title>
</head>
<body>
  <!-- Initial loading screen with simplified OpenChamber logo -->
  <div id="initial-loading">
    <svg class="logo" width="70" height="70" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
      <!-- Left face -->
      <path class="logo-fill logo-stroke" d="M50 50 L8.432 26 L8.432 74 L50 98 Z" stroke-width="2" stroke-linejoin="round"/>
      <!-- Right face -->
      <path class="logo-fill logo-stroke" d="M50 50 L91.568 26 L91.568 74 L50 98 Z" stroke-width="2" stroke-linejoin="round"/>
      <!-- Top face (no fill, stroke only) -->
      <path class="logo-stroke" d="M50 2 L8.432 26 L50 50 L91.568 26 Z" fill="none" stroke-width="2" stroke-linejoin="round"/>
      
      <!-- OpenCode logo on top face -->
      <g class="logo-inner" transform="matrix(0.866, 0.5, -0.866, 0.5, 50, 26) scale(0.75)">
        <path class="logo-fill-solid" fill-rule="evenodd" clip-rule="evenodd" d="M-16 -20 L16 -20 L16 20 L-16 20 Z M-8 -12 L-8 12 L8 12 L8 -12 Z"/>
        <path class="logo-fill-dim" d="M-8 -4 L8 -4 L8 12 L-8 12 Z"/>
      </g>
    </svg>
    <!-- Status text stays empty while things are fine; populated only on error. -->
    <div class="status-text" id="loading-status"></div>
    ${!cliAvailable ? `<div class="error-text" id="cli-missing-text">Codex CLI not found. Please install it first.</div>` : ''}
    <div class="loading-actions" id="loading-actions" hidden>
      <button id="loading-retry" type="button"></button>
      <button id="loading-login" type="button"></button>
      <button id="loading-logs" type="button"></button>
    </div>
  </div>
  
  <div id="root" hidden inert></div>
  <main id="codex-auth-gate" hidden></main>
  <script>
    // Polyfill process for Node.js modules running in browser
    window.process = window.process || { env: { NODE_ENV: 'production' }, platform: '', version: '', browser: true };

    window.__VSCODE_CONFIG__ = {
      workspaceFolder: "${workspaceFolder.replace(/\\/g, '\\\\')}",
      workspaceFolders: ${workspaceFoldersJson},
      theme: "${themeKind}",
      connectionStatus: "${initialStatus}",
      cliAvailable: ${cliAvailable},
      extensionVersion: "${extensionVersion.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}",
      platform: "${os.platform()}",
      arch: "${os.arch()}",
      viewMode: "${viewMode}",
      initialSessionId: ${initialSessionId ? `"${initialSessionId.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : 'null'},
      initialComposer: ${initialComposer ? `"${initialComposer}"` : 'null'},
    };
    window.__OPENCHAMBER_HOME__ = "${workspaceFolder.replace(/\\/g, '\\\\')}";
    // VS Code's display language. The UI bundle uses it as the default locale
    // until the user picks one; the splash below picks its strings from it too.
    window.__OPENCHAMBER_HOST_LANGUAGE__ = ${JSON.stringify(vscode.env.language)};

    // OpenChamber's own saved locale wins; before one exists, VS Code's display
    // language decides, so a fresh install in a supported language never boots
    // in English.
    function resolveBootstrapLanguage() {
      try {
        var rawLocale = window.localStorage.getItem('openchamber.i18n.v1');
        if (rawLocale) {
          var parsedLocale = JSON.parse(rawLocale);
          if (parsedLocale && typeof parsedLocale.locale === 'string') return parsedLocale.locale.toLowerCase();
        }
      } catch {}
      return String(window.__OPENCHAMBER_HOST_LANGUAGE__ || '').toLowerCase();
    }

    function getBootstrapMessages() {
      var locale = 'en';
      var detected = resolveBootstrapLanguage();
      if (detected.indexOf('fr') === 0) {
        locale = 'fr';
      } else if (detected.indexOf('tr') === 0) {
        locale = 'tr';
      }

      if (locale === 'fr') {
        return {
          startingApi: 'Démarrage de Codex…',
          initializing: 'Initialisation…',
          connecting: 'Connexion…',
          connected: 'Connecté !',
          connectionError: 'Erreur de connexion',
          reconnecting: 'Reconnexion…',
          cliNotFound: 'Codex CLI introuvable. Veuillez l’installer d’abord.',
        };
      }
      if (locale === 'tr') {
        return {
          startingApi: 'Codex başlatılıyor…',
          initializing: 'Başlatılıyor…',
          connecting: 'Bağlanıyor…',
          connected: 'Bağlandı!',
          connectionError: 'Bağlantı hatası',
          reconnecting: 'Yeniden bağlanıyor…',
          cliNotFound: 'Codex CLI bulunamadı. Lütfen önce kurun.',
        };
      }
      if (detected.indexOf('zh') === 0) {
        return {
          startingApi: '正在启动 Codex…',
          initializing: '正在初始化…',
          connecting: '正在连接…',
          connected: '已连接',
          connectionError: '连接失败',
          reconnecting: '正在重连…',
          cliNotFound: '找不到 Codex CLI，请安装或设置 CLI 路径。',
          retry: '重试',
          login: '登录 GPT',
          logs: '打开日志',
        };
      }
      return {
        startingApi: 'Starting Codex…',
        initializing: 'Initializing…',
        connecting: 'Connecting…',
        connected: 'Connected!',
        connectionError: 'Connection error',
        reconnecting: 'Reconnecting…',
        cliNotFound: 'Codex CLI not found. Please install it first.',
        retry: 'Retry',
        login: 'Sign in to GPT',
        logs: 'Open logs',
      };
    }

    (function applyBootstrapLocale() {
      var statusEl = document.getElementById('loading-status');
      var cliMissingEl = document.getElementById('cli-missing-text');
      var messages = getBootstrapMessages();
      if (cliMissingEl) {
        cliMissingEl.textContent = messages.cliNotFound;
      }
      if (statusEl) {
        statusEl.textContent = '';
      }
      var actions = document.getElementById('loading-actions');
      var retry = document.getElementById('loading-retry');
      var login = document.getElementById('loading-login');
      var logs = document.getElementById('loading-logs');
      if (retry) { retry.textContent = messages.retry || 'Retry'; retry.onclick = function() { window.dispatchEvent(new CustomEvent('capture-codex-retry')); }; }
      if (login) { login.textContent = messages.login || 'Sign in'; login.onclick = function() { window.dispatchEvent(new CustomEvent('capture-codex-login')); }; }
      if (logs) { logs.textContent = messages.logs || 'Open logs'; logs.onclick = function() { window.dispatchEvent(new CustomEvent('capture-codex-logs')); }; }
      if (actions) actions.hidden = true;
    })();

    // Handle connection status updates to update loading screen
    window.addEventListener('message', function(event) {
      var msg = event.data;
      if (msg && msg.type === 'connectionStatus') {
        var messages = getBootstrapMessages();
        var statusEl = document.getElementById('loading-status');
        if (statusEl) {
          // Only show text when something is wrong — progress states stay silent
          // (the animated logo already signals "working").
          if (msg.status === 'error') {
            statusEl.textContent = msg.error || messages.connectionError;
            statusEl.classList.add('error-text');
            var actions = document.getElementById('loading-actions');
            if (actions) actions.hidden = false;
          } else {
            statusEl.textContent = '';
            statusEl.classList.remove('error-text');
            var actions = document.getElementById('loading-actions');
            if (actions) actions.hidden = true;
          }
        }
      }
      if (msg && msg.type === 'codexAuth') {
        window.__CODEX_AUTH_STATE__ = msg.state;
      }
    });
  </script>
  <script type="module">
    const prodEntryUrl = ${JSON.stringify(scriptUri.toString())};
    const devServerUrl = ${normalizedDevServerUrl ? JSON.stringify(normalizedDevServerUrl) : 'null'};

    const loadProductionBundle = () => {
      const script = document.createElement('script');
      script.type = 'module';
      script.src = prodEntryUrl;
      document.body.appendChild(script);
    };

    if (!devServerUrl) {
      loadProductionBundle();
    } else {
      const baseUrl = devServerUrl;

      const statusEl = document.getElementById('loading-status');
      const getDevMessages = () => {
        const detected = resolveBootstrapLanguage();
        if (detected.indexOf('fr') === 0) {
          return {
            startingDevServer: (host) => 'Démarrage du serveur de développement de la webview (' + host + ')...',
            waitingDevServer: (host, attempt) => 'En attente du serveur de développement de la webview (' + host + ')... tentative ' + attempt,
          };
        }
        if (detected.indexOf('tr') === 0) {
          return {
            startingDevServer: (host) => 'Webview dev sunucusu başlatılıyor (' + host + ')...',
            waitingDevServer: (host, attempt) => 'Webview dev sunucusu bekleniyor (' + host + ')... deneme ' + attempt,
          };
        }
        return {
          startingDevServer: (host) => 'Starting webview dev server (' + host + ')...',
          waitingDevServer: (host, attempt) => 'Waiting for webview dev server (' + host + ')... attempt ' + attempt,
        };
      };
      const setStatus = (text) => {
        if (statusEl) {
          statusEl.textContent = text;
        }
      };

      const retryDelayMs = 500;
      let attempt = 0;

      const waitForRootMount = (timeoutMs) => {
        const root = document.getElementById('root');
        if (!root) {
          return Promise.resolve(false);
        }

        if (root.childNodes.length > 0 || document.getElementById('codex-auth-gate')?.childNodes.length > 0) {
          return Promise.resolve(true);
        }

        return new Promise((resolve) => {
          const observer = new MutationObserver(() => {
            if (root.childNodes.length > 0) {
              observer.disconnect();
              clearTimeout(timer);
              resolve(true);
            }
          });

          observer.observe(root, { childList: true, subtree: true });
          const timer = window.setTimeout(() => {
            observer.disconnect();
            resolve(root.childNodes.length > 0);
          }, timeoutMs);
        });
      };

      const tryLoadDevBundle = () => {
        const viteClientUrl = baseUrl + '/@vite/client';
        const reactRefreshUrl = baseUrl + '/@react-refresh';
        const devEntryUrl = baseUrl + '/main.tsx';
        const hostLabel = (() => {
          try {
            return new URL(baseUrl).host;
          } catch {
            return baseUrl;
          }
        })();

        const devMessages = getDevMessages();
        setStatus(devMessages.startingDevServer(hostLabel));

        Promise.resolve()
          .then(() => import(viteClientUrl))
          .then(() => import(reactRefreshUrl))
          .then((mod) => {
            const runtime = mod && mod.default ? mod.default : null;
            if (runtime && typeof runtime.injectIntoGlobalHook === 'function') {
              runtime.injectIntoGlobalHook(window);
              window.$RefreshReg$ = () => {};
              window.$RefreshSig$ = () => (type) => type;
              window.__vite_plugin_react_preamble_installed__ = true;
            }
          })
          .then(() => import(devEntryUrl))
          .then(() => waitForRootMount(4000))
          .then((mounted) => {
            if (!mounted) {
              throw new Error('Dev bundle loaded but app did not mount');
            }
          })
          .catch((error) => {
            attempt += 1;
            console.warn('[OpenChamber] VS Code webview dev bundle unavailable, retrying...', error);
            setStatus(devMessages.waitingDevServer(hostLabel, attempt));
            window.setTimeout(() => {
              tryLoadDevBundle();
            }, retryDelayMs);
          });
      };

      tryLoadDevBundle();
    }
  </script>
</body>
</html>`;
}
