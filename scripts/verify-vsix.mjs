import { parseArgs } from 'node:util';
import { verifyVsix } from './lib/vsix-tools.mjs';
import { loadRuntimeManifest } from './lib/runtime-tools.mjs';
const { values } = parseArgs({ options: { file: { type: 'string' }, target: { type: 'string' }, 'extract-runtime': { type: 'string' }, 'runtime-manifest': { type: 'string' } } });
if (!values.file || !values.target) throw new Error('Use --file <VSIX> --target <platform-arch> [--extract-runtime artifacts/<folder>]');
if (values['runtime-manifest']) await loadRuntimeManifest(values['runtime-manifest']);
await verifyVsix(values.file, values.target, { extractRuntime: values['extract-runtime'] });
