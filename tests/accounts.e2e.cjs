'use strict';
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { trustProject, showInspector } = require('./ui-helpers.cjs');
const root = path.resolve(__dirname, '..'), directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-accounts-ui-'));
const bin = path.join(directory, 'bin'), repo = path.join(directory, 'project'), userData = path.join(directory, 'data'), global = path.join(directory, 'shared');
for (const folder of [bin, repo, global]) fs.mkdirSync(folder);
for (const provider of ['codex', 'claude']) { fs.copyFileSync(path.join(__dirname, 'fixtures', 'cli.cjs'), path.join(bin, provider)); fs.chmodSync(path.join(bin, provider), 0o755); }
fs.writeFileSync(path.join(bin, 'profiles-strict'), '1'); fs.writeFileSync(path.join(global, 'fixture-account.json'), 'GLOBAL_SENTINEL');
const errors = [], checks = []; let app;
async function launch() {
  const executablePath = process.env.ADE_TEST_EXECUTABLE;
  app = await electron.launch({ ...(executablePath ? { executablePath, args: [] } : { args: [path.join(root, 'apps/desktop')] }), env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH, ADE_USER_DATA: userData, CODEX_HOME: global, CLAUDE_CONFIG_DIR: global } });
  const page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('heading', { name: 'Что будем делать?', exact: true }).waitFor();
  await app.evaluate(({ shell }) => { shell.openExternal = async url => { globalThis.lastAuthTestUrl = url; }; });
  return page;
}
const state = page => page.evaluate(async () => (await window.ade.call('profiles.list', {})).value);
const details = page => page.getByRole('region', { name: 'Настройки аккаунта', exact: true });
async function create(page, provider, name) {
  await page.getByRole('button', { name: 'Добавить аккаунт', exact: true }).click();
  await page.getByRole('combobox', { name: 'Исполнитель нового аккаунта', exact: true }).selectOption(provider);
  await page.getByRole('textbox', { name: 'Название нового аккаунта', exact: true }).fill(name);
  await page.getByRole('button', { name: 'Создать профиль', exact: true }).click();
  await details(page).getByRole('heading', { name, exact: true }).waitFor();
  await page.waitForFunction(name => document.activeElement?.textContent === name, name);
  return (await state(page)).profiles.find(profile => profile.name === name);
}
async function pick(page, name) { await page.getByRole('navigation', { name: 'Аккаунты AI', exact: true }).getByRole('button', { name: new RegExp(name) }).click(); await details(page).getByRole('heading', { name, exact: true }).waitFor(); }
(async () => {
  let page = await launch();
  await page.getByRole('button', { name: 'Профили AI', exact: true }).click();
  await page.getByRole('heading', { name: 'Профили AI', exact: true }).waitFor();
  const codex = await create(page, 'codex', 'ChatGPT · тестовый аккаунт');
  assert.equal(codex.mode, 'siwc'); assert.equal(codex.state, 'signed_out');
  await details(page).getByRole('textbox', { name: 'Название профиля', exact: true }).fill('ChatGPT личный · fixture');
  await details(page).getByRole('button', { name: 'Сохранить название', exact: true }).click();
  await details(page).getByRole('heading', { name: 'ChatGPT личный · fixture', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Добавить аккаунт', exact: true }).click();
  await page.getByRole('textbox', { name: 'Название нового аккаунта', exact: true }).fill('chatgpt личный · fixture');
  await page.getByRole('button', { name: 'Создать профиль', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'уникальным' }).waitFor();
  await page.getByRole('textbox', { name: 'Название нового аккаунта', exact: true }).press('Escape');
  assert.equal(await page.getByRole('button', { name: 'Добавить аккаунт', exact: true }).evaluate(element => element === document.activeElement), true);
  checks.push('create; focus details; rename; duplicate validation; Escape and focus return');

  await details(page).getByRole('button', { name: 'Continue with ChatGPT', exact: true }).click();
  await details(page).getByRole('button', { name: 'Отменить вход', exact: true }).waitFor();
  const authUrl = await app.evaluate(() => globalThis.lastAuthTestUrl), auth = new URL(authUrl);
  assert.equal(auth.origin, 'https://auth.openai.com'); assert.equal(auth.searchParams.get('client_id'), 'dynamic_agent_client');
  assert.equal(await page.evaluate(() => window.ade.call('profile.login', { profileId: 'bad' })).then(value => value.ok), false);
  const denied = new URL(auth.searchParams.get('redirect_uri')); denied.searchParams.set('state', auth.searchParams.get('state')); denied.searchParams.set('error', 'access_denied');
  await fetch(denied);
  await details(page).getByText(/Вход отменён или доступ не предоставлен/).waitFor();
  assert.equal((await state(page)).selected.codex, 'shared-codex');
  await details(page).getByRole('button', { name: 'Continue with ChatGPT', exact: true }).click();
  await details(page).getByRole('button', { name: 'Отменить вход', exact: true }).click();
  await details(page).getByRole('button', { name: 'Continue with ChatGPT', exact: true }).waitFor();
  assert.equal(fs.existsSync(path.join(userData, 'accounts', codex.id, 'siwc-session.json')), false);
  checks.push('real production discovery; official authorize URL; real loopback denied callback; cancel; no renderer login operation or credentials');

  const a = await create(page, 'claude', 'Claude личный · fixture');
  fs.writeFileSync(path.join(bin, 'hold-login'), '1');
  await details(page).getByRole('button', { name: 'Войти через Claude CLI', exact: true }).click();
  await page.getByRole('textbox', { name: 'Код входа Claude', exact: true }).waitFor();
  await page.screenshot({ path: path.join(root, 'logs/accounts-pending-code.png') });
  await page.getByRole('textbox', { name: 'Код входа Claude', exact: true }).fill('FIXTURE_AUTH_CODE');
  await page.getByRole('button', { name: 'Передать код официальному CLI', exact: true }).click();
  await details(page).getByText('Вход выполнен · ещё не выбран', { exact: true }).waitFor();
  assert.equal(await details(page).getByRole('button', { name: 'Использовать аккаунт', exact: true }).evaluate(element => element.classList.contains('button-primary')), true);
  await details(page).getByRole('button', { name: 'Использовать аккаунт', exact: true }).click();
  await details(page).getByText('Вход выполнен · выбран для новых запусков', { exact: true }).waitFor();
  fs.rmSync(path.join(bin, 'hold-login'));
  const b = await create(page, 'claude', 'Claude рабочий · fixture');
  await details(page).getByRole('button', { name: 'Войти через Claude CLI', exact: true }).click();
  await details(page).getByRole('button', { name: 'Использовать аккаунт', exact: true }).click();
  await pick(page, a.name); await details(page).getByRole('button', { name: 'Выйти из аккаунта', exact: true }).click();
  assert.equal((await state(page)).selected.claude, b.id);
  assert.equal(fs.readFileSync(path.join(global, 'fixture-account.json'), 'utf8'), 'GLOBAL_SENTINEL');
  await pick(page, b.name); await details(page).getByRole('checkbox', { name: 'Использовать профиль', exact: true }).uncheck();
  await details(page).getByText('Отключён · выбран для новых запусков', { exact: true }).waitFor();
  await details(page).getByRole('checkbox', { name: 'Использовать профиль', exact: true }).check();
  await details(page).getByText('Вход выполнен · выбран для новых запусков', { exact: true }).waitFor();
  await page.locator('main[aria-busy=false]').waitFor();
  await page.getByRole('button', { name: 'Обновить профили', exact: true }).waitFor();
  await page.screenshot({ path: path.join(root, 'logs/accounts-dark.png'), animations: 'disabled' });
  checks.push('official CLI through PTY; code input; connected vs selected primary action; sibling/global isolation; disable and enable without fallback');

  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  await page.getByRole('combobox', { name: 'Тема', exact: true }).selectOption('light');
  await page.getByRole('button', { name: 'Профили AI', exact: true }).click();
  await details(page).getByRole('heading', { name: b.name, exact: true }).waitFor();
  await page.screenshot({ path: path.join(root, 'logs/accounts-light.png'), animations: 'disabled' });
  await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setMinimumSize(320, 480); window.setSize(320, 720); });
  await pick(page, a.name); assert.equal(await details(page).getByRole('heading', { name: a.name, exact: true }).evaluate(element => element === document.activeElement), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: path.join(root, 'logs/accounts-320.png') });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1200, 860));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(2));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.screenshot({ path: path.join(root, 'logs/accounts-zoom.png') });
  await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.webContents.setZoomFactor(1); window.setSize(1280, 860); });
  checks.push('remembered profile; light/dark; 320px focus and reflow; 200% zoom; reduced motion');

  await page.getByRole('button', { name: 'Новая задача', exact: true }).click();
  await app.evaluate(({ dialog }, repo) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [repo] }); }, repo);
  await page.getByRole('button', { name: 'Подключить проект', exact: true }).click();
  await page.getByRole('textbox', { name: 'Задача', exact: true }).fill('[PROFILE_ECHO] [PARALLEL_DELAY] Проверка отдельного аккаунта');
  await page.getByRole('button', { name: 'Сохранить задачу', exact: true }).click();
  await trustProject(page); await showInspector(page);
  await page.getByRole('combobox', { name: 'Исполнитель', exact: true }).selectOption('claude');
  await page.getByRole('button', { name: 'Запустить Claude', exact: true }).click();
  await page.getByRole('button', { name: 'Разрешить один раз', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.local-task-phase').textContent === 'Шаг завершён');
  await page.locator('.local-messages .message-profile').getByText(b.name, { exact: true }).waitFor();
  assert.match(await page.locator('.local-messages').innerText(), new RegExp('PROFILE ' + b.id));
  await page.getByText('Назначения ролей · не сохранены', { exact: true }).click();
  await page.getByRole('combobox', { name: 'Аккаунт: Исследование', exact: true }).selectOption(a.id);
  await page.getByRole('button', { name: 'Сохранить назначения', exact: true }).click();
  await page.screenshot({ path: path.join(root, 'logs/accounts-task.png') });
  const run = await page.evaluate(async () => { const data = (await window.ade.call('bootstrap', {})).value; return (await window.ade.call('task.get', { taskId: data.tasks[0].id })).value.runs.at(-1); });
  assert.equal(run.profileId, b.id); checks.push('actual fixture inference uses selected directory; actual profile shown in chat; per-role profile persists');

  await page.getByRole('button', {name: 'Профили AI', exact:true}).click();
  await pick(page, a.name);
  await details(page).getByRole('button', {name:'Войти через Claude CLI',exact:true}).click();
  await details(page).getByText('Вход выполнен · ещё не выбран',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Задачи',exact:true}).click();
  await page.getByRole('button',{name:/PROFILE_ECHO/}).click();
  await showInspector(page);
  const assignments = page.locator('.role-assignments');
  if (!await assignments.evaluate(el => el.open)) await assignments.locator(':scope > summary').click();
  for (const [role, account] of [['Планирование',a],['Исследование',b],['Разработка',b],['Ревью',a]]) {
    await page.getByRole('combobox',{name:'Исполнитель: '+role,exact:true}).selectOption('claude');
    await page.getByRole('combobox',{name:'Аккаунт: '+role,exact:true}).selectOption(account.id);
  }
  await page.getByRole('button',{name:'Запустить цепочку',exact:true}).click();
  await page.getByText('Параллельно · 2 участника',{exact:true}).waitFor();
  const active = page.locator('.role-progress li[data-current=true]');
  const labels = await active.locator('.role-profile').allTextContents();
  assert.deepEqual(labels.sort(), [a.name, b.name].sort());
  await page.screenshot({path:path.join(root,'logs/accounts-parallel.png'),animations:'disabled'});
  await page.getByRole('button',{name:'Разрешить один раз',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.local-task-phase')?.textContent==='Ожидает приёмки');
  const chain = await page.evaluate(async () => {
    const tasks=(await window.ade.call('bootstrap',{})).value.tasks;
    return (await window.ade.call('task.get',{taskId:tasks[0].id})).value.runs.slice(1);
  });
  assert.deepEqual(Object.fromEntries(chain.map(run=>[run.role,run.profileId])),{orchestrator:a.id,researcher:b.id,developer:b.id,reviewer:a.id});
  checks.push('four real fixture role processes use two isolated accounts; parallel assignments visible and verified');

  await app.close(); app = null;
  // UI-only first-use confirmation: verified OAuth storage itself is exercised by accounts.test.ts.
  const registryFile = path.join(userData, 'accounts/registry.json'), registry = JSON.parse(fs.readFileSync(registryFile));
  registry.profiles.find(profile => profile.id === codex.id).state = 'connected'; fs.writeFileSync(registryFile, JSON.stringify(registry));
  page = await launch(); const welcome = page.getByRole('dialog', { name: 'Вы используете ChatGPT plan', exact: true });
  await welcome.waitFor(); await welcome.getByRole('button', { name: 'Понятно', exact: true }).click(); await welcome.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Профили AI', exact: true }).click(); assert.equal((await state(page)).selected.claude, b.id);
  await app.close(); app = null; page = await launch(); assert.equal(await page.getByRole('dialog', { name: 'Вы используете ChatGPT plan', exact: true }).isVisible(), false);
  checks.push('restart preserves profiles and selection; first-use native confirmation appears once (UI fixture)');
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(root, 'logs/accounts-gui-verification.json'), JSON.stringify({ passed: true, packaged: !!process.env.ADE_TEST_EXECUTABLE, fixtureAccounts: true, liveSignInCompleted: false, checks, errors }, null, 2));
  console.log('PASS accounts GUI: profiles; real loopback denial; Claude fixture login/code; selection/isolation; actual fixture run; themes/narrow/zoom; first-use confirmation');
})().catch(async error => { if (app) { try { await (await app.firstWindow()).screenshot({ path: path.join(root, 'logs/accounts-failure.png') }); } catch {} } console.error(error); process.exitCode = 1; }).finally(async () => { if (app) await app.close(); fs.rmSync(directory, { recursive: true, force: true }); });
