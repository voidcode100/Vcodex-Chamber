import { canUseCodex, type CodexAuthState } from '../src/codex/auth';

/** Both the sidebar and editor use this gate; only app-server decides authentication. */
export function installCodexAuthGate(options: {
  execute: (command: string, ...args: unknown[]) => Promise<unknown>;
  mount: () => Promise<void>;
  language: string;
  initialState?: CodexAuthState;
  connection: () => { status: string; error?: string };
}) {
  const root = document.getElementById('root')!;
  const gate = document.getElementById('codex-auth-gate')!;
  const zh = options.language.startsWith('zh');
  const label = (cn: string, en: string) => zh ? cn : en;
  gate.innerHTML = `<section class="codex-auth-card" aria-labelledby="codex-auth-title">
    <div class="codex-auth-brand">OpenChamber <span>· Codex</span></div>
    <h1 id="codex-auth-title"></h1>
    <p id="codex-auth-copy" role="status" aria-live="polite"></p>
    <code id="codex-auth-code" hidden></code>
    <p id="codex-auth-error" role="alert" hidden></p>
    <div class="codex-auth-actions">
      <button id="codex-auth-login" type="button"></button>
      <button id="codex-auth-device" class="secondary" type="button"></button>
      <button id="codex-auth-refresh" class="secondary" type="button"></button>
      <button id="codex-auth-cancel" class="secondary" type="button"></button>
      <button id="codex-auth-retry" class="secondary" type="button"></button>
    </div>
    <p class="codex-auth-note"></p>
  </section>`;
  const el = (name: string) => document.getElementById(`codex-auth-${name}`)!;
  const login = el('login') as HTMLButtonElement;
  const device = el('device') as HTMLButtonElement;
  const refresh = el('refresh') as HTMLButtonElement;
  const cancel = el('cancel') as HTMLButtonElement;
  const retry = el('retry') as HTMLButtonElement;
  const buttons = [login, device, refresh, cancel, retry];
  let state: CodexAuthState = options.initialState ?? { status: 'checking' };
  let mounted = false;
  let mounting = false;
  let mountError = '';
  let actionError = '';
  let busy = false;
  let revision = 0;
  device.textContent = label('使用设备代码登录', 'Use a device code');
  refresh.textContent = label('重新检查登录状态', 'Check sign-in status');
  cancel.textContent = label('取消登录', 'Cancel sign-in');
  retry.textContent = label('重新连接 Codex', 'Reconnect to Codex');
  gate.querySelector('.codex-auth-note')!.textContent = label(
    '通过浏览器授权 Codex。已有 Codex 登录会自动复用，凭据由 Codex 管理。',
    'Authorize Codex in your browser. Existing Codex sign-in is reused; Codex manages your credentials.',
  );

  const render = () => {
    const connection = options.connection();
    const failed = connection.status === 'error' || connection.status === 'disconnected';
    const ready = canUseCodex(state) && connection.status === 'connected';
    root.hidden = !ready || !mounted;
    root.inert = root.hidden;
    gate.hidden = ready && mounted;
    if (ready && !mounted && !mounting && !mountError) {
      mounting = true;
      void options.mount().then(() => { mounted = true; }).catch(error => {
        mountError = error instanceof Error ? error.message : String(error);
      }).finally(() => { mounting = false; render(); });
    }
    const pending = state.status === 'signing-in';
    el('title').textContent = failed ? label('无法连接 Codex', 'Unable to connect to Codex')
      : mountError ? label('界面加载失败', 'Unable to load the interface')
      : ready ? label('正在打开会话', 'Opening your workspace')
      : pending ? label('在浏览器中完成登录', 'Finish signing in in your browser')
      : state.status === 'checking' ? label('正在检查 Codex 登录', 'Checking Codex sign-in')
      : state.status === 'unknown' ? label('无法确认登录状态', 'Unable to verify sign-in')
      : label('登录以使用 Codex', 'Sign in to use Codex');
    el('copy').textContent = failed ? label('恢复连接后会重新检查登录状态。', 'Your sign-in will be checked after reconnecting.')
      : pending ? label('授权完成后会自动进入会话。', 'Your workspace will open automatically after authorization.')
      : state.status === 'login-required' ? label('使用你的 ChatGPT 账号继续。', 'Continue with your ChatGPT account.')
      : state.status === 'unknown' ? label('请重新检查，或重新连接 Codex。', 'Check again or reconnect to Codex.') : '';
    const error = actionError || mountError || (failed ? connection.error : '') || ('error' in state ? state.error : '') || '';
    el('error').textContent = error;
    el('error').hidden = !error;
    el('code').hidden = state.status !== 'signing-in' || !state.userCode;
    el('code').textContent = state.status === 'signing-in' ? state.userCode ?? '' : '';
    login.textContent = pending ? label('再次打开浏览器', 'Open browser again') : label('使用 ChatGPT 登录', 'Sign in with ChatGPT');
    login.hidden = failed || (!pending && state.status !== 'login-required');
    device.hidden = failed || state.status !== 'login-required';
    cancel.hidden = !pending;
    refresh.hidden = failed || ready || state.status === 'checking';
    retry.hidden = !failed && state.status !== 'unknown' && !mountError;
    for (const button of buttons) button.disabled = busy;
  };
  const update = (next: CodexAuthState) => {
    if (!next?.status) return;
    revision++;
    state = next;
    actionError = '';
    render();
  };
  const run = async (command: string, ...args: unknown[]) => {
    if (busy) return;
    busy = true;
    actionError = '';
    render();
    try { await options.execute(command, ...args); }
    catch (error) { actionError = error instanceof Error ? error.message : String(error); }
    finally { busy = false; render(); }
  };
  login.onclick = () => { void run('captureCodex.login'); };
  device.onclick = () => { void run('captureCodex.login', true); };
  refresh.onclick = () => { void run('captureCodex.refreshAuth'); };
  cancel.onclick = () => { void run('captureCodex.cancelLogin'); };
  retry.onclick = () => {
    if (mountError) { window.location.reload(); return; }
    void run('openchamber.restartApi');
  };
  window.addEventListener('message', event => {
    if (event.data?.type === 'codexAuth') update(event.data.state);
  });
  window.addEventListener('openchamber:connection-status', render);
  render();
  // Read after installing listeners: the initial host notification can precede the bundle.
  const initialRevision = revision;
  void options.execute('captureCodex.getAuthState').then(result => {
    if (revision === initialRevision && result) update(result as CodexAuthState);
  }).catch(error => {
    if (revision === initialRevision) update({ status: 'unknown', error: String(error) });
  });
  return { update };
}
