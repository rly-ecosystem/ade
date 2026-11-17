import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
if (process.argv.includes('--tests') || process.argv.includes('--accounts')) {
  await mkdir('build', { recursive: true });
  const entry = process.argv.includes('--accounts') ? 'accounts' : 'runtime';
  await build({ entryPoints: ['tests/' + entry + '.test.ts'], bundle: true, platform: 'node', target: 'node22', format: 'cjs', outfile: 'build/' + entry + '.test.cjs' });
} else {
  const out = 'apps/desktop/dist';
  await mkdir(out + '/assets', { recursive: true });
  await mkdir(out + '/licenses', { recursive: true });
  await Promise.all([
    build({ entryPoints: { main: 'apps/desktop/src/main.ts', preload: 'apps/desktop/src/preload.ts', runtime: 'packages/runtime/src/entry.ts' }, bundle: true, platform: 'node', target: 'node22', format: 'cjs', outdir: out, outExtension: { '.js': '.cjs' }, external: ['electron'] }),
    build({ entryPoints: ['apps/desktop/src/renderer.tsx'], bundle: true, platform: 'browser', target: 'chrome140', format: 'iife', outfile: out + '/renderer.js', define: { 'process.env.NODE_ENV': '"production"' } }),
    copyFile('apps/desktop/src/index.html', out + '/index.html'),
    copyFile('apps/desktop/assets/ui/shell.css', out + '/assets/shell.css'),
    copyFile('apps/desktop/assets/ui/desktop.css', out + '/assets/desktop.css'),
    copyFile('apps/desktop/assets/ui/rly-logo.png', out + '/assets/rly-logo.png'),
    copyFile('apps/desktop/assets/koi.js', out + '/assets/koi.js'),
    copyFile('LICENSE', out + '/licenses/RLY-ADE.txt'),
    copyFile('NOTICE', out + '/licenses/NOTICE.txt'),
    copyFile('node_modules/scheduler/LICENSE', out + '/licenses/scheduler.txt'),
    copyFile('node_modules/react/LICENSE', out + '/licenses/react.txt'),
    copyFile('node_modules/react-dom/LICENSE', out + '/licenses/react-dom.txt'),
    copyFile('node_modules/marked/LICENSE', out + '/licenses/marked.txt'),
    copyFile('node_modules/prismjs/LICENSE', out + '/licenses/prismjs.txt'),
    copyFile('node_modules/jose/LICENSE.md', out + '/licenses/jose.txt'),
  ]);
  console.log('Built desktop, isolated runtime and accepted design assets.');
}
