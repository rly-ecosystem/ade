import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const require = createRequire(import.meta.url);
if (process.platform !== 'darwin') throw new Error('Local macOS packaging requires macOS.');
const source = path.join(root, 'apps', 'desktop', 'dist');
if (!fs.existsSync(path.join(source, 'main.cjs'))) throw new Error('Run npm run build first.');
const electron = path.resolve(require('electron'), '../../..');
if (path.basename(electron) !== 'Electron.app') throw new Error('Electron.app was not found.');
const output = path.join(root, 'dist', 'RLY ADE.app');
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.rmSync(output, { recursive: true, force: true });
fs.cpSync(electron, output, { recursive: true, verbatimSymlinks: true });
const resources = path.join(output, 'Contents', 'Resources');
fs.rmSync(path.join(resources, 'default_app.asar'), { force: true });
fs.cpSync(source, path.join(resources, 'app'), { recursive: true });
fs.writeFileSync(path.join(resources, 'app', 'package.json'), JSON.stringify({ name: 'rly-ade', productName: 'RLY ADE', version, main: 'main.cjs' }, null, 2));
const set = (file, key, value) => execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, file]);
const plist = path.join(output, 'Contents', 'Info.plist');
set(plist, 'CFBundleDisplayName', 'RLY ADE'); set(plist, 'CFBundleName', 'RLY ADE'); set(plist, 'CFBundleIdentifier', 'local.rly.ade');
set(plist, 'CFBundleShortVersionString', version); set(plist, 'CFBundleVersion', version);
set(plist, 'LSMinimumSystemVersion', '14.0');
for (const helper of fs.readdirSync(path.join(output, 'Contents', 'Frameworks'), { withFileTypes: true })) {
  if (!helper.isDirectory() || !helper.name.startsWith('Electron Helper') || !helper.name.endsWith('.app')) continue;
  const suffix = helper.name === 'Electron Helper.app' ? '.helper' : '.helper.' + helper.name.match(/\(([^)]+)\)/)[1].toLowerCase();
  set(path.join(output, 'Contents', 'Frameworks', helper.name, 'Contents', 'Info.plist'), 'CFBundleIdentifier', 'local.rly.ade' + suffix);
}
execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', '--preserve-metadata=entitlements,requirements,flags', output], { stdio: 'pipe' });
execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', output], { stdio: 'pipe' });
console.log(output);
