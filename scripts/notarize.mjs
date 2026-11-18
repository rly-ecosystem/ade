import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sign } from '@electron/osx-sign';

const root = fileURLToPath(new URL('../', import.meta.url));
const version = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
const name = 'RLY ADE.app';
const run = (tool, args) => execFileSync(tool, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function signingIdentity() {
  const kind = 'Developer ID Application';
  const selected = process.env.ADE_SIGN_IDENTITY?.toUpperCase();
  const listing = run('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning']);
  const identities = [...listing.matchAll(/^\s*\d+\) ([\dA-F]{40}) "([^"]+)"/gm)];
  const matches = new Set(identities.filter(([, hash, name]) =>
    name.startsWith(kind + ':') && (!selected || hash === selected)).map(([, hash]) => hash));
  if (matches.size !== 1) throw new Error('Требуется один доступный сертификат ' + kind + ' с закрытым ключом. При нескольких укажите его SHA-1 в ADE_SIGN_IDENTITY.');
  return [...matches][0];
}

async function prepare() {
  const [zip, expected, mode, ...rest] = process.argv.slice(2);
  if (!zip || !/^[0-9a-f]{64}$/i.test(expected || '') || (mode && mode !== '--check') || rest.length)
    throw new Error('npm run notarize -- <release.zip> <SHA-256> [--check]');
  const checkOnly = mode === '--check';
  const identity = checkOnly ? '-' : signingIdentity();
  const profile = process.env.ADE_NOTARY_PROFILE || 'RLY-ADE';
  const notary = args => JSON.parse(run('/usr/bin/xcrun', ['notarytool', ...args, '--keychain-profile', profile, '--output-format', 'json']));
  if (!checkOnly) notary(['history']);

  const dist = path.join(root, 'dist');
  await mkdir(dist, { recursive: true });
  const work = await mkdtemp(path.join(dist, 'notary-work-'));
  try {
    const source = path.join(work, 'source.zip');
    await copyFile(zip, source);
    if (await digest(source) !== expected.toLowerCase()) throw new Error('Контрольная сумма исходного ZIP не совпала.');
    const input = path.join(work, 'input');
    run('/usr/bin/ditto', ['-x', '-k', source, input]);
    const app = path.join(input, name);
    const plist = path.join(app, 'Contents/Info.plist');
    const property = key => run('/usr/libexec/PlistBuddy', ['-c', 'Print :' + key, plist]);
    if (property('CFBundleIdentifier') !== 'local.rly.ade' || property('CFBundleShortVersionString') !== version)
      throw new Error('В архиве другое приложение или версия.');
    const verify = bundle => run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
    verify(app);
    const arch = run('/usr/bin/lipo', ['-archs', path.join(app, 'Contents/MacOS', property('CFBundleExecutable'))]);
    if (arch !== 'arm64') throw new Error('Этот релиз выпускается для Apple Silicon.');

    await sign({
      app, identity, identityValidation: !checkOnly, platform: 'darwin', type: 'distribution',
      preAutoEntitlements: false, preEmbedProvisioningProfile: false,
      optionsForFile(file) {
        const processBundle = file.endsWith('.app') || file.includes('.app/Contents/MacOS/');
        return { hardenedRuntime: true, entitlements: processBundle ? ['com.apple.security.cs.allow-jit'] : [],
          ...(checkOnly ? { timestamp: 'none' } : {}) };
      },
    });
    verify(app);
    const archive = path.join(work, 'RLY-ADE-' + version + '-macOS-arm64.zip');
    const pack = () => run('/usr/bin/ditto', ['-c', '-k', '--keepParent', app, archive]);
    const requirement = '=identifier "local.rly.ade" and anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists';
    const verifyIdentity = bundle => run('/usr/bin/codesign', ['--verify', '--test-requirement', requirement, bundle]);
    let submission;
    if (!checkOnly) {
      verifyIdentity(app);
      pack();
      submission = notary(['submit', archive]).id;
      if (!submission) throw new Error('Apple не вернула ID отправки.');
      console.log('Apple Notary submission ID: ' + submission);
      const { status } = notary(['wait', submission]);
      if (status !== 'Accepted') throw new Error('Apple Notary: ' + status + '. Диагностика: xcrun notarytool log ' + submission + ' --keychain-profile ' + profile);
      run('/usr/bin/xcrun', ['stapler', 'staple', app]);
      await rm(archive);
    }
    pack();
    const unpacked = path.join(work, 'verify');
    run('/usr/bin/ditto', ['-x', '-k', archive, unpacked]);
    const delivered = path.join(unpacked, name);
    verify(delivered);
    if (checkOnly) {
      console.log('Проверены исходный SHA-256, вложенные подписи и целостность приложения после распаковки ZIP.');
      return;
    }
    verifyIdentity(delivered);
    run('/usr/bin/xcrun', ['stapler', 'validate', delivered]);
    run('/usr/bin/syspolicy_check', ['distribution', delivered]);
    run('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=4', delivered]);
    execFileSync(process.execPath, [path.join(root, 'tests/desktop.e2e.cjs')], {
      cwd: root, stdio: 'inherit', env: { ...process.env, ADE_TEST_EXECUTABLE: path.join(delivered, 'Contents/MacOS', property('CFBundleExecutable')) },
    });
    const output = path.join(work, 'verified');
    await mkdir(output);
    await writeFile(path.join(output, 'SHA256SUMS.txt'), await digest(archive) + '  ' + path.basename(archive) + '\n');
    await rename(archive, path.join(output, path.basename(archive)));
    const final = path.join(dist, 'notarized-' + submission);
    await rename(output, final);
    console.log('Нотарифицированный ZIP и SHA256SUMS.txt:\n' + final);
  } finally { await rm(work, { recursive: true, force: true }); }
}

prepare().catch(error => { console.error(error.message); process.exitCode = 1; });
