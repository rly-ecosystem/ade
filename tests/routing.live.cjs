'use strict';
const {_electron:electron}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {execFileSync}=require('node:child_process');
const {trustProject}=require('./ui-helpers.cjs');
const root=path.resolve(__dirname,'..'),directory=fs.mkdtempSync(path.join(os.tmpdir(),'ade-live-route-')),repo=path.join(directory,'project'),bin=path.join(directory,'bin');
fs.mkdirSync(bin);execFileSync('git',['init','-b','main',repo],{stdio:'ignore'});
let app;
function inject(provider){for(const name of ['codex','claude'])fs.rmSync(path.join(bin,name),{force:true});fs.copyFileSync(path.join(__dirname,'fixtures','cli.cjs'),path.join(bin,provider));fs.chmodSync(path.join(bin,provider),0o755);}
async function finish(page,expected){
 const deadline=Date.now()+180000;
 while(Date.now()<deadline){
  const requests=page.getByRole('region',{name:'Запрос разрешения',exact:true});
  for(let i=await requests.count()-1;i>=0;i--){
   const request=requests.nth(i),text=await request.locator('pre').innerText();
   const permitted=/(ade-demo|codex-partial|claude-partial)\.txt/.test(text)&&!/curl |wget |rm -|https?:\/\//.test(text);
   await request.getByRole('button',{name:permitted?'Разрешить один раз':'Отклонить',exact:true}).click();
  }
  const phase=await page.locator('.local-task-phase').innerText();
  if(phase==='Шаг завершён'){assert.equal(fs.readFileSync(path.join(repo,'ade-demo.txt'),'utf8').trim(),expected);return;}
  if(['Ошибка выполнения','Остановлена','Ожидает продолжения'].includes(phase))throw new Error(await page.getByRole('main').innerText());
  await page.waitForTimeout(250);
 }
 throw new Error('Live fallback exceeded 180s');
}
(async()=>{
 inject('codex');
 const executablePath=process.env.ADE_TEST_EXECUTABLE;
 app=await electron.launch({...(executablePath?{executablePath,args:[]}:{args:[path.join(root,'apps','desktop')]}),env:{...process.env,PATH:bin+path.delimiter+process.env.PATH,ADE_USER_DATA:path.join(directory,'app-data')}});
 const page=await app.firstWindow(),errors=[],results=[];page.setDefaultTimeout(30000);page.on('pageerror',error=>errors.push(error.message));
 await page.getByRole('heading',{name:'Что будем делать?'}).waitFor();
 await app.evaluate(({dialog},repo)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[repo]});},repo);
 await page.getByRole('button',{name:'Подключить проект',exact:true}).click();
 for(const primary of ['codex','claude']){
  if(primary==='claude'){inject('claude');await page.getByRole('button',{name:'RLY ADE, главная',exact:true}).click();}
  const backup=primary==='codex'?'claude':'codex',expected=backup.toUpperCase()+'_CONTINUED';
  await page.getByRole('textbox',{name:'Задача',exact:true}).fill(`[LIMIT_${primary.toUpperCase()}] This is a plain text file integration check. Antislop mode: after. The previous executor creates ${primary}-partial.txt with ${primary.toUpperCase()}_FIXTURE_RESULT before an injected quota event. As the backup executor, read that file and verify its exact content, then write ade-demo.txt with exactly ${expected} followed by a newline. Use file tools. No network, commit, publish, deploy, or other file changes. Report the verified previous progress briefly.`);
  await page.getByRole('button',{name:'Сохранить задачу',exact:true}).click();
  const trust=page.getByRole('checkbox',{name:/Доверяю проекту/});if(await trust.count())await trustProject(page);
  await page.getByRole('combobox',{name:'Исполнитель',exact:true}).selectOption(primary);
  await page.getByText(new RegExp('^Резерв при лимите')).click();
  await page.getByRole('textbox',{name:'Резервная модель',exact:true}).fill(backup==='claude'?'sonnet':'');
  await page.getByRole('button',{name:primary==='codex'?'Запустить Codex':'Запустить Claude',exact:true}).click();
  await finish(page,expected);
  const state=await page.evaluate(async marker=>{const data=(await window.ade.call('bootstrap',{})).value;const task=data.tasks.find(task=>task.title.startsWith(marker));return(await window.ade.call('task.get',{taskId:task.id})).value;},`[LIMIT_${primary.toUpperCase()}]`);
  assert.deepEqual(state.runs.map(run=>run.status),['limited','completed']);assert.equal(state.runs[1].provider,backup);assert.equal(state.transfers.length,1);
  results.push({injectedQuota:primary,realExecutor:backup,runs:state.runs.map(run=>({provider:run.provider,status:run.status,checkpointId:run.checkpointId})),output:fs.readFileSync(path.join(repo,'ade-demo.txt'),'utf8')});
  await page.screenshot({path:path.join(root,'logs',`live-fallback-${backup}.png`)});
  console.log(`PASS live automatic fallback: injected ${primary} quota → real ${backup} verified and continued saved file`);
 }
 assert.deepEqual(errors,[]);fs.writeFileSync(path.join(root,'logs','live-routing-verification.json'),JSON.stringify({passed:true,packaged:!!executablePath,quota:'injected; actual subscription limits not exhausted',results,errors},null,2));
})().catch(async error=>{if(app){try{await(await app.firstWindow()).screenshot({path:path.join(root,'logs','live-routing-failure.png')});}catch{}}console.error(error);process.exitCode=1;}).finally(async()=>{if(app)await app.close();fs.rmSync(directory,{recursive:true,force:true});});
