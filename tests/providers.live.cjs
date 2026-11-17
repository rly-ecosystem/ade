'use strict';
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { trustProject } = require('./ui-helpers.cjs');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-live-'));
const repo = path.join(directory, 'live-project');
execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'ignore' });
const root = path.resolve(__dirname, '..');
let app;
async function complete(page, expected) {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const approvals = page.getByRole('region', { name: 'Запрос разрешения', exact: true });
    for (let index = await approvals.count() - 1; index >= 0; index--) {
      const request = approvals.nth(index), details = await request.locator('pre').innerText();
      const command = details.split('\n')[0];
      const skillRead = /^\/bin\/(?:zsh|bash) -lc 'cat ([/A-Za-z0-9._ -]+\/SKILL\.md)'$/.exec(command);
      const readsInstructions = skillRead && skillRead[1].startsWith(path.join(os.homedir(), '.codex', 'skills') + path.sep);
      const inner = command.replace(/^\/bin\/(?:zsh|bash) -lc /, '').replace(/^(['"])([\s\S]*)\1$/, '$2');
      const readsProject = !/[|<>`$\n]|--pre/.test(inner) && inner.split(';').every(part => /^(pwd|git status(?: --short)?|rg --files(?: .*)?|ls(?: -[a-z]+)?)$/.test(part.trim()));
      const permitted = (/ade-demo\.txt/.test(details) || readsInstructions || readsProject) && !/curl |wget |rm -|https?:\/\//i.test(details);
      await request.getByRole('button', { name: permitted ? 'Разрешить один раз' : 'Отклонить', exact: true }).click();
    }
    const phase = await page.locator('.local-task-phase').innerText();
    if (phase === 'Шаг завершён' && await page.getByRole('main').getAttribute('aria-busy') === 'false') { assert.equal(fs.readFileSync(path.join(repo, 'ade-demo.txt'), 'utf8').trim(), expected); return; }
    if (['Ошибка выполнения', 'Лимит провайдера', 'Остановлена'].includes(phase)) throw new Error(phase + ': ' + await page.locator('.local-run-error').innerText());
    await page.waitForTimeout(200);
  }
  throw new Error('Live task exceeded 180 seconds');
}
async function run() {
  const claudeOnly = process.env.ADE_LIVE_ONLY === 'claude';
  const executablePath = process.env.ADE_TEST_EXECUTABLE;
  app = await electron.launch({ ...(executablePath ? { executablePath, args: [] } : { args: [path.join(root, 'apps', 'desktop')] }), env: { ...process.env, ADE_USER_DATA: path.join(directory, 'user-data') } });
  const page = await app.firstWindow(); page.setDefaultTimeout(30000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('heading', { name: 'Что будем делать?' }).waitFor();
  await app.evaluate(({ dialog }, repo) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [repo] }); }, repo);
  await page.getByRole('button', { name: 'Подключить проект', exact: true }).click();
  await page.getByRole('textbox', { name: 'Задача', exact: true }).fill('This is a plain text-file integration check, no UI is being created. Antislop mode: after. Create ade-demo.txt in this repository with exactly CODEX_READY followed by a newline. Use file editing tools. Do not use network, commit, publish, deploy or create any other file. Report the result briefly.');
  await page.getByRole('button', { name: 'Сохранить задачу', exact: true }).click();
  await trustProject(page);
  if (claudeOnly) { await page.getByRole('combobox', { name: 'Исполнитель', exact: true }).selectOption('claude'); await page.getByRole('textbox', { name: 'Модель', exact: true }).fill('sonnet'); }
  await page.getByRole('button', { name: claudeOnly ? 'Запустить Claude' : 'Запустить Codex', exact: true }).click();
  await complete(page, 'CODEX_READY');
  console.log('PASS live first file: ' + (claudeOnly ? 'Claude' : 'Codex'));
  await page.screenshot({ path: path.join(root, 'logs', 'live-codex.png') });
  if (claudeOnly) { console.log('PASS live Claude direct GUI task'); return; }
  await page.getByRole('textbox', { name: 'Сообщение', exact: true }).fill('Continue this same task with Claude. Read ade-demo.txt, verify the Codex result is CODEX_READY, then replace the file content with exactly CLAUDE_CONTINUED followed by a newline. Use file editing tools; do not use network, commit, publish, deploy or change other files. Report what the previous executor did and your change briefly.');
  await page.getByRole('button', { name: 'Сохранить сообщение', exact: true }).click();
  await page.getByRole('combobox', { name: 'Исполнитель', exact: true }).selectOption('claude');
  await page.getByRole('textbox', { name: 'Модель', exact: true }).fill('sonnet');
  await page.getByRole('button', { name: 'Продолжить Claude', exact: true }).click();
  await complete(page, 'CLAUDE_CONTINUED');
  await page.screenshot({ path: path.join(root, 'logs', 'live-claude.png') });
  const state = await page.evaluate(async () => { const data = await window.ade.call('bootstrap', {}); if (!data.ok) throw new Error(data.error); const detail = await window.ade.call('task.get', { taskId: data.value.tasks[0].id }); if (!detail.ok) throw new Error(detail.error); return detail.value; });
  assert.equal(state.runs.length, 2); assert.ok(state.runs.every(run => run.status === 'completed'));
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(root, 'logs', 'live-providers-verification.json'), JSON.stringify({ passed: true, packaged: !!executablePath, providers: state.runs.map(run => ({ provider: run.provider, status: run.status, generation: run.generation, checkpointId: run.checkpointId })), output: fs.readFileSync(path.join(repo, 'ade-demo.txt'), 'utf8'), errors }, null, 2));
  console.log('PASS live: Codex writes a real file; Claude continues the same saved task and updates it.');
}
run().catch(async error => { if (app) { try { const page = await app.firstWindow(); await page.screenshot({ path: path.join(root, 'logs', 'live-failure.png') }); } catch {} } console.error(error); process.exitCode = 1; }).finally(async () => { if (app) await app.close(); fs.rmSync(directory, { recursive: true, force: true }); });
