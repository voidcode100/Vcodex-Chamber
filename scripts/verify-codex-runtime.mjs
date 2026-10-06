import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname, basename } from 'node:path';
import { parseArgs } from 'node:util';
import { targetInfo, validateRuntime, runtimeConfig, nativeTarget, run, loadRuntimeManifest } from './lib/runtime-tools.mjs';

const { values } = parseArgs({ options: {
  directory: { type: 'string' }, target: { type: 'string', default: nativeTarget },
  wsl: { type: 'string' },
  'runtime-manifest': { type: 'string' },
} });
if (!values.directory) throw new Error('Use --directory <extracted runtime> [--target <VSIX target>] [--wsl <distribution>]');
if (values['runtime-manifest']) await loadRuntimeManifest(values['runtime-manifest']);
const directory = resolve(values.directory), info = targetInfo(values.target);
await validateRuntime(directory, values.target);
if (!values.wsl && values.target !== nativeTarget) throw new Error(`Cannot execute ${values.target} on ${nativeTarget}; use a native runner`);
const temporary = await mkdtemp(join(tmpdir(), 'vcodex-runtime-smoke-'));
function command(args) {
  if (values.wsl) {
    if (process.platform !== 'win32' || info.platform !== 'linux' || info.arch !== 'x86_64') throw new Error('WSL smoke is for Linux x64 on Windows x64');
    const linuxPath = directory.replace(/^([A-Z]):/i, (_, drive) => `/mnt/${drive.toLowerCase()}`).replaceAll('\\', '/');
    // /tmp is unique and contains no authentication. No shell interpolation.
    return ['wsl.exe', ['-d', values.wsl, '--exec', 'env', `CODEX_HOME=/tmp/${basename(temporary)}`, `${linuxPath}/bin/codex`, ...args]];
  }
  return [join(directory, 'bin', info.executable), args];
}
async function invoke(args, handshake = false) {
  const [executable, params] = command(args);
  const child = spawn(executable, params, { windowsHide: true, env: { ...process.env, CODEX_HOME: temporary }, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', errors = '', settled = false;
  try {
    return await new Promise((done, reject) => {
      const timer = setTimeout(() => finish(new Error(`Codex smoke timed out: ${errors.slice(-2000)}`)), 30000);
      function finish(error, result) {
        if (settled) return; settled = true; clearTimeout(timer);
        if (error) reject(error); else done(result);
      }
      child.on('error', error => finish(error));
      child.stderr.on('data', bytes => { errors += bytes; });
      child.stdout.on('data', bytes => {
        output += bytes;
        if (!handshake) return;
        const lines = output.split('\n'); output = lines.pop();
        for (const line of lines) {
          let response; try { response = JSON.parse(line); } catch { continue; }
          if (response.id !== 1) continue;
          if (response.error) { finish(new Error(JSON.stringify(response.error))); return; }
          if (!response.result?.userAgent) { finish(new Error('Missing app-server initialize result')); return; }
          child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
          finish(undefined, response.result.userAgent);
        }
      });
      child.on('exit', code => {
        if (handshake) finish(new Error(`app-server exited before initialize (${code}): ${errors.slice(-2000)}`));
        else if (code !== 0) finish(new Error(`Codex exited ${code}: ${errors.slice(-2000)}`));
        else finish(undefined, output.trim());
      });
      if (handshake) child.stdin.write(JSON.stringify({ id: 1, method: 'initialize', params: {
        clientInfo: { name: 'vcodex_build_test', title: 'Vcodex-Chamber', version: '1.0.0' }, capabilities: { experimentalApi: true },
      } }) + '\n');
      else child.stdin.end();
    });
  } finally {
    if (child.exitCode === null) {
      child.stdin.end();
      child.kill();
      await Promise.race([new Promise(done => child.once('exit', done)), new Promise(done => setTimeout(done, 2000))]);
    }
  }
}
try {
  if (values.wsl) await run('wsl.exe', ['-d', values.wsl, '--exec', 'mkdir', '-p', '--', `/tmp/${basename(temporary)}`]);
  const version = await invoke(['--version']);
  assert.equal(version, `codex-cli ${runtimeConfig.version}`);
  const agent = await invoke(['app-server'], true);
  console.log(`Codex ${values.target}: ${version}; app-server initialize OK (${agent}); host ${values.wsl || nativeTarget}`);
} finally {
  if (dirname(temporary) !== resolve(tmpdir()) || !basename(temporary).startsWith('vcodex-runtime-smoke-')) throw new Error('Unexpected temporary directory');
  await rm(temporary, { recursive: true, force: true });
  if (values.wsl) {
    // Only the generated smoke directory is removed; never the user's Codex home.
    await new Promise((done, reject) => { const child = spawn('wsl.exe', ['-d', values.wsl, '--exec', 'rm', '-rf', '--', `/tmp/${basename(temporary)}`], { windowsHide: true }); child.once('error', reject); child.once('exit', code => code === 0 ? done() : reject(new Error('WSL smoke cleanup failed'))); });
  }
}
