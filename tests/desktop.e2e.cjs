'use strict';

const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { trustProject } = require('./ui-helpers.cjs');

const root = path.resolve(__dirname, '..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-desktop-'));
const repo = path.join(directory, 'test-project');
const userData = path.join(directory, 'app-data');
const bin = path.join(directory, 'bin');
fs.mkdirSync(bin);
for (const provider of ['codex', 'claude']) { fs.copyFileSync(path.join(__dirname, 'fixtures', 'cli.cjs'), path.join(bin, provider)); fs.chmodSync(path.join(bin, provider), 0o755); }
fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'pipe' });
fs.writeFileSync(path.join(repo, 'readme.txt'), 'original\n');
const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
git('add', '.'); git('-c', 'user.name=ADE Test', '-c', 'user.email=ade@example.invalid', 'commit', '-m', 'fixture');
fs.writeFileSync(path.join(repo, 'readme.txt'), 'staged implementation\n'); git('add', '.');
fs.writeFileSync(path.join(repo, 'readme.txt'), 'working implementation\n');
fs.writeFileSync(path.join(repo, 'new file.txt'), 'new file\n');
const originalIndex = fs.readFileSync(path.join(repo, '.git', 'index'));
const errors = [];
const checks = [];
let app;

async function launch() {
  const executablePath = process.env.ADE_TEST_EXECUTABLE;
  app = await electron.launch({ ...(executablePath ? { executablePath, args: [] } : { args: [path.join(root, 'apps', 'desktop')] }), env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH, ADE_USER_DATA: userData } });
  const page = await app.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('heading', { name: 'Что будем делать?' }).waitFor();
  return page;
}

async function choose(directoryOrNull) {
  await app.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({ canceled: selected === null, filePaths: selected === null ? [] : [selected] });
  }, directoryOrNull);
}

