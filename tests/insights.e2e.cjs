'use strict';
const { _electron: electron } = require('playwright');
const { DatabaseSync } = require('node:sqlite');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const seed = require('./fixtures/insights.cjs');

const root = path.resolve(__dirname, '..'), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-stats-gui-'));
const userData = path.join(dir, 'data'), bin = path.join(dir, 'bin');
fs.mkdirSync(bin);
fs.mkdirSync(path.join(root, 'logs'), {recursive: true});
for (const provider of ['codex','claude']) {
  const target = path.join(bin, provider);
  fs.copyFileSync(path.join(__dirname, 'fixtures/cli.cjs'), target); fs.chmodSync(target, 0o755);
}
let app;
(async () => {
  const executablePath = process.env.ADE_TEST_EXECUTABLE;
  app = await electron.launch({ ...(executablePath ? { executablePath, args: [] } : { args: [path.join(root,'apps/desktop')] }), env: { ...process.env, ADE_USER_DATA: userData, PATH: bin + path.delimiter + process.env.PATH } });
  const page = await app.firstWindow(), errors=[];
  page.on('pageerror', e=>errors.push(e.message));
  await page.getByRole('heading',{name:'Что будем делать?'}).waitFor();
  const open = () => page.getByRole('button',{name:'Статистика',exact:true}).click();
  await open(); await page.getByRole('heading',{name:'За этот период запусков нет'}).waitFor();
  await page.locator('.usage-empty').getByRole('button',{name:'Новая задача'}).click();
  const filename = path.join(userData,'ade.sqlite'), db = new DatabaseSync(filename);
  for (const project of ['Studio','Archive']) {
    const folder = path.join(dir,project); fs.mkdirSync(folder);
    db.prepare('INSERT INTO projects(id,name,path,createdAt) VALUES(?,?,?,?)').run(project,project,folder,new Date().toISOString());
  }
  db.close(); seed(filename,new Date(),'Studio','Archive');
  await page.reload(); await page.getByRole('heading',{name:'Что будем делать?'}).waitFor(); await open();
  const stats = page.locator('.usage-page');
  await stats.getByText('Замерено запусков · 4 из 5',{exact:true}).waitFor();
  const ranking = stats.locator('.usage-ranking li');
  assert.match(await ranking.first().innerText(), /Текущий CLI Codex/);
  await stats.getByRole('combobox',{name:'Сортировка рейтинга'}).selectOption('completed');
  assert.match(await ranking.first().innerText(), /Текущий CLI Claude/);
  await stats.getByRole('combobox',{name:'Сортировка рейтинга'}).selectOption('tokens');
  await stats.getByRole('button',{name:/Пик за день/}).click();
  assert.match(await stats.locator('.usage-point').innerText(), /1.250 токенов/);
  const chart=stats.getByRole('group',{name:'Токены по дням'});
  await chart.locator('button[tabindex="0"]').focus(); await page.keyboard.press('Home');
  assert.equal(await chart.locator('button').first().evaluate(el=>el===document.activeElement),true);
  await page.keyboard.press('ArrowRight'); await page.keyboard.press('End');
  assert.equal(await chart.locator('button[tabindex="0"]').count(),1);
  await stats.getByText('Значения по дням',{exact:true}).click();
  assert.equal(await stats.getByRole('row').count(),8);
  await stats.getByText('Значения по дням',{exact:true}).click();
  await page.screenshot({path:path.join(root,'logs/insights-dark.png'),animations:'disabled'});
  await stats.getByRole('button',{name:'30 дней'}).click();
  await stats.getByText('Замерено запусков · 6 из 7',{exact:true}).waitFor();
  await stats.getByRole('combobox',{name:'Проект статистики'}).selectOption('Studio');
  await stats.getByText('Замерено запусков · 3 из 4',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Настройки',exact:true}).click();
  await page.getByRole('combobox',{name:'Тема'}).selectOption('light');
  await open(); await stats.getByText('Замерено запусков · 4 из 5',{exact:true}).waitFor();
  await page.screenshot({path:path.join(root,'logs/insights-light.png'),animations:'disabled'});
  await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.setMinimumSize(320,480);w.setSize(320,720);});
  await page.emulateMedia({reducedMotion:'reduce'});
  await stats.getByRole('button',{name:'30 дней'}).click();
  await stats.getByText('Замерено запусков · 6 из 7',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.screenshot({path:path.join(root,'logs/insights-320.png'),animations:'disabled'});
  assert.deepEqual(errors,[]);
  console.log('PASS insights GUI: empty, coverage, ranking, funnel, periods, scope, keyboard, exact values, themes and narrow layout');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{if(app)await app.close();fs.rmSync(dir,{recursive:true,force:true});});
