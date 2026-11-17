import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
for (const file of ['desktop.e2e.cjs', 'markdown.e2e.cjs', 'routing.e2e.cjs', 'workbench.e2e.cjs', 'usability.e2e.cjs', 'accounts.e2e.cjs', 'insights.e2e.cjs']) {
  const result = spawnSync(process.execPath, ['tests/' + file], { cwd: root, stdio: 'inherit', env: process.env, timeout: 180000 });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
