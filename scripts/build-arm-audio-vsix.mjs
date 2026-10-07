import { parseArgs } from 'node:util';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { root, extensionRoot, hashFile } from './lib/runtime-tools.mjs';
import { armExtensionRoot, armAudioVsixName, prepareArmAudio, stageArmAudio } from './lib/arm-audio-tools.mjs';
import { vsce, Zip, setExecutableAttributes } from './lib/vsix-tools.mjs';
import { verifyArmAudioVsix } from './lib/arm-audio-vsix.mjs';

export async function buildArmAudioVsix(options = {}) {
  const { version } = JSON.parse(await readFile(join(armExtensionRoot, 'package.json'), 'utf8'));
  if (version !== JSON.parse(await readFile(join(extensionRoot, 'package.json'), 'utf8')).version) throw new Error('Audio and client release versions must match');
  await stageArmAudio(await prepareArmAudio(options));
  const require = createRequire(join(extensionRoot, 'package.json'));
  await require('esbuild').build({ entryPoints: [join(armExtensionRoot, 'src/extension.ts')], bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], outfile: join(armExtensionRoot, 'dist/extension.js'), target: 'node18' });
  const directory = join(root, 'artifacts', `v${version}`);
  await mkdir(directory, { recursive: true });
  const file = join(directory, armAudioVsixName(version));
  await vsce.createVSIX({ cwd: armExtensionRoot, packagePath: file, target: 'linux-arm64', dependencies: false });
  const zip = new Zip(file);
  setExecutableAttributes(zip, 'extension/native/linux-arm64/', ['recorder']);
  zip.writeZip(file);
  await verifyArmAudioVsix(file, { verifyDist: true });
  await writeFile(file + '.sha256', `${await hashFile(file)}  ${armAudioVsixName(version)}\n`);
  return file;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { offline: { type: 'boolean', default: false } } });
  await buildArmAudioVsix(values);
}
