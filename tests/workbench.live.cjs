'use strict';
const {_electron:electron}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const {showInspector,openDetails,trustProject}=require('./ui-helpers.cjs');
const root=path.resolve(__dirname,'..'),directory=fs.mkdtempSync(path.join(os.tmpdir(),'ade-live-workbench-')),repo=path.join(directory,'project');
execFileSync('git',['init','-b','main',repo],{stdio:'ignore'});let app;
(async()=>{
 const executablePath=process.env.ADE_TEST_EXECUTABLE;
 app=await electron.launch({...(executablePath?{executablePath,args:[]}:{args:[path.join(root,'apps','desktop')]}),env:{...process.env,ADE_USER_DATA:path.join(directory,'user-data')}});
 const page=await app.firstWindow(),errors=[];page.setDefaultTimeout(30000);page.on('pageerror',error=>errors.push(error.message));
 await page.getByRole('heading',{name:'Что будем делать?'}).waitFor();
 await app.evaluate(({dialog},repo)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[repo]});},repo);
 await page.getByRole('button',{name:'Подключить проект',exact:true}).click();
 await page.getByRole('textbox',{name:'Задача',exact:true}).fill('Small plain-text integration check, no UI. Use the four ADE roles and the required short handoff protocol. Planning and research run concurrently: plan one sentence; research only this selected folder and report one finding. Development: create only ade-demo.txt containing exactly ADE_ROLES_READY followed by a newline, using native editing tools. Review: read that file and verify the exact content. Read-only roles must never modify files or run tests. No network, commits, publishing, deployment, subagents or other file changes. Keep every handoff short.');
 await page.getByRole('button',{name:'Сохранить задачу',exact:true}).click();
 await trustProject(page);
 await showInspector(page);
 await page.getByText('Назначения ролей · не сохранены',{exact:true}).click();
 await page.getByRole('textbox',{name:'Модель: Исследование',exact:true}).fill('sonnet');
 await page.getByRole('textbox',{name:'Модель: Ревью',exact:true}).fill('sonnet');
 await page.getByRole('button',{name:'Сохранить назначения',exact:true}).click();
 await page.getByText('Назначения ролей',{exact:true}).click();
 await page.getByRole('button',{name:'Запустить цепочку',exact:true}).click();
 const end=Date.now()+300000;
 while(Date.now()<end){
  const requests=page.getByRole('region',{name:'Запрос разрешения',exact:true});
  for(let i=await requests.count()-1;i>=0;i--){
   const request=requests.nth(i),title=await request.getByRole('heading').innerText(),text=await request.locator('pre').innerText();
   let readInside=false;
   try {const input=JSON.parse(text),target=input.file_path||input.path;const relative=target?path.relative(fs.realpathSync(repo),path.resolve(repo,target)):'';readInside=['Read','Glob','Grep'].includes(title)&&relative!=='..'&&!relative.startsWith('../')&&!path.isAbsolute(relative);}catch{}
   const allowed=readInside||/ade-demo\.txt/.test(text)&&!/curl |wget |rm -|https?:\/\//.test(text);
   await request.getByRole('button',{name:allowed?'Разрешить один раз':'Отклонить',exact:true}).click();
  }
  const data=await page.evaluate(async()=>{const state=(await window.ade.call('bootstrap',{})).value;return(await window.ade.call('task.get',{taskId:state.tasks[0].id})).value;});
  if(data.workflow.status==='ready')break;
  if(['waiting','interrupted','stopped'].includes(data.workflow.status))throw new Error('Workflow stopped: '+JSON.stringify({workflow:data.workflow,group:data.group,runs:data.runs.map(run=>({role:run.role,status:run.status,error:run.error}))}));
  await page.waitForTimeout(300);
 }
 let state=await page.evaluate(async()=>{const data=(await window.ade.call('bootstrap',{})).value;return(await window.ade.call('task.get',{taskId:data.tasks[0].id})).value;});
 fs.writeFileSync(path.join(root,'logs','live-workbench-state.json'),JSON.stringify(state,null,2));
 assert.equal(state.workflow.status,'ready');assert.deepEqual(state.runs.slice(0,2).map(run=>run.role).sort(),['orchestrator','researcher']);assert.deepEqual(state.runs.slice(2).map(run=>run.role),['developer','reviewer']);assert.ok(state.runs.every(run=>run.status==='completed'));
 const [a,b]=state.runs;assert.ok(Date.parse(a.startedAt)<Date.parse(b.endedAt)&&Date.parse(b.startedAt)<Date.parse(a.endedAt));assert.equal(state.handoffs.length,5);assert.ok(state.handoffs.every(item=>item.recipients.length===1));
 assert.equal(fs.readFileSync(path.join(repo,'ade-demo.txt'),'utf8'),'ADE_ROLES_READY\n');
 await page.screenshot({path:path.join(root,'logs','live-workbench-roles.png')});
 await openDetails(page,'.local-verification');
 await page.getByRole('textbox',{name:'Команда проверки',exact:true}).fill('test "$(cat ade-demo.txt)" = ADE_ROLES_READY && printf VERIFIED_ROLES');
 await page.getByRole('button',{name:'Запустить проверку',exact:true}).click();
 await page.getByText('Пройдена',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Принять результат',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('.local-task-phase')?.textContent==='Результат принят');
 state=await page.evaluate(async()=>{const data=(await window.ade.call('bootstrap',{})).value;return(await window.ade.call('task.get',{taskId:data.tasks[0].id})).value;});
 assert.equal(state.acceptance.mode,'checked');assert.equal(state.checks.at(-1).output,'VERIFIED_ROLES');assert.deepEqual(errors,[]);
 await page.screenshot({path:path.join(root,'logs','live-workbench-accepted.png')});
 fs.writeFileSync(path.join(root,'logs','live-workbench-verification.json'),JSON.stringify({passed:true,packaged:!!executablePath,runs:state.runs.map(run=>({role:run.role,provider:run.provider,model:run.model,status:run.status,artifactDigest:run.artifactDigest})),checks:state.checks,acceptance:state.acceptance,output:fs.readFileSync(path.join(repo,'ade-demo.txt'),'utf8'),errors},null,2));
 console.log('PASS live workbench: four real Codex/Claude roles → exact file → actual command → accepted matching artifact');
})().catch(async error=>{if(app){try{const page=await app.firstWindow();fs.writeFileSync(path.join(root,'logs','live-workbench-error-state.json'),JSON.stringify(await page.evaluate(async()=>{const data=(await window.ade.call('bootstrap',{})).value;return(await window.ade.call('task.get',{taskId:data.tasks[0].id})).value;}),null,2));await page.screenshot({path:path.join(root,'logs','live-workbench-failure.png')});}catch{}}console.error(error);process.exitCode=1}).finally(async()=>{if(app)await app.close();fs.rmSync(directory,{recursive:true,force:true});});
