import * as path from 'node:path';
import { createHash, X509Certificate } from 'node:crypto';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function isValidCaptureId(id: unknown): id is string { return typeof id === 'string' && /^[a-zA-Z0-9_-]{8,100}$/.test(id); }
export function isPng(bytes: Buffer): boolean { return bytes.length >= PNG_SIGNATURE.length && bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE); }
export function resolveWorkspaceCapturePath(workspaceRoot: string, directory: string): string {
  const root = path.resolve(workspaceRoot);
  const candidate = path.resolve(root, directory);
  const relative = path.relative(root, candidate);
  if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) return candidate;
  throw new Error('The screenshot directory must stay inside the current workspace.');
}
export function certificateSha256Fingerprint(certificatePem: string): string {
  return createHash('sha256').update(new X509Certificate(certificatePem).raw).digest('hex').toUpperCase().match(/.{2}/g)?.join(':') ?? '';
}
