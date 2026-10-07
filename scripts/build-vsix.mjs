import { parseArgs } from 'node:util';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { root, extensionRoot, targets, nativeTarget, targetInfo, prepareRuntime, stageRuntime, run, hashFile, selectBuildRuntime } from './lib/runtime-tools.mjs';
import { vsce, Zip, vsixName, setExecutableAttributes, verifyVsix } from './lib/vsix-tools.mjs';
import { selectBuildAudio } from './lib/codex-audio-tools.mjs';
import { armAudioId } from './lib/arm-audio-tools.mjs';
import { audioId } from './lib/codex-audio-releases.mjs';
import { buildArmAudioVsix } from './build-arm-audio-vsix.mjs';
import { embedAudioCompanion } from './lib/audio-companion.mjs';

const { values } = parseArgs({ options: {
  target: { type: 'string', default: nativeTarget },
  'skip-build': { type: 'boolean', default: false }, offline: { type: 'boolean', default: false },
  'codex-version': { type: 'string' }, 'runtime-manifest': { type: 'string' },
  'audio-version': { type: 'string' },
} });
const selected = values.target === 'all' ? targets : [...new Set(values.target.split(','))];
selected.forEach(targetInfo);
const selectedRuntime = await selectBuildRuntime({ version: values['codex-version'], manifest: values['runtime-manifest'], offline: values.offline });
const officialAudio = await selectBuildAudio(selectedRuntime, { version: values['audio-version'], offline: values.offline, pinned: values['codex-version'] === 'pinned' });
const { version } = JSON.parse(await readFile(join(extensionRoot, 'package.json'), 'utf8'));
const release = join(root, 'artifacts', `v${version}`);
await mkdir(release, { recursive: true });
const prepared = new Map();
const armAudio = selected.includes('linux-arm64') ? await buildArmAudioVsix({ offline: values.offline }) : undefined;
// Downloads are independent of the shared UI build. Limit download concurrency
// to two so local machines need not decompress four runtimes at once.
async function prepareAll() {
  for (let index = 0; index < selected.length; index += 2) {
    await Promise.all(selected.slice(index, index + 2).map(async target => prepared.set(target, await prepareRuntime(target, { offline: values.offline }))));
  }
}
await Promise.all([
  prepareAll(),
  values['skip-build'] ? readFile(join(extensionRoot, 'dist/extension.js')) : run(process.env.BUN_BIN || (process.platform === 'win32' ? 'bun.exe' : 'bun'), ['run', '--cwd', 'packages/vscode', 'build']),
]);
const ignore = await readFile(join(extensionRoot, '.vscodeignore'), 'utf8');
for (const target of selected) {
  const info = targetInfo(target);
  const staged = await stageRuntime(target, prepared.get(target));
  const ignoreFile = join(root, 'artifacts/build', `vsix-${target}.ignore`);
  await mkdir(join(root, 'artifacts/build'), { recursive: true });
  await writeFile(ignoreFile, `${ignore}\nbin/**\n!bin/${info.folder}/**\nnative/**\n`);
  const packagePath = join(release, vsixName(version, target));
  const manifestPath = join(extensionRoot, 'package.json');
  const originalManifest = await readFile(manifestPath, 'utf8');
  const targetManifest = JSON.parse(originalManifest);
  // The audited companion is installed from the bundled VSIX on first activation.
  // Marketplace dependencies cannot resolve our separately distributed ARM package.
  delete targetManifest.extensionPack;
  if (target !== 'linux-arm64') targetManifest.engines.vscode = selectedRuntime.audio.engine;
  const previous = { target: process.env.VCODEX_VSIX_TARGET, prebuilt: process.env.VCODEX_PACKAGE_PREBUILT };
  try {
    await writeFile(manifestPath, JSON.stringify(targetManifest, null, 2) + '\n');
    process.env.VCODEX_VSIX_TARGET = target;
    process.env.VCODEX_PACKAGE_PREBUILT = '1';
    await vsce.createVSIX({ cwd: extensionRoot, packagePath, target, ignoreFile, dependencies: false });
  } finally {
    await writeFile(manifestPath, originalManifest);
    if (previous.target === undefined) delete process.env.VCODEX_VSIX_TARGET; else process.env.VCODEX_VSIX_TARGET = previous.target;
    if (previous.prebuilt === undefined) delete process.env.VCODEX_PACKAGE_PREBUILT; else process.env.VCODEX_PACKAGE_PREBUILT = previous.prebuilt;
  }
  const metadata = JSON.parse(await readFile(join(staged, 'codex-package.json'), 'utf8'));
  const zip = new Zip(packagePath);
  await embedAudioCompanion(zip, target, target === 'linux-arm64' ? armAudio : officialAudio, {
    id: target === 'linux-arm64' ? armAudioId : audioId,
    version: target === 'linux-arm64' ? version : selectedRuntime.audio.version,
    engine: target === 'linux-arm64' ? '^1.85.0' : selectedRuntime.audio.engine,
  });
  setExecutableAttributes(zip, `extension/bin/${info.folder}/`, metadata.executableFiles);
  zip.writeZip(packagePath);
  await verifyVsix(packagePath, target, { verifyDist: true });
  await writeFile(packagePath + '.sha256', `${await hashFile(packagePath)}  ${vsixName(version, target)}\n`);
}
await writeFile(join(release, 'codex-runtime.json'), JSON.stringify(selectedRuntime, null, 2) + '\n');
console.log(`Platform VSIX files: ${release}; bundled Codex ${selectedRuntime.version}`);
