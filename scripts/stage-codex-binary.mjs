import { parseArgs } from 'node:util';
import { prepareRuntime, stageRuntime, nativeTarget, selectBuildRuntime } from './lib/runtime-tools.mjs';

const { values } = parseArgs({ options: { target: { type: 'string' }, offline: { type: 'boolean', default: false }, 'codex-version': { type: 'string' }, 'runtime-manifest': { type: 'string' } } });
const target = values.target || process.env.VCODEX_VSIX_TARGET || nativeTarget;
await selectBuildRuntime({ version: values['codex-version'], manifest: values['runtime-manifest'], offline: values.offline });
await stageRuntime(target, await prepareRuntime(target, { offline: values.offline }));
