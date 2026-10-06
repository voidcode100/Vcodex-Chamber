import * as http from 'node:http';
import * as https from 'node:https';
import { gunzipSync, inflateSync, brotliDecompressSync } from 'node:zlib';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// Use Node's request API so VS Code's supported request/proxy integration can
// participate. Native fetch does not consistently inherit editor proxy settings.
export function createDictationFetch(options: { proxy?: string; noProxy?: string } = {}): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const prepared = new Request(input, init);
    const url = new URL(prepared.url);
    if (!['https:', 'http:'].includes(url.protocol)) throw new Error('转写地址必须使用 HTTP 或 HTTPS。');
    const bytes = prepared.body ? Buffer.from(await prepared.arrayBuffer()) : undefined;
    prepared.signal.throwIfAborted();
    const headers = Object.fromEntries(prepared.headers);
    if (bytes) headers['content-length'] = String(bytes.length);
    const env = process.env;
    const hasProxy = options.proxy?.trim() || environmentProxy(url, env);
    const systemProxy = !hasProxy ? await windowsSystemProxy(url.protocol) : undefined;
    const proxy = resolveDictationProxy(url, { ...options, proxy: options.proxy || systemProxy });
    const agent = proxy ? new HttpsProxyAgent(proxy) : undefined;
    try {
      return await new Promise<Response>((resolve, reject) => {
        const request = (url.protocol === 'https:' ? https.request : http.request)(url, {
          method: prepared.method, headers, signal: prepared.signal, agent,
        }, response => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > 1024 * 1024) { response.destroy(new Error('转写响应过大。')); return; }
            chunks.push(chunk);
          });
          response.on('error', reject);
          response.on('end', () => {
            try {
              let body = Buffer.concat(chunks);
              const encoding = response.headers['content-encoding'];
              const decompress = { maxOutputLength: 1024 * 1024 };
              if (encoding === 'gzip') body = gunzipSync(body, decompress);
              else if (encoding === 'deflate') body = inflateSync(body, decompress);
              else if (encoding === 'br') body = brotliDecompressSync(body, decompress);
              const resultHeaders = new Headers();
              for (const [name, value] of Object.entries(response.headers)) {
                if (value !== undefined && !['content-encoding', 'content-length', 'set-cookie'].includes(name)) {
                  resultHeaders.set(name, Array.isArray(value) ? value.join(', ') : value);
                }
              }
              const status = response.statusCode ?? 502;
              resolve(new Response([204, 205, 304].includes(status) || prepared.method === 'HEAD' ? null : new Uint8Array(body), {
                status, statusText: response.statusMessage, headers: resultHeaders,
              }));
            } catch (error) { reject(error); }
          });
        });
        request.on('error', reject);
        // Deliberately no redirect following: bearer credentials stay at their destination.
        request.end(bytes);
      });
    } finally { agent?.destroy(); }
  }) as typeof fetch;
}

// A VS Code process launched from the Start menu may have no *_PROXY variables.
// Honor Windows' explicit proxy as well (no global settings are changed).
async function windowsSystemProxy(protocol: string): Promise<string | undefined> {
  if (process.platform !== 'win32') return undefined;
  const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
  try {
    const [enabled, server] = await Promise.all(['ProxyEnable', 'ProxyServer'].map(name =>
      promisify(execFile)('reg.exe', ['query', key, '/v', name], { windowsHide: true, timeout: 2000 }),
    ));
    if (!/ProxyEnable\s+REG_DWORD\s+0x1\b/i.test(enabled.stdout)) return undefined;
    return parseWindowsProxy(server.stdout.match(/ProxyServer\s+REG_SZ\s+([^\r\n]+)/i)?.[1] ?? '', protocol);
  } catch { return undefined; }
}

export function parseWindowsProxy(value: string, protocol = 'https:'): string | undefined {
  const entries = value.trim();
  if (!entries) return undefined;
  const prefix = protocol === 'http:' ? 'http=' : 'https=';
  const address = entries.includes('=')
    ? entries.split(';').map(entry => entry.trim()).find(entry => entry.toLowerCase().startsWith(prefix))?.slice(prefix.length)
    : entries;
  if (!address) return undefined;
  return /^https?:\/\//i.test(address) ? address : `http://${address}`;
}

function environmentProxy(url: URL, env: NodeJS.ProcessEnv): string | undefined {
  return (url.protocol === 'https:' ? env.HTTPS_PROXY || env.https_proxy : env.HTTP_PROXY || env.http_proxy) || env.ALL_PROXY || env.all_proxy;
}

export function resolveDictationProxy(url: URL, options: { proxy?: string; noProxy?: string }, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const bypass = options.noProxy ?? env.NO_PROXY ?? env.no_proxy ?? '';
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  const excluded = bypass.split(',').some(value => {
    const rule = value.trim().toLowerCase();
    if (!rule) return false;
    if (rule === '*') return true;
    const match = /^(.*?)(?::(\d+))?$/.exec(rule)!;
    const host = match[1].replace(/^\*?\./, '');
    if (match[2] && match[2] !== port) return false;
    return url.hostname === host || url.hostname.endsWith(`.${host}`);
  });
  if (excluded) return undefined;
  const selected = options.proxy?.trim() || environmentProxy(url, env);
  if (!selected) return undefined;
  let parsed: URL;
  try { parsed = new URL(selected); } catch { throw new Error('代理地址无效，请检查 VS Code 的 http.proxy 设置。'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('听写需要 HTTP(S) 代理，请在 VS Code http.proxy 中配置代理的 HTTP 端口。');
  return parsed.href;
}
