import { createRequire } from 'node:module';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
const root = resolve(import.meta.dirname, '..');
const require = createRequire(join(root, 'packages/vscode/package.json'));
const Zip = require('adm-zip');
const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version || '')) throw new Error('Expected MAJOR.MINOR.PATCH');
const directory = join(root, 'artifacts', `v${version}`);
const vsixPath = join(directory, `Vcodex-Chamber-${version}.vsix`);
const extensionZip = new Zip(vsixPath);
const manifest = JSON.parse(extensionZip.readAsText('extension/package.json'));
if (manifest.version !== version || manifest.displayName !== 'Vcodex-Chamber') throw new Error('Incorrect VSIX identity/version');
let checked = 0;
async function verifyDist(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) await verifyDist(file);
    else {
      const key = 'extension/' + file.slice(join(root, 'packages/vscode').length + 1).replaceAll('\\', '/');
      if (!extensionZip.readFile(key)?.equals(await readFile(file))) throw new Error(`VSIX mismatch: ${key}`);
      checked++;
    }
  }
}
await verifyDist(join(root, 'packages/vscode/dist'));
if (extensionZip.getEntries().some(entry => /(?:^|\/)(?:plan\.md|.*\.log|auth\.json|settings\.json)$/.test(entry.entryName))) throw new Error('Private file in VSIX');
const senderZipName = `Vcodex-Chamber-WindowsSender-${version}-win-x64.zip`;
const senderZip = new Zip();
senderZip.addLocalFolder(join(directory, 'windows-x64'), `Vcodex-Chamber-WindowsSender-${version}`);
senderZip.writeZip(join(directory, senderZipName));
const checksums = [];
for (const name of [`Vcodex-Chamber-${version}.vsix`, senderZipName]) {
  checksums.push(`${createHash('sha256').update(await readFile(join(directory, name))).digest('hex')}  ${name}`);
}
await writeFile(join(directory, 'SHA256SUMS.txt'), checksums.join('\n') + '\n');
console.log(`Verified ${checked} VSIX dist files; created WindowsSender ZIP and SHA256SUMS.txt`);