async function run() {
  let page = await launch();
  assert.equal(await page.getByRole('navigation', { name: 'Проекты', exact: true }).locator('li').count(), 0);
  assert.deepEqual(await page.evaluate(() => [typeof window.require, typeof window.process]), ['undefined', 'undefined']);
  const denied = await page.evaluate(() => window.ade.call('project.add', { path: '/' }));
  assert.equal(denied.ok, false);
  checks.push('empty state; isolated renderer; unknown IPC rejected');

  await choose(null); await page.getByRole('button', { name: 'Подключить проект', exact: true }).click();
  await page.getByRole('button', { name: 'Подключить проект', exact: true }).waitFor({ state: 'visible' });
  await choose(path.join(directory, 'missing')); await page.getByRole('button', { name: 'Подключить проект', exact: true }).click();
  await page.getByRole('alert').waitFor();
  assert.match(await page.getByRole('alert').innerText(), /папку проекта/);
  await page.getByRole('button', { name: 'Обновить данные', exact: true }).click();
  await choose(repo); await page.getByRole('button', { name: 'Подключить проект', exact: true }).click();
  await page.getByRole('combobox', { name: 'Проект для задачи', exact: true }).waitFor();
  await page.getByRole('combobox', { name: 'Проект для задачи', exact: true }).selectOption(await page.getByRole('combobox', { name: 'Проект для задачи', exact: true }).inputValue());
  await page.getByRole('button', { name: 'Подключить папку проекта', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.local-status')?.textContent?.startsWith('Подключён'));
  assert.equal(await page.getByRole('navigation', { name: 'Проекты', exact: true }).locator('li').count(), 1);
  checks.push('folder picker: cancel, invalid directory and real repository');

  await page.getByRole('textbox', { name: 'Задача', exact: true }).fill('Первый рабочий сценарий\nПроверить сохранение проекта и задачи.');
  await page.getByRole('button', { name: 'Сохранить задачу', exact: true }).click();
  await page.getByRole('heading', { name: 'Первый рабочий сценарий', exact: true }).waitFor();
  const payload = '<img src=x onerror="window.injected=true">';
  await page.getByRole('textbox', { name: 'Сообщение', exact: true }).fill(payload);
  await page.getByRole('button', { name: 'Сохранить сообщение', exact: true }).click();
  await page.getByText(payload, { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.injected), undefined);
  await trustProject(page);
  assert.equal(await page.evaluate(async () => (await window.ade.call('bootstrap', {})).value.projects[0].trusted), true);
  await page.getByRole('button', { name: 'Запустить Codex', exact: true }).click();
  await page.getByRole('button', { name: 'Разрешить один раз', exact: true }).click();
  await page.getByText('CODEX_FIXTURE_RESULT', { exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector('.local-task-phase')?.textContent === 'Шаг завершён');
  await page.screenshot({ path: path.join(root, 'logs', 'desktop-task.png') });
  checks.push('create task; safe text; project trust; provider stream and one-time approval (fixture CLI)');

  await app.close(); app = null;
  page = await launch();
  await page.getByRole('button', { name: /Первый рабочий сценарий/ }).click();
  await page.getByText(payload, { exact: true }).waitFor();
  await page.getByText('CODEX_FIXTURE_RESULT', { exact: true }).waitFor();
  checks.push('full application restart retains projects, tasks, messages and event history');

  const runtimePid = await page.evaluate(async () => (await window.ade.call('runtime.health', {})).value.pid);
  assert.ok(runtimePid, 'A separate runtime utility process must exist');
  const nextWindow = app.waitForEvent('window');
  await app.evaluate(async ({ app, BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    await new Promise(resolve => { win.once('closed', resolve); win.close(); });
    app.emit('activate');
  });
  page = await nextWindow;
  page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('heading', { name: 'Что будем делать?' }).waitFor();
  assert.equal(await page.evaluate(async () => (await window.ade.call('runtime.health', {})).value.pid), runtimePid);
  await page.getByRole('textbox', { name: 'Задача', exact: true }).fill('[FIXTURE_WAIT]');
  await page.getByRole('button', { name: 'Сохранить задачу', exact: true }).click();
  await page.getByRole('button', { name: 'Запустить Codex', exact: true }).click();
  await page.getByText('SAVED_PARTIAL_OUTPUT', { exact: true }).waitFor();
  const helperPid = Number(fs.readFileSync(path.join(repo, 'fixture-helper.pid'), 'utf8'));
  await app.evaluate(async (_electron, pid) => { process.kill(pid, 'SIGKILL'); await new Promise(resolve => setTimeout(resolve, 150)); }, runtimePid);
  await page.reload();
  await page.getByRole('heading', { name: 'Что будем делать?' }).waitFor();
  await page.getByRole('button', { name: /FIXTURE_WAIT/ }).click();
  await page.getByText('SAVED_PARTIAL_OUTPUT', { exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector('.local-task-phase')?.textContent === 'Прервана после сбоя');
  assert.equal(execFileSync('/bin/ps', ['-axo', 'pid=,stat='], { encoding: 'utf8' }).split('\n').some(line => { const [pid, state] = line.trim().split(/\s+/); return Number(pid) === helperPid && !state?.startsWith('Z'); }), false);
  assert.notEqual(await page.evaluate(async () => (await window.ade.call('runtime.health', {})).value.pid), runtimePid);
  checks.push('window closure leaves runtime alive; actual runtime crash recovers persisted state');

  await page.getByRole('region', { name: 'Задача', exact: true }).getByRole('button', { name: 'Изменения Git', exact: true }).click();
  await page.getByText('readme.txt', { exact: true }).waitFor();

  await page.getByRole('navigation', { name: 'Разделы', exact: true }).getByRole('button', { name: 'Изменения Git', exact: true }).click();
  await page.getByText('readme.txt', { exact: true }).waitFor();
  await page.getByText('new file.txt', { exact: true }).waitFor();
  assert.match(await page.locator('.local-diff').first().innerText(), /staged implementation/);
  assert.match(await page.locator('.local-diff').last().innerText(), /working implementation/);
  await page.getByRole('button', { name: 'Обновить изменения', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.local-git')?.getAttribute('aria-busy') === 'false');
  assert.deepEqual(fs.readFileSync(path.join(repo, '.git', 'index')), originalIndex);
  await page.screenshot({ path: path.join(root, 'logs', 'desktop-git.png') });
  checks.push('real staged/unstaged/untracked Git; refresh; index unchanged');

  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  await page.getByRole('button', { name: 'Проверить подключения', exact: true }).click();
  await page.getByRole('combobox', { name: 'Тема', exact: true }).selectOption('light');
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.app')).backgroundColor === 'rgb(245, 245, 245)');
  await page.screenshot({ path: path.join(root, 'logs', 'desktop-light.png') });
  await page.getByRole('combobox', { name: 'Тема', exact: true }).selectOption('dark');
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.app')).backgroundColor === 'rgb(34, 34, 34)');
  await page.getByRole('button', { name: 'Новая задача', exact: true }).click();
  await page.getByRole('button', { name: 'Пауза', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Пустить', exact: true }).getAttribute('aria-pressed'), 'true');
  await page.getByRole('button', { name: 'Пустить', exact: true }).click();
  await page.getByRole('button', { name: 'Покормить ASCII-рыбок', exact: true }).click({ position: { x: 50, y: 60 } });
  await page.getByRole('checkbox', { name: 'Кои', exact: true }).uncheck();
  assert.equal(await page.getByRole('button', { name: 'Покормить ASCII-рыбок', exact: true }).isVisible(), false);
  await page.getByRole('checkbox', { name: 'Кои', exact: true }).check();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByRole('button', { name: 'Без движения', exact: true }).waitFor();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  checks.push('both themes; pause/off/feed koi; reduced motion');

  await page.getByRole('searchbox', { name: 'Найти проект', exact: true }).fill('missing project');
  await page.getByText('Проект не найден.', { exact: true }).waitFor();
  await page.getByRole('searchbox', { name: 'Найти проект', exact: true }).fill('');
  await page.getByRole('navigation', {name:'Проекты',exact:true}).getByRole('button', { name: /^test-project/ }).click();
  await page.getByRole('navigation', { name: 'Разделы', exact: true }).getByRole('button', { name: 'Задачи', exact: true }).click();
  await page.getByRole('main').getByRole('button', { name: 'Новая задача', exact: true }).click();
  await page.getByRole('navigation', { name: 'Разделы', exact: true }).getByRole('button', { name: 'Задачи', exact: true }).click();
  await page.getByRole('button', { name: /Первый рабочий сценарий/ }).click();
  await page.getByRole('button', { name: 'RLY ADE, главная', exact: true }).click();
  await page.getByRole('button', { name: 'RLY', exact: true }).click();
  await page.getByRole('textbox', { name: 'Задача', exact: true }).fill('Черновик клавиатурой');
  await page.getByRole('textbox', { name: 'Задача', exact: true }).press('Meta+Enter');
  await page.getByRole('heading', { name: 'Черновик клавиатурой', exact: true }).waitFor();
  checks.push('project search and navigation; keyboard task submission');

  await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.setMinimumSize(320, 480); win.setSize(390, 720); });
  await page.getByRole('button', { name: 'Показать проекты', exact: true }).waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Показать проекты', exact: true }).click();
  assert.equal(await page.getByRole('dialog', { name: 'Навигация', exact: true }).isVisible(), true);
  await page.keyboard.press('Escape');
  await page.getByRole('dialog', { name: 'Навигация', exact: true }).waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.inputModality), 'keyboard');
  assert.equal(await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle), 'solid');
  await page.screenshot({ path: path.join(root, 'logs', 'desktop-narrow.png') });
  checks.push('390px layout; keyboard menu and Escape; no horizontal document overflow');

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 860));
  await page.getByRole('button', { name: 'Новая задача', exact: true }).click();
  await page.screenshot({ path: path.join(root, 'logs', 'desktop-home.png') });
  assert.deepEqual(errors, []);
  checks.push('no renderer exceptions');
  const report = { passed: true, packaged: !!process.env.ADE_TEST_EXECUTABLE, checks, errors };
  fs.writeFileSync(path.join(root, 'logs', process.env.ADE_TEST_EXECUTABLE ? 'packaged-verification.json' : 'desktop-verification.json'), JSON.stringify(report, null, 2));
  console.log('PASS desktop: ' + checks.length + ' scenarios' + (process.env.ADE_TEST_EXECUTABLE ? ' (packaged app)' : ''));
}

run().catch(async error => {
  if (app) { try { await (await app.firstWindow()).screenshot({ path: path.join(root, 'logs', 'desktop-failure.png') }); } catch {} }
  console.error(error); process.exitCode = 1;
}).finally(async () => {
  if (app) await app.close();
  fs.rmSync(directory, { recursive: true, force: true });
});
