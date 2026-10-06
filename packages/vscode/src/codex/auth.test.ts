import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { CodexAuth, canUseCodex, type CodexAuthState } from './auth';

const controllers: CodexAuth[] = [];
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function harness() {
  let read: unknown = { account: null, requiresOpenaiAuth: true };
  const calls: Array<{ method: string; params?: unknown }> = [];
  const states: CodexAuthState[] = [];
  let start: unknown = { loginId: 'login-1', authUrl: 'https://auth.openai.com/test' };
  const auth = new CodexAuth(async (method, params) => {
    calls.push({ method, params });
    if (method === 'account/read') {
      if (read instanceof Error) throw read;
      return read;
    }
    if (method === 'account/login/start') {
      if (start instanceof Error) throw start;
      return start;
    }
    return {};
  }, state => states.push(state));
  controllers.push(auth);
  return { auth, calls, states, read: (value: unknown) => { read = value; }, start: (value: unknown) => { start = value; } };
}
afterEach(() => { for (const auth of controllers.splice(0)) auth.reset(); });

test('startup is gated until account/read; null account requires login only for an authenticated provider', async () => {
  const h = harness();
  assert.equal(canUseCodex(h.auth.state), false);
  assert.deepEqual(await h.auth.refresh(true), { status: 'login-required' });
  assert.deepEqual(h.calls[0], { method: 'account/read', params: { refreshToken: true } });
  h.read({ account: null, requiresOpenaiAuth: false });
  assert.deepEqual(await h.auth.refresh(), { status: 'not-required' });
  assert.equal(canUseCodex(h.auth.state), true);
});

test('reuse ChatGPT/API key auth without exposing credentials to webviews', async () => {
  const h = harness();
  h.read({ account: { type: 'chatgpt', email: 'user@example.com', planType: 'plus', accessToken: 'secret' }, requiresOpenaiAuth: true });
  assert.deepEqual(await h.auth.refresh(), { status: 'authenticated', account: { type: 'chatgpt', email: 'user@example.com', planType: 'plus' } });
  h.read({ account: { type: 'apiKey', apiKey: 'secret' }, requiresOpenaiAuth: true });
  assert.deepEqual(await h.auth.refresh(), { status: 'authenticated', account: { type: 'apiKey' } });
});

test('RPC failure or malformed account is unknown, never authenticated', async () => {
  const h = harness();
  h.read(new Error('app-server disconnected'));
  assert.deepEqual(await h.auth.refresh(), { status: 'unknown', error: 'app-server disconnected' });
  h.read({});
  assert.equal((await h.auth.refresh()).status, 'unknown');
  assert.equal(canUseCodex(h.auth.state), false);
});

test('double clicks start one OAuth flow; refresh preserves pending browser link', async () => {
  const h = harness();
  await Promise.all([h.auth.login(), h.auth.login()]);
  await h.auth.login();
  assert.equal(h.calls.filter(c => c.method === 'account/login/start').length, 1);
  assert.deepEqual(h.calls[0].params, { type: 'chatgpt', useHostedLoginSuccessPage: true, appBrand: 'codex' });
  await h.auth.refresh();
  assert.deepEqual(h.auth.state, { status: 'signing-in', loginId: 'login-1', loginUrl: 'https://auth.openai.com/test' });
});

test('success verifies actual account before exposing chat; stale login completion is ignored', async () => {
  const h = harness();
  await h.auth.login();
  h.auth.onEvent('account/login/completed', { loginId: 'old', success: true });
  assert.equal(h.calls.length, 1);
  h.read({ account: { type: 'chatgpt' }, requiresOpenaiAuth: true });
  h.auth.onEvent('account/login/completed', { loginId: 'login-1', success: true });
  await tick();
  assert.equal(h.auth.state.status, 'authenticated');
});

test('account update before completion must not swallow the failure and leave a spinner', async () => {
  const h = harness();
  await h.auth.login();
  h.auth.onEvent('account/updated', { authMode: 'chatgpt' });
  h.auth.onEvent('account/login/completed', { loginId: 'login-1', success: false, error: 'Authorization denied' });
  await tick();
  assert.deepEqual(h.auth.state, { status: 'login-required', error: 'Authorization denied' });
});

test('completion arriving before login/start reply is processed by matching loginId', async () => {
  const h = harness();
  const pending = deferred<unknown>();
  h.start(pending.promise);
  const login = h.auth.login();
  h.auth.onEvent('account/login/completed', { loginId: 'login-1', success: false, error: 'Expired' });
  pending.resolve({ loginId: 'login-1', authUrl: 'https://auth.openai.com/test' });
  await login;
  assert.deepEqual(h.auth.state, { status: 'login-required', error: 'Expired' });
});

test('cancel invalidates in-flight account read and cancels official flow', async () => {
  const h = harness();
  await h.auth.login();
  const pending = deferred<unknown>();
  h.read(pending.promise);
  const reading = h.auth.refresh();
  await h.auth.cancelLogin();
  pending.resolve({ account: { type: 'chatgpt' }, requiresOpenaiAuth: true });
  await reading;
  assert.deepEqual(h.auth.state, { status: 'login-required' });
  assert.ok(h.calls.some(c => c.method === 'account/login/cancel' && (c.params as { loginId: string }).loginId === 'login-1'));
  h.auth.onEvent('account/login/completed', { loginId: 'login-1', success: true });
  assert.deepEqual(h.auth.state, { status: 'login-required' });
});

test('cancellation during login/start cleans up the late server flow', async () => {
  const h = harness();
  const pending = deferred<unknown>();
  h.start(pending.promise);
  const login = h.auth.login();
  await h.auth.cancelLogin();
  pending.resolve({ loginId: 'login-1', authUrl: 'https://auth.openai.com/test' });
  await login;
  assert.deepEqual(h.auth.state, { status: 'login-required' });
  assert.ok(h.calls.some(c => c.method === 'account/login/cancel'));
});

test('device flow uses the official verification URL and code; failure never substitutes a generic login page', async () => {
  const h = harness();
  h.start({ loginId: 'device-1', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABC-123' });
  await h.auth.login(true);
  assert.deepEqual(h.calls[0].params, { type: 'chatgptDeviceCode' });
  assert.deepEqual(h.auth.state, { status: 'signing-in', loginId: 'device-1', loginUrl: 'https://auth.openai.com/codex/device', userCode: 'ABC-123' });
  await h.auth.cancelLogin();
  h.start(new Error('OAuth unavailable'));
  await assert.rejects(h.auth.login(), /OAuth unavailable/);
  assert.deepEqual(h.auth.state, { status: 'login-required', error: 'OAuth unavailable' });
});

test('logout and account removal revoke access; reset ignores old refresh responses', async () => {
  const h = harness();
  h.read({ account: { type: 'chatgpt' }, requiresOpenaiAuth: true });
  await h.auth.refresh();
  await h.auth.logout();
  assert.deepEqual(h.auth.state, { status: 'login-required' });
  assert.ok(h.calls.some(c => c.method === 'account/logout'));
  const pending = deferred<unknown>();
  h.read(pending.promise);
  const reading = h.auth.refresh();
  h.auth.reset();
  pending.resolve({ account: { type: 'chatgpt' }, requiresOpenaiAuth: true });
  await reading;
  assert.deepEqual(h.auth.state, { status: 'checking' });
  h.read({ account: null, requiresOpenaiAuth: true });
  h.auth.onEvent('account/updated', { authMode: null });
  await tick();
  assert.deepEqual(h.auth.state, { status: 'login-required' });
});
