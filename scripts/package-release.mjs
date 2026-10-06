import { parseArgs } from 'node:util';
import { readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { root, extensionRoot, targets, hashFile, loadRuntimeManifest, runtimeConfig } from './lib/runtime-tools.mjs';
import { Zip, vsixName, verifyVsix } from './lib/vsix-tools.mjs';
const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  'sender-only': { type: 'boolean' }, 'collect-only': { type: 'boolean' },
  'runtime-manifest': { type: 'string' },
} });
if (values['runtime-manifest']) await loadRuntimeManifest(values['runtime-manifest']);
const { version: sourceVersion } = JSON.parse(await readFile(join(extensionRoot, 'package.json'), 'utf8'));
const version = positionals[0] || sourceVersion;
if (!/^\d+\.\d+\.\d+$/.test(version) || version !== sourceVersion) throw new Error('Release version must match packages/vscode/package.json');
if (values['sender-only'] && values['collect-only']) throw new Error('Choose sender-only or collect-only');
const directory = join(root, 'artifacts', `v${version}`);
const senderZipName = `Vcodex-Chamber-WindowsSender-${version}-win-x64.zip`;
if (!values['collect-only']) {
  const senderDirectory = join(directory, 'windows-x64');
  for (const file of ['WindowsSender.WinUI.exe', 'WindowsSender.WinUI.dll', 'LICENSE.txt', 'README.md']) await access(join(senderDirectory, file));
  const zip = new Zip();
  zip.addLocalFolder(senderDirectory, `Vcodex-Chamber-WindowsSender-${version}`);
  if (zip.getEntries().some(entry => /(?:^|\/)(?:.*\.log|auth\.json|settings\.json|plan\.md)$/.test(entry.entryName))) throw new Error('Private file in WindowsSender ZIP');
  const zipPath = join(directory, senderZipName);
  zip.writeZip(zipPath);
  await writeFile(zipPath + '.sha256', `${await hashFile(zipPath)}  ${senderZipName}\n`);
  console.log(`Created ${senderZipName}`);
}
if (!values['sender-only']) {
  const checksums = [];
  for (const target of targets) {
    const name = vsixName(version, target), file = join(directory, name);
    await verifyVsix(file, target);
    checksums.push(`${await hashFile(file)}  ${name}`);
  }
  const sender = new Zip(join(directory, senderZipName));
  if (!sender.getEntry(`Vcodex-Chamber-WindowsSender-${version}/WindowsSender.WinUI.exe`)) throw new Error('WindowsSender ZIP is incomplete');
  checksums.push(`${await hashFile(join(directory, senderZipName))}  ${senderZipName}`);
  await writeFile(join(directory, 'codex-runtime.json'), JSON.stringify(runtimeConfig, null, 2) + '\n');
  checksums.push(`${await hashFile(join(directory, 'codex-runtime.json'))}  codex-runtime.json`);
  await writeFile(join(directory, 'SHA256SUMS.txt'), checksums.join('\n') + '\n');
  console.log(`Verified four platform VSIX files and WindowsSender ZIP; SHA256SUMS.txt: ${directory}`);
}
