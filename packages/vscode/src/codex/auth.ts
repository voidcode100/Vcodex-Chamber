export type CodexAuthState =
  | { status: 'checking' }
  | { status: 'authenticated'; account: { type: string; email?: string | null; planType?: string } }
  | { status: 'not-required' }
  | { status: 'login-required'; reason?: string; error?: string }
  | { status: 'signing-in'; loginId: string; loginUrl: string; userCode?: string }
  | { status: 'unknown'; error: string };

export const canUseCodex = (state: CodexAuthState): boolean => state.status === 'authenticated' || state.status === 'not-required';
type Rpc = (method: string, params?: unknown) => Promise<unknown>;

/** Auth is owned by app-server. Never infer sign-in from a running process or a token file. */
export class CodexAuth {
  state: CodexAuthState = { status: 'checking' };
  private revision = 0;
  private loginTask?: Promise<void>;
  private poll?: ReturnType<typeof setInterval>;
  private polling = false;
  private loginStarted = 0;
  private earlyCompletion?: { loginId?: unknown; success?: unknown; error?: unknown };
  constructor(private readonly rpc: Rpc, private readonly changed: (state: CodexAuthState) => void) {}

  reset(): void {
    this.stopPolling();
    this.set({ status: 'checking' });
  }
  private set(state: CodexAuthState): void {
    this.revision++;
    this.state = state;
    if (state.status !== 'signing-in') this.stopPolling();
    this.changed(state);
  }
  async refresh(refreshToken = false): Promise<CodexAuthState> {
    if (this.loginTask && this.state.status === 'checking') return this.state;
    const revision = this.revision;
    try {
      const result = await this.rpc('account/read', { refreshToken }) as { account?: { type?: unknown; email?: unknown; planType?: unknown } | null; requiresOpenaiAuth?: unknown };
      if (revision !== this.revision) return this.state;
      if (result?.account && typeof result.account.type === 'string') {
        this.set({ status: 'authenticated', account: {
          type: result.account.type,
          ...(typeof result.account.email === 'string' || result.account.email === null ? { email: result.account.email } : {}),
          ...(typeof result.account.planType === 'string' ? { planType: result.account.planType } : {}),
        } });
      } else if (this.state.status === 'signing-in') {
        // A null account while OAuth is pending must not replace its browser link.
        return this.state;
      } else if (result?.requiresOpenaiAuth === false) {
        this.set({ status: 'not-required' });
      } else if (result?.account === null && result.requiresOpenaiAuth === true) {
        this.set({ status: 'login-required' });
      } else {
        this.set({ status: 'unknown', error: 'Codex 返回了不完整的登录状态，请重新检查。' });
      }
    } catch (error) {
      if (revision === this.revision && this.state.status !== 'signing-in') this.set({ status: 'unknown', error: error instanceof Error ? error.message : String(error) });
    }
    return this.state;
  }
  login(deviceCode = false): Promise<void> {
    if (this.loginTask) return this.loginTask;
    if (this.state.status === 'signing-in') return Promise.resolve();
    this.loginTask = this.beginLogin(deviceCode).finally(() => { this.loginTask = undefined; });
    return this.loginTask;
  }
  private async beginLogin(deviceCode: boolean): Promise<void> {
    this.earlyCompletion = undefined;
    this.set({ status: 'checking' });
    const revision = this.revision;
    try {
      const result = await this.rpc('account/login/start', deviceCode ? { type: 'chatgptDeviceCode' } : { type: 'chatgpt', useHostedLoginSuccessPage: true, appBrand: 'codex' }) as { loginId?: unknown; authUrl?: unknown; verificationUrl?: unknown; userCode?: unknown };
      if (revision !== this.revision) {
        if (typeof result.loginId === 'string') await this.rpc('account/login/cancel', { loginId: result.loginId });
        return;
      }
      const loginUrl = typeof result.authUrl === 'string' ? result.authUrl : result.verificationUrl;
      if (typeof result.loginId !== 'string' || typeof loginUrl !== 'string' || new URL(loginUrl).protocol !== 'https:') throw new Error('Codex 未返回有效的浏览器授权链接。');
      this.set({ status: 'signing-in', loginId: result.loginId, loginUrl, ...(typeof result.userCode === 'string' ? { userCode: result.userCode } : {}) });
      this.loginStarted = Date.now();
      this.poll = setInterval(() => {
        if (Date.now() - this.loginStarted > 10 * 60_000) {
          void this.cancelLogin('登录等待超时，请重新开始。').catch(() => { /* The local pending state is already cleared. */ });
        } else if (!this.polling) {
          this.polling = true;
          void this.refresh().finally(() => { this.polling = false; });
        }
      }, 2500);
      this.poll.unref?.();
      this.applyEarlyCompletion(result.loginId);
    } catch (error) {
      if (revision === this.revision) this.set({ status: 'login-required', error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }
  private applyEarlyCompletion(loginId: string): void {
    if (this.earlyCompletion?.loginId === loginId) this.onEvent('account/login/completed', this.earlyCompletion);
    this.earlyCompletion = undefined;
  }
  async cancelLogin(reason?: string): Promise<void> {
    const state = this.state;
    this.set({ status: 'login-required', ...(reason ? { error: reason } : {}) });
    if (state.status === 'signing-in') await this.rpc('account/login/cancel', { loginId: state.loginId });
  }
  async logout(): Promise<void> {
    await this.cancelLogin();
    await this.rpc('account/logout');
    this.set({ status: 'login-required' });
  }
  onEvent(method: string, params: unknown): void {
    const value = params as { loginId?: unknown; success?: unknown; error?: unknown; authMode?: unknown } | null;
    if (method === 'account/login/completed') {
      if (this.loginTask && this.state.status === 'checking') {
        this.earlyCompletion = value ?? undefined;
        return;
      }
      if (this.state.status !== 'signing-in') return;
      if (this.state.status === 'signing-in' && value?.loginId !== this.state.loginId) return;
      if (value?.success === false) {
        if (this.state.status === 'signing-in') this.set({ status: 'login-required', error: typeof value.error === 'string' ? value.error : '登录未完成，请重试。' });
      } else if (value?.success === true) {
        void this.refresh(true);
      }
    } else if (method === 'account/updated') {
      if (this.loginTask && this.state.status === 'checking') return;
      if (this.state.status === 'signing-in') {
        if (value?.authMode !== null) void this.refresh();
        return;
      }
      // Invalidate an older account/read before accepting this authoritative event.
      this.set(value?.authMode === null ? { status: 'login-required' } : { status: 'checking' });
      void this.refresh();
    }
  }
  private stopPolling(): void { clearInterval(this.poll); this.poll = undefined; }
}
