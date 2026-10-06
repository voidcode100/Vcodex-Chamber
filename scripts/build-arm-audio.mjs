import { parseArgs } from 'node:util';
import { buildArmAudio } from './lib/arm-audio-tools.mjs';
const { values } = parseArgs({ options: { offline: { type: 'boolean', default: false }, cc: { type: 'string' } } });
await buildArmAudio(values);
