'use strict';
const { desktopPage, resizeDesktop } = require('./ui-helpers.cjs');
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const root = path.resolve(__dirname, '..'), directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-usability-'));
const repo = path.join(directory, 'project'), bin = path.join(directory, 'bin'), userData = path.join(directory, 'user-data');
fs.mkdirSync(repo); fs.mkdirSync(bin);
for (const provider of ['codex', 'claude']) {
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'cli.cjs'), path.join(bin, provider));
  fs.chmodSync(path.join(bin, provider), 0o755);
}
const errors = [], checks = [], contrast = [];
let app;
async function launch() {
  const executablePath = process.env.ADE_TEST_EXECUTABLE;
  app = await electron.launch({ ...(executablePath ? { executablePath, args: [] } : { args: [path.join(root, 'apps', 'desktop')] }), env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH, ADE_USER_DATA: userData } });
  const page = await desktopPage(app);
  page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('heading', { name: 'Что будем делать?', exact: true }).waitFor();
  return page;
}
async function openTask(page, title) {
  await page.getByRole('navigation', { name: 'Разделы', exact: true }).getByRole('button', { name: 'Задачи', exact: true }).click();
  await page.getByRole('button', { name: new RegExp(title) }).click();
  await page.getByRole('heading', { name: title, exact: true }).waitFor();
}
async function sidebarChecks(page) {
  const toggle = page.getByRole('button', { name: 'Показать проекты', exact: true });
  await toggle.click();
  const dialog = page.getByRole('dialog', { name: 'Навигация', exact: true });
  await dialog.waitFor();
  assert.equal(await dialog.getAttribute('aria-modal'), 'true');
  assert.equal(await page.locator('.content').evaluate(element => element.inert), true);
  const first = dialog.getByRole('button', { name: 'RLY ADE, главная', exact: true });
  const last = dialog.getByRole('button', { name: 'Настройки', exact: true });
  await page.waitForFunction(() => document.querySelector('.brand-button') === document.activeElement);
  await first.press('Shift+Tab'); assert.equal(await last.evaluate(element => element === document.activeElement), true);
  await last.press('Tab'); assert.equal(await first.evaluate(element => element === document.activeElement), true);
  await first.press('Escape'); await dialog.waitFor({ state: 'hidden' });
  assert.equal(await toggle.evaluate(element => element === document.activeElement), true);
  assert.equal(await page.locator('.content').evaluate(element => element.inert), false);
  await toggle.click(); await page.getByRole('button', { name: 'Скрыть проекты', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await toggle.click(); await page.getByRole('button', { name: 'Закрыть панель проектов', exact: true }).click({ position: { x: 300, y: 350 } });
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(await toggle.evaluate(element => element === document.activeElement), true);
}
(async () => {
  let page = await launch();
  await app.evaluate(({ dialog }, repo) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [repo] }); }, repo);
  await page.getByRole('button', { name: 'Подключить проект', exact: true }).click();
  for (const title of ['Первая задача', 'Вторая задача']) {
    await page.getByRole('textbox', { name: 'Задача', exact: true }).fill(title);
    await page.getByRole('button', { name: 'Сохранить задачу', exact: true }).click();
    await page.getByRole('heading', { name: title, exact: true }).waitFor();
    await page.getByRole('textbox', { name: 'Сообщение', exact: true }).fill(title + '\nОтдельный черновик');
    await page.getByRole('navigation', { name: 'Разделы', exact: true }).getByRole('button', { name: 'Новая задача', exact: true }).click();
  }
  await openTask(page, 'Первая задача');
  assert.equal(await page.getByRole('textbox', { name: 'Сообщение', exact: true }).inputValue(), 'Первая задача\nОтдельный черновик');
  await openTask(page, 'Вторая задача');
  assert.equal(await page.getByRole('textbox', { name: 'Сообщение', exact: true }).inputValue(), 'Вторая задача\nОтдельный черновик');
  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  await openTask(page, 'Первая задача');
  assert.equal(await page.getByRole('textbox', { name: 'Сообщение', exact: true }).inputValue(), 'Первая задача\nОтдельный черновик');
  await page.reload(); await page.getByRole('heading', { name: 'Что будем делать?', exact: true }).waitFor();
  await openTask(page, 'Первая задача');
  assert.equal(await page.getByRole('textbox', { name: 'Сообщение', exact: true }).inputValue(), 'Первая задача\nОтдельный черновик');
  await app.close(); app = null;
  page = await launch(); await openTask(page, 'Вторая задача');
  assert.equal(await page.getByRole('textbox', { name: 'Сообщение', exact: true }).inputValue(), 'Вторая задача\nОтдельный черновик');
  checks.push('independent drafts; navigation; reload; full application restart');

  await page.getByRole('button', { name: 'Сохранить сообщение', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#local-composer').value === '');
  await openTask(page, 'Первая задача');
  assert.equal(await page.getByRole('textbox', { name: 'Сообщение', exact: true }).inputValue(), 'Первая задача\nОтдельный черновик');
  await openTask(page, 'Вторая задача');
  assert.equal(await page.getByRole('textbox', { name: 'Сообщение', exact: true }).inputValue(), '');
  const saved = await page.evaluate(async () => {
    const data = (await window.ade.call('bootstrap', {})).value;
    const task = data.tasks.find(task => task.title === 'Вторая задача');
    return (await window.ade.call('task.get', { taskId: task.id })).value.events.filter(event => event.type === 'message.created').length;
  });
  assert.equal(saved, 2);
  checks.push('acknowledged send clears only its own draft; no duplicate messages');

  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) { if (key.startsWith('ade:reply:')) throw new DOMException('Full', 'QuotaExceededError'); return original.call(this, key, value); };
  });
  await page.getByRole('textbox', { name: 'Сообщение', exact: true }).fill('Текст при заполненном хранилище');
  await page.getByRole('alert').filter({ hasText: 'Не удалось сохранить черновик' }).waitFor();
  assert.equal(await page.getByRole('textbox', { name: 'Сообщение', exact: true }).inputValue(), 'Текст при заполненном хранилище');
  await page.getByRole('button', { name: 'Сохранить сообщение', exact: true }).click();
  await page.getByText('Текст при заполненном хранилище', { exact: true }).waitFor();
  checks.push('storage quota error is visible; text remains editable and can be saved');
  await page.reload(); await page.getByRole('heading', { name: 'Что будем делать?', exact: true }).waitFor();
  await openTask(page, 'Вторая задача');

  // Archive between editing and refresh to exercise a rejected save with the real runtime.
  await page.getByRole('textbox', { name: 'Сообщение', exact: true }).fill('Сохранить после ошибки');
  await page.evaluate(async () => {
    const data = (await window.ade.call('bootstrap', {})).value;
    const task = data.tasks.find(task => task.title === 'Вторая задача');
    const archived = await window.ade.call('task.archive', { taskId: task.id, archived: true });
    if (!archived.ok) throw new Error(archived.error);
    document.querySelector('.local-task-bottom form').requestSubmit();
  });
  await page.getByRole('alert').waitFor();
  assert.equal(await page.getByRole('textbox', { name: 'Сообщение', exact: true }).inputValue(), 'Сохранить после ошибки');
  await page.evaluate(async () => {
    const data = (await window.ade.call('bootstrap', {})).value;
    const task = data.tasks.find(task => task.title === 'Вторая задача');
    await window.ade.call('task.archive', { taskId: task.id, archived: false });
  });
  await page.getByRole('button', { name: 'Обновить данные', exact: true }).click();
  checks.push('rejected message preserves its draft');

  for (const theme of ['dark', 'light']) {
    await page.getByRole('button', { name: 'Настройки', exact: true }).click();
    await page.getByRole('combobox', { name: 'Тема', exact: true }).selectOption(theme);
    await openTask(page, 'Первая задача');
    await resizeDesktop(app, page, 320, 720); await sidebarChecks(page);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    contrast.push(await page.evaluate(theme => {
      const luminance = rgb => rgb.match(/[\d.]+/g).slice(0, 3).map(Number).map(c => { c /= 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; }).reduce((sum, c, i) => sum + c * [.2126, .7152, .0722][i], 0);
      const ratio = (a, b) => (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
      const app = getComputedStyle(document.querySelector('.app')), caption = getComputedStyle(document.querySelector('.local-task-phase'));
      return { theme, text: ratio(luminance(app.color), luminance(app.backgroundColor)), muted: ratio(luminance(caption.color), luminance(app.backgroundColor)) };
    }, theme));
    await page.screenshot({ path: path.join(root, 'logs', 'usability-' + theme + '-320.png') });
    await page.getByRole('button', { name: 'Показать проекты', exact: true }).click();
    await page.screenshot({ path: path.join(root, 'logs', 'usability-' + theme + '-navigation.png') });
    await resizeDesktop(app, page, 1280, 860);
    await page.waitForFunction(() => !document.querySelector('.content').inert);
    await page.getByRole('navigation', { name: 'Разделы', exact: true }).getByRole('button', { name: 'Задачи', exact: true }).click();
    await page.getByRole('button', { name: /Первая задача/ }).click();
  }
  assert.ok(contrast.every(pair => pair.text >= 4.5 && pair.muted >= 4.5));
  checks.push('both themes: modal semantics; focus trap; Escape/button/backdrop; focus return; 320px; expand to desktop; measured text contrast');

  await resizeDesktop(app, page, 1200, 860, 2);
  await sidebarChecks(page);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByRole('button', { name: 'Ход задачи', exact: true }).click();
  assert.equal(await page.locator('.task-inspector').evaluate(element => getComputedStyle(element).animationName), 'none');
  await page.screenshot({ path: path.join(root, 'logs', 'usability-zoom.png') });
  checks.push('200% zoom; reduced motion');
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(root, 'logs', 'usability-verification.json'), JSON.stringify({ passed: true, packaged: !!process.env.ADE_TEST_EXECUTABLE, checks, contrast, errors }, null, 2));
  console.log('PASS usability GUI: persistent task drafts; failed save; storage full; modal navigation; themes; 320px; 200% zoom');
})().catch(async error => {
  if (app) { try { await (await app.firstWindow()).screenshot({ path: path.join(root, 'logs', 'usability-failure.png') }); } catch {} }
  console.error(error); process.exitCode = 1;
}).finally(async () => { if (app) await app.close(); fs.rmSync(directory, { recursive: true, force: true }); });
