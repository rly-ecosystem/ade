import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, chmodSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Runtime } from '../packages/runtime/src/service.js';
import { ACTIVE_RUNS, type Provider, type TaskDetail, type Checkpoint } from '../packages/contracts/src/index.js';
import { checkpoint, workspaceDigest, conversation } from '../packages/runtime/src/checkpoint.js';
import { cliEnvironment } from '../packages/runtime/src/processes.js';

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const directory = mkdtempSync(path.join(tmpdir(), 'ade-execution-')), repo = path.join(directory, 'repo'), bin = path.join(directory, 'bin');
  mkdirSync(bin);
  for (const provider of ['codex', 'claude']) { copyFileSync(path.resolve('tests/fixtures/cli.cjs'), path.join(bin, provider)); chmodSync(path.join(bin, provider), 0o755); }
  const original = process.env.PATH; process.env.PATH = bin + path.delimiter + original;
  execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'ignore' });
  const runtime = new Runtime(path.join(directory, 'data', 'ade.sqlite'));
  await runtime.initialize();
  const project = await runtime.addProject(repo);
  t.after(async () => { await runtime.shutdown(); process.env.PATH = original; rmSync(directory, { recursive: true, force: true }); });
  return { directory, repo, runtime, project };
}

async function wait(runtime: Runtime, taskId: string, predicate: (detail: TaskDetail) => boolean): Promise<TaskDetail> {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) { const detail = runtime.store.detail(taskId); if (predicate(detail)) return detail; await new Promise(resolve => setTimeout(resolve, 40)); }
  throw new Error('Execution timeout: ' + JSON.stringify(runtime.store.detail(taskId).runs));
}
async function execute(runtime: Runtime, taskId: string, provider: Provider, requestId = randomUUID()) {
  return runtime.call({ method: 'task.execute', params: { taskId, provider, model: '', requestId } }) as Promise<TaskDetail>;
}
async function allow(runtime: Runtime, taskId: string, decision: 'allow' | 'deny' = 'allow') {
  const waiting = await wait(runtime, taskId, detail => !!detail.approvals.length);
  const approval = waiting.approvals[0]!;
  return runtime.call({ method: 'run.respond', params: { runId: approval.runId, approvalId: approval.id, decision, requestId: randomUUID() } });
}

test('provider runs require project trust and deny concurrent writers', async t => {
  const { runtime, project } = await fixture(t);
  const task = runtime.store.createTask(project.id, 'First task', randomUUID()).task;
  await assert.rejects(execute(runtime, task.id, 'codex'), /доверие/);
  runtime.store.trust(project.id, true);
  const id = randomUUID(); await execute(runtime, task.id, 'codex', id);
  await wait(runtime, task.id, value => !!value.approvals.length);
  const replay = await execute(runtime, task.id, 'codex', id);
  assert.equal(replay.runs.length, 1);
  const second = runtime.store.createTask(project.id, 'Second task', randomUUID()).task;
  await assert.rejects(execute(runtime, second.id, 'claude'), /активный исполнитель/);
  await assert.rejects(execute(runtime, task.id, 'claude', id), /другими данными/);
  await assert.rejects(runtime.call({ method: 'project.trust', params: { projectId: project.id, trusted: false } }), /Сначала остановите/);
});

test('Codex and Claude execute with one-time permissions and portable persisted context', async t => {
  const { runtime, project, repo } = await fixture(t); runtime.store.trust(project.id, true);
  const task = runtime.store.createTask(project.id, 'Make a change', randomUUID()).task;
  await execute(runtime, task.id, 'codex'); await allow(runtime, task.id);
  await wait(runtime, task.id, value => value.task.status === 'completed');
  assert.match(readFileSync(path.join(repo, 'codex-result.txt'), 'utf8'), /CODEX_FIXTURE_RESULT/);
  runtime.store.message(task.id, 'Continue with another provider', randomUUID());
  await execute(runtime, task.id, 'claude'); await allow(runtime, task.id);
  const done = await wait(runtime, task.id, value => value.runs.length === 2 && value.task.status === 'completed');
  assert.match(readFileSync(path.join(repo, 'claude-result.txt'), 'utf8'), /CLAUDE_CONTINUED_CODEX_CONTEXT/);
  assert.equal(done.runs[1]!.generation, 2); assert.notEqual(done.runs[0]!.checkpointId, done.runs[1]!.checkpointId);
  const messages = conversation(done.events);
  assert.equal(messages.filter(message => message.text === 'CODEX_FIXTURE_RESULT').length, 1);
  assert.ok(done.runs.every(run => run.endedAt && run.pid && run.processStamp));
});

test('denied tools never write and approvals cannot be reused across runs', async t => {
  const { runtime, project, repo } = await fixture(t); runtime.store.trust(project.id, true);
  const task = runtime.store.createTask(project.id, 'Make a change', randomUUID()).task;
  await execute(runtime, task.id, 'claude');
  const waiting = await wait(runtime, task.id, value => !!value.approvals.length), approval = waiting.approvals[0]!;
  await allow(runtime, task.id, 'deny');
  await wait(runtime, task.id, value => value.task.status === 'completed');
  assert.equal(existsSync(path.join(repo, 'claude-result.txt')), false);
  await assert.rejects(runtime.call({ method: 'run.respond', params: { runId: approval.runId, approvalId: approval.id, decision: 'allow', requestId: randomUUID() } }), /неактуален/);
});

test('stop kills provider and tool process group, retains partial output, and rejects late events', async t => {
  const { runtime, project, repo } = await fixture(t); runtime.store.trust(project.id, true);
  const task = runtime.store.createTask(project.id, '[FIXTURE_WAIT]', randomUUID()).task;
  await execute(runtime, task.id, 'codex');
  const running = await wait(runtime, task.id, value => value.events.some(event => event.payload.text === 'SAVED_PARTIAL_OUTPUT'));
  const run = running.runs.at(-1)!;
  const helper = Number(readFileSync(path.join(repo, 'fixture-helper.pid'), 'utf8'));
  await runtime.call({ method: 'run.stop', params: { runId: run.id, requestId: randomUUID() } });
  const done = runtime.store.detail(task.id); assert.equal(done.task.status, 'stopped');
  const output = execFileSync('/bin/ps', ['-axo', 'pid=,stat='], { encoding: 'utf8' });
  assert.equal(output.split('\n').some(line => { const [pid, state] = line.trim().split(/\s+/); return Number(pid) === helper && !state?.startsWith('Z'); }), false);
  const sequence = done.events.length;
  runtime.store.appendRun(run.id, 'run.output', { text: 'LATE_EVENT' });
  assert.equal(runtime.store.detail(task.id).events.length, sequence);
});

test('unknown output or missing terminal frame fails closed; disabled route never rotates', async t => {
  const { runtime, project, repo } = await fixture(t); runtime.store.trust(project.id, true);
  for (const marker of ['[FIXTURE_UNKNOWN]', '[FIXTURE_EXIT]', '[FIXTURE_LIMIT]']) {
    const task = runtime.store.createTask(project.id, marker, randomUUID()).task;
    runtime.store.configureRoute(task.id, false, '', '');
    await execute(runtime, task.id, 'codex');
    const done = await wait(runtime, task.id, value => value.runs.length > 0 && !ACTIVE_RUNS.includes(value.runs[0]!.status));
    assert.equal(done.task.status, marker === '[FIXTURE_LIMIT]' ? 'limited' : 'failed');
    assert.equal(done.runs.length, 1);
  }
  assert.equal(existsSync(path.join(repo, 'claude-result.txt')), false);
});

test('migration preserves v1 tasks, events and request keys and resets project trust', t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'ade-migrate-')), filename = path.join(directory, 'ade.sqlite');
  const db = new DatabaseSync(filename);
  db.exec(`CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT,path TEXT,createdAt TEXT); CREATE TABLE tasks(id TEXT PRIMARY KEY,projectId TEXT REFERENCES projects(id),title TEXT,status TEXT,createdAt TEXT,updatedAt TEXT); CREATE TABLE events(id TEXT PRIMARY KEY,taskId TEXT REFERENCES tasks(id),sequence INTEGER,type TEXT,payload TEXT,createdAt TEXT); CREATE TABLE requests(id TEXT PRIMARY KEY,digest TEXT,result TEXT); CREATE INDEX tasks_project ON tasks(projectId); INSERT INTO projects VALUES('p','Project','/tmp/project','now'); INSERT INTO tasks VALUES('t','p','Saved task','draft','now','now'); INSERT INTO events VALUES('e','t',1,'message.created','{"role":"user","text":"Preserved"}','now'); PRAGMA user_version=1;`);
  db.prepare('INSERT INTO requests VALUES (?, ?, ?)').run('old-request', createHash('sha256').update(JSON.stringify(['task.create', 'p', 'Saved task'])).digest('hex'), JSON.stringify({ task: { id: 't' }, events: [] }));
  db.close();
  const runtime = new Runtime(filename);
  assert.equal(runtime.store.detail('t').events[0]!.payload.text, 'Preserved');
  assert.equal(runtime.store.project('p').trusted, false); assert.equal(runtime.store.bootstrap().schemaVersion, 6);
  assert.deepEqual(runtime.store.createTask('p', 'Saved task', 'old-request').runs, []);
  assert.equal(runtime.store.bootstrap().tasks.length, 1);
  runtime.close(); rmSync(directory, { recursive: true, force: true });
});

test('recovery marks unfinished runs interrupted without replaying actions', async t => {
  const { runtime, project } = await fixture(t); runtime.store.trust(project.id, true);
  const task = runtime.store.createTask(project.id, 'Recover safely', randomUUID());
  const packet: Checkpoint = { id: randomUUID(), taskId: task.task.id, eventSequence: 2, head: null, gitDigest: 'fixture', manifest: [], prompt: 'saved', digest: 'fixture', createdAt: new Date().toISOString() };
  runtime.store.beginRun(task.task.id, 'codex', '', randomUUID(), packet);
  await runtime.runner.recover();
  const recovered = runtime.store.detail(task.task.id);
  assert.equal(recovered.task.status, 'interrupted'); assert.equal(recovered.runs.length, 1);
  assert.equal(recovered.approvals.length, 0);
});

test('provider subprocess environment excludes API keys and parent session secrets', () => {
  const env = cliEnvironment('/usr/local/bin/codex');
  for (const name of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CODEX_THREAD_ID', 'CODEX_ENV_THREAD_ID', 'CLAUDECODE']) assert.equal(env[name], undefined);
  assert.ok(env.HOME); assert.match(env.PATH!, /^\/usr\/local\/bin/);
  assert.ok(cliEnvironment('/bin/bash').PATH!.split(path.delimiter).includes(path.dirname(process.execPath)));
});

for (const provider of ['codex', 'claude'] as Provider[]) test(`confirmed quota switches ${provider} once and preserves conversation and files`, async t => {
  const { runtime, project, repo } = await fixture(t); runtime.store.trust(project.id, true);
  const task = runtime.store.createTask(project.id, provider === 'codex' ? '[LIMIT_CODEX]' : '[LIMIT_CLAUDE]', randomUUID()).task;
  await execute(runtime, task.id, provider);
  await allow(runtime, task.id);
  const done = await wait(runtime, task.id, detail => detail.task.status === 'completed');
  assert.deepEqual(done.runs.map(run => run.provider), [provider, provider === 'codex' ? 'claude' : 'codex']);
  assert.deepEqual(done.runs.map(run => run.status), ['limited', 'completed']);
  assert.ok(done.runs[0]!.limit); assert.equal(done.runs[0]!.groupId, done.runs[1]!.groupId);
  assert.equal(done.transfers.length, 1); assert.equal(done.transfers[0]!.status, 'started');
  assert.equal(done.group?.status, 'completed');
  assert.ok(existsSync(path.join(repo, provider + '-partial.txt')));
  assert.ok(conversation(done.events).some(message => message.provider === provider && message.text.includes('FIXTURE_RESULT')));
  if (provider === 'codex') assert.match(readFileSync(path.join(repo, 'claude-result.txt'), 'utf8'), /CLAUDE_CONTINUED_CODEX_CONTEXT/);
});

test('both limits stop after two attempts without a retry loop', async t => {
  const { runtime, project } = await fixture(t); runtime.store.trust(project.id, true);
  const task = runtime.store.createTask(project.id, '[FIXTURE_LIMIT]', randomUUID()).task;
  await execute(runtime, task.id, 'codex');
  const done = await wait(runtime, task.id, detail => detail.group?.status === 'waiting');
  assert.equal(done.runs.length, 2); assert.ok(done.runs.every(run => run.status === 'limited'));
  assert.match(done.group!.reason, /Оба исполнителя/); assert.equal(runtime.store.groups().length, 0);
});

test('generic 429 and authentication errors never switch providers', async t => {
  const { runtime, project } = await fixture(t); runtime.store.trust(project.id, true);
  for (const provider of ['codex', 'claude'] as Provider[]) for (const marker of ['[GENERIC_429]', '[AUTH_FAILURE]']) {
    const task = runtime.store.createTask(project.id, marker, randomUUID()).task;
    await execute(runtime, task.id, provider);
    const done = await wait(runtime, task.id, detail => detail.group?.status === 'waiting');
    assert.equal(done.runs.length, 1); assert.equal(done.runs[0]!.limit, null); assert.equal(done.transfers.length, 0);
  }
});

test('unconfirmed command effects prevent automatic replay after quota', async t => {
  const { runtime, project } = await fixture(t); runtime.store.trust(project.id, true);
  for (const provider of ['codex', 'claude'] as Provider[]) {
    const task = runtime.store.createTask(project.id, '[FIXTURE_LIMIT] [UNFINISHED_COMMAND]', randomUUID()).task;
    await execute(runtime, task.id, provider);
    const done = await wait(runtime, task.id, detail => detail.group?.status === 'waiting');
    assert.equal(done.runs.length, 1); assert.match(done.group!.reason, /Команда не подтвердила/);
  }
});

test('missing backup login leaves saved task waiting and releases ownership', async t => {
  const { runtime, project, directory } = await fixture(t); runtime.store.trust(project.id, true);
  writeFileSync(path.join(directory, 'bin', 'disable-claude'), '');
  const task = runtime.store.createTask(project.id, '[LIMIT_CODEX]', randomUUID()).task;
  await execute(runtime, task.id, 'codex');
  const done = await wait(runtime, task.id, detail => detail.group?.status === 'waiting');
  assert.equal(done.runs.length, 1); assert.equal(done.transfers[0]!.status, 'blocked');
  assert.match(done.group!.reason, /Продолжение ожидает/); assert.equal(runtime.store.groups().length, 0);
});

test('Stop cancels a pending transfer while the backup is being probed', async t => {
  const { runtime, project, directory } = await fixture(t); runtime.store.trust(project.id, true);
  writeFileSync(path.join(directory, 'bin', 'slow-claude'), '');
  const task = runtime.store.createTask(project.id, '[LIMIT_CODEX]', randomUUID()).task;
  await execute(runtime, task.id, 'codex');
  const switching = await wait(runtime, task.id, detail => detail.group?.status === 'switching');
  await runtime.runner.stop(switching.runs[0]!.id);
  await new Promise(resolve => setTimeout(resolve, 1500));
  const done = runtime.store.detail(task.id);
  assert.equal(done.runs.length, 1); assert.equal(done.task.status, 'stopped');
  assert.equal(done.transfers[0]!.status, 'cancelled'); assert.equal(runtime.store.groups().length, 0);
});

test('persisted quota transfer resumes after opening another runtime', async t => {
  const { runtime, project, directory } = await fixture(t); runtime.store.trust(project.id, true);
  const detail = runtime.store.createTask(project.id, 'Resume saved quota handoff', randomUUID());
  const packet: Checkpoint = { id: randomUUID(), taskId: detail.task.id, eventSequence: 2, head: null, gitDigest: 'fixture', manifest: [], prompt: 'saved', digest: 'fixture', createdAt: new Date().toISOString() };
  const run = runtime.store.beginRun(detail.task.id, 'codex', '', randomUUID(), packet);
  runtime.store.appendRun(run.id, 'run.output', { itemId: 'answer', text: 'CODEX_FIXTURE_RESULT', replace: 'false' });
  runtime.store.finishRun(run.id, 'limited', 'quota', { source: 'codex.usageLimitExceeded' });
  const restored = new Runtime(path.join(directory, 'data', 'ade.sqlite'));
  try {
    await restored.initialize(); await allow(restored, detail.task.id);
    const done = await wait(restored, detail.task.id, value => value.task.status === 'completed');
    assert.equal(done.runs.length, 2); assert.equal(done.transfers.length, 1);
  } finally { await restored.shutdown(); }
});

test('Claude quota warning continues normally; typed rate_limit switches once', async t => {
 const {runtime,project}=await fixture(t);runtime.store.trust(project.id,true);
 const warning=runtime.store.createTask(project.id,'[QUOTA_WARNING]',randomUUID()).task;
 await execute(runtime,warning.id,'claude');await allow(runtime,warning.id);
 const completed=await wait(runtime,warning.id,value=>value.task.status==='completed');
 assert.equal(completed.runs.length,1);assert.equal(completed.transfers.length,0);
 const limited=runtime.store.createTask(project.id,'[ASSISTANT_LIMIT]',randomUUID()).task;
 await execute(runtime,limited.id,'claude');await allow(runtime,limited.id);
 const transferred=await wait(runtime,limited.id,value=>value.task.status==='completed');
 assert.equal(transferred.runs.length,2);assert.equal(transferred.runs[0]!.limit?.source,'claude.rate_limit');
});

test('incomplete oversized context blocks backup and retains partial file and answer', async t=>{
 const {runtime,project,repo}=await fixture(t);runtime.store.trust(project.id,true);
 const task=runtime.store.createTask(project.id,'[LIMIT_CODEX] [HUGE_AFTER_LIMIT]',randomUUID()).task;
 await execute(runtime,task.id,'codex');
 const done=await wait(runtime,task.id,value=>value.group?.status==='waiting');
 assert.equal(done.runs.length,1);assert.match(done.group!.reason,/10 МиБ/);assert.equal(done.transfers[0]!.status,'blocked');
 assert.equal(existsSync(path.join(repo,'large-artifact.dat')),true);
 assert.ok(conversation(done.events).some(message=>message.text==='CODEX_FIXTURE_RESULT'));
});

test('expired durable transfer cannot start a backup after recovery', async t=>{
 const {runtime,project,directory}=await fixture(t);runtime.store.trust(project.id,true);
 const detail=runtime.store.createTask(project.id,'Deadline check',randomUUID());
 const packet:Checkpoint={id:randomUUID(),taskId:detail.task.id,eventSequence:2,head:null,gitDigest:'fixture',manifest:[],prompt:'saved',digest:'fixture',createdAt:new Date().toISOString()};
 const run=runtime.store.beginRun(detail.task.id,'codex','',randomUUID(),packet);
 runtime.store.finishRun(run.id,'limited','quota',{source:'codex.usageLimitExceeded'});
 const db=new DatabaseSync(path.join(directory,'data','ade.sqlite'));db.prepare('UPDATE execution_groups SET deadlineAt=? WHERE id=?').run(new Date(0).toISOString(),run.groupId);db.close();
 await runtime.runner.recover();
 const done=await wait(runtime,detail.task.id,value=>value.group?.status==='waiting');
 assert.equal(done.runs.length,1);assert.match(done.group!.reason,/предел времени/);assert.equal(runtime.store.groups().length,0);
});

const roles = [
 {role:'orchestrator' as const,provider:'codex' as const,model:''},
 {role:'researcher' as const,provider:'claude' as const,model:''},
 {role:'developer' as const,provider:'codex' as const,model:''},
 {role:'reviewer' as const,provider:'claude' as const,model:''},
];
async function pipeline(runtime:Runtime,projectId:string,text='Implement and review') {
 const task=runtime.store.createTask(projectId,text,randomUUID()).task;
 await runtime.call({method:'task.roles',params:{taskId:task.id,steps:roles}});
 const requestId=randomUUID();
 await runtime.call({method:'workflow.start',params:{taskId:task.id,requestId}});
 return {task,requestId};
}

test('four durable roles preserve context and read-only policy before human acceptance',async t=>{
 const {runtime,project,repo}=await fixture(t);runtime.store.trust(project.id,true);
 const {task,requestId}=await pipeline(runtime,project.id);
 await allow(runtime,task.id);
 const done=await wait(runtime,task.id,value=>value.workflow?.status==='ready');
 assert.deepEqual(done.runs.map(run=>run.role),roles.map(step=>step.role));
 assert.equal(done.task.status,'review');assert.ok(done.runs.every(run=>run.status==='completed'&&run.artifactDigest));
 assert.equal(done.acceptance,null);assert.equal(existsSync(path.join(repo,'claude-result.txt')),false);
 const history=conversation(done.events).map(message=>message.text).join('\n');
 assert.match(history,/ROLE_ORCHESTRATOR read-only\/never/);assert.match(history,/ROLE_REVIEWER Read,Glob,Grep CONTEXT_OK/);
 await runtime.call({method:'workflow.start',params:{taskId:task.id,requestId}});
 assert.equal(runtime.store.detail(task.id).runs.length,4);
 await assert.rejects(runtime.call({method:'task.accept',params:{taskId:task.id,note:''}}),/команду проверки|причину/);
});

test('quota backup stays in its role then advances to reviewer',async t=>{
 const {runtime,project}=await fixture(t);runtime.store.trust(project.id,true);
 const {task}=await pipeline(runtime,project.id,'[LIMIT_CODEX]');await allow(runtime,task.id);
 const done=await wait(runtime,task.id,value=>value.workflow?.status==='ready');
 assert.deepEqual(done.runs.map(run=>run.role),['orchestrator','researcher','developer','developer','reviewer']);
 assert.deepEqual(done.runs.slice(2,4).map(run=>run.status),['limited','completed']);
 assert.equal(done.transfers.length,1);assert.equal(done.task.status,'review');
});

for(const provider of ['codex','claude'] as Provider[])test(`read-only roles deny ${provider} write requests`,async t=>{
 const {runtime,project,repo}=await fixture(t);runtime.store.trust(project.id,true);
 const task=runtime.store.createTask(project.id,'[TRY_WRITE_READONLY]',randomUUID()).task;
 await runtime.call({method:'task.roles',params:{taskId:task.id,steps:roles.map(step=>({...step,provider}))}});
 await runtime.call({method:'workflow.start',params:{taskId:task.id,requestId:randomUUID()}});
 const request=await wait(runtime,task.id,value=>!!value.approvals.length);
 assert.equal(request.runs.at(-1)?.role,'developer');await allow(runtime,task.id);
 const done=await wait(runtime,task.id,value=>value.workflow?.status==='ready');
 assert.equal(done.events.filter(event=>event.type==='approval.requested').length,1);
 assert.equal(done.events.filter(event=>event.type==='run.tool'&&event.payload.text==='Роль работает только на чтение').length,3);
 assert.equal(readFileSync(path.join(repo,provider+'-result.txt'),'utf8').trim(),provider==='codex'?'CODEX_FIXTURE_RESULT':'CLAUDE_FIXTURE_RESULT');
});

test('pending role transitions recover once and Stop cancels before first process',async t=>{
 const {runtime,project,directory}=await fixture(t);runtime.store.trust(project.id,true);
 const task=runtime.store.createTask(project.id,'Recovered chain',randomUUID()).task;
 runtime.store.configureRoles(task.id,roles);
 runtime.store.startWorkflow(task.id,randomUUID());
 await runtime.runner.recover();await runtime.runner.recover();await allow(runtime,task.id);
 const done=await wait(runtime,task.id,value=>value.workflow?.status==='ready');assert.equal(done.runs.length,4);
 writeFileSync(path.join(directory,'bin','slow-claude'),'');
 const second=runtime.store.createTask(project.id,'Cancel chain',randomUUID()).task;
 runtime.store.configureRoles(second.id,roles.map(step=>({...step,provider:'claude'})));
 const started=runtime.runner.startWorkflow(second.id,randomUUID());
 await runtime.runner.stopWorkflow(started.workflow!.groupId);
 await new Promise(resolve=>setTimeout(resolve,1500));
 assert.equal(runtime.store.detail(second.id).workflow?.status,'stopped');assert.equal(runtime.store.detail(second.id).runs.length,0);
});

async function completedTask(runtime:Runtime,projectId:string) {
 const task=runtime.store.createTask(projectId,'A verifiable result',randomUUID()).task;
 await execute(runtime,task.id,'codex');await allow(runtime,task.id);await wait(runtime,task.id,value=>value.task.status==='completed');return task;
}
async function check(runtime:Runtime,taskId:string,command:string,requestId=randomUUID()) {
 await runtime.call({method:'check.start',params:{taskId,command,requestId}});
 return wait(runtime,taskId,value=>value.checks.length>0&&!['running','stopping'].includes(value.checks.at(-1)!.status));
}

test('real shell checks capture exit/output, are idempotent, and bind acceptance to exact files',async t=>{
 const {runtime,project,repo}=await fixture(t);runtime.store.trust(project.id,true);
 const task=await completedTask(runtime,project.id),requestId=randomUUID();
 const done=await check(runtime,task.id,'printf CHECK_OK',requestId);
 assert.equal(done.checks[0]!.status,'passed');assert.equal(done.checks[0]!.output,'CHECK_OK');assert.equal(done.checks[0]!.exitCode,0);
 await check(runtime,task.id,'printf CHECK_OK',requestId);assert.equal(runtime.store.detail(task.id).checks.length,1);
 await runtime.call({method:'task.accept',params:{taskId:task.id,note:''}});
 assert.equal(runtime.store.detail(task.id).task.status,'accepted');assert.equal(runtime.store.detail(task.id).acceptance?.mode,'checked');
 writeFileSync(path.join(repo,'codex-result.txt'),'changed');
 const stale=await runtime.call({method:'task.verify',params:{taskId:task.id}}) as TaskDetail;
 assert.equal(stale.acceptance?.stale,true);assert.equal(stale.checks[0]!.stale,true);assert.equal(stale.task.status,'review');
 await assert.rejects(runtime.call({method:'task.accept',params:{taskId:task.id,note:'override'}}),/текущего состояния/);
});

test('failed checks cannot hide behind an earlier success; manual acceptance is explicit',async t=>{
 const {runtime,project}=await fixture(t);runtime.store.trust(project.id,true);
 const task=await completedTask(runtime,project.id);
 await check(runtime,task.id,'printf FIRST_OK');
 const failed=await check(runtime,task.id,'false | true');
 assert.equal(failed.checks.at(-1)!.status,'failed');assert.equal(failed.checks.at(-1)!.exitCode,1);
 await assert.rejects(runtime.call({method:'task.accept',params:{taskId:task.id,note:''}}),/команду проверки|причину/);
 const accepted=await runtime.call({method:'task.accept',params:{taskId:task.id,note:'Reviewed this text-only change manually'}}) as TaskDetail;
 assert.equal(accepted.acceptance?.mode,'manual');
 runtime.store.message(task.id,'New requirement',randomUUID());
 assert.equal(runtime.store.detail(task.id).acceptance?.stale,true);
 await assert.rejects(runtime.call({method:'task.accept',params:{taskId:task.id,note:'manual'}}),/Новые требования/);
});

test('checks reserve project ownership, stop their process group and keep partial output',async t=>{
 const {runtime,project}=await fixture(t);runtime.store.trust(project.id,true);
 const task=runtime.store.createTask(project.id,'Long check',randomUUID()).task;
 await runtime.call({method:'check.start',params:{taskId:task.id,command:"printf STARTED; sleep 60",requestId:randomUUID()}});
 const running=await wait(runtime,task.id,value=>value.checks[0]?.output==='STARTED');
 const other=runtime.store.createTask(project.id,'Other writer',randomUUID()).task;
 await assert.rejects(execute(runtime,other.id,'codex'),/активный исполнитель/);
 await runtime.call({method:'check.stop',params:{checkId:running.checks[0]!.id}});
 const stopped=runtime.store.detail(task.id);assert.equal(stopped.checks[0]!.status,'stopped');assert.equal(stopped.checks[0]!.output,'STARTED');assert.equal(runtime.store.groups().length,0);
});

test('a check that changes source files is stale and an interrupted check is never replayed',async t=>{
 const {runtime,project,repo}=await fixture(t);runtime.store.trust(project.id,true);
 const task=await completedTask(runtime,project.id);
 const done=await check(runtime,task.id,'printf changed > codex-result.txt');
 assert.equal(done.checks[0]!.status,'failed');assert.equal(done.checks[0]!.stale,true);assert.match(done.checks[0]!.error,/Файлы изменились/);
 assert.equal(readFileSync(path.join(repo,'codex-result.txt'),'utf8'),'changed');
 const pending=runtime.store.beginCheck(task.id,'printf SHOULD_NOT_REPLAY',randomUUID(),'before',runtime.store.messageSequence(task.id));
 runtime.store.checkOutput(pending.id,'partial');await runtime.checker.recover();
 assert.equal(runtime.store.check(pending.id).status,'interrupted');assert.equal(runtime.store.check(pending.id).output,'partial');
});

test('standalone fresh review retains read-only role across quota backup',async t=>{
 const {runtime,project,repo}=await fixture(t);runtime.store.trust(project.id,true);
 const task=await completedTask(runtime,project.id);
 runtime.store.configureRoles(task.id,roles.map(step=>({...step,provider:'codex'})));
 runtime.store.message(task.id,'[LIMIT_CODEX] [ROLE_LIMIT:reviewer] Review the current version',randomUUID());
 await runtime.call({method:'task.review',params:{taskId:task.id,requestId:randomUUID()}});
 const done=await wait(runtime,task.id,value=>value.runs.length===3&&value.task.status==='review');
 assert.deepEqual(done.runs.slice(1).map(run=>run.role),['reviewer','reviewer']);
 assert.deepEqual(done.runs.slice(1).map(run=>run.status),['limited','completed']);
 assert.equal(existsSync(path.join(repo,'claude-result.txt')),false);assert.equal(readFileSync(path.join(repo,'codex-result.txt'),'utf8').trim(),'CODEX_FIXTURE_RESULT');
});

test('concurrent file edit invalidates a read-only stage before another role starts',async t=>{
 const {runtime,project,repo}=await fixture(t);runtime.store.trust(project.id,true);
 const {task}=await pipeline(runtime,project.id);
 await wait(runtime,task.id,value=>value.runs[0]?.status==='running');
 writeFileSync(path.join(repo,'external.txt'),'user edit');
 const done=await wait(runtime,task.id,value=>value.workflow?.status==='waiting');
 assert.equal(done.runs.length,1);assert.equal(done.runs[0]!.status,'failed');assert.match(done.runs[0]!.error!,/Файлы изменились/);
 assert.equal(readFileSync(path.join(repo,'external.txt'),'utf8'),'user edit');
});

test('new requirements during a command invalidate its successful exit',async t=>{
 const {runtime,project}=await fixture(t);runtime.store.trust(project.id,true);
 const task=runtime.store.createTask(project.id,'Initial criteria',randomUUID()).task;
 await runtime.call({method:'check.start',params:{taskId:task.id,command:'sleep 0.3; printf DONE',requestId:randomUUID()}});
 runtime.store.message(task.id,'Different criteria',randomUUID());
 const done=await wait(runtime,task.id,value=>value.checks[0]?.status==='failed');
 assert.equal(done.checks[0]!.exitCode,0);assert.equal(done.checks[0]!.stale,true);assert.match(done.checks[0]!.error,/Требования изменились/);
});

test('unavailable project invalidates saved acceptance instead of keeping a success label',async t=>{
 const {runtime,project,repo}=await fixture(t);runtime.store.trust(project.id,true);
 const task=await completedTask(runtime,project.id);
 await runtime.call({method:'task.accept',params:{taskId:task.id,note:'Manual review'}});
 rmSync(repo,{recursive:true,force:true});
 await assert.rejects(runtime.call({method:'task.verify',params:{taskId:task.id}}),/папку проекта/);
 const done=runtime.store.detail(task.id);assert.equal(done.acceptance?.stale,true);assert.equal(done.task.status,'review');
});

test('review sends an incomplete implementation through one repair pass',async t=>{
 const {runtime,project,repo}=await fixture(t);runtime.store.trust(project.id,true);
 const {task}=await pipeline(runtime,project.id,'[REPAIR_ONCE]');await allow(runtime,task.id);
 const done=await wait(runtime,task.id,value=>value.workflow?.status==='ready');
 assert.equal(done.runs.length,6);assert.equal(done.workflow?.iteration,1);
 assert.deepEqual(done.runs.filter(run=>run.role==='reviewer').map(run=>run.reviewVerdict),['changes_required','ready']);
 assert.ok(existsSync(path.join(repo,'codex-result.txt')));assert.equal(done.task.status,'review');
});

test('repair is bounded and repeated reviewer objections require user action',async t=>{
 const {runtime,project}=await fixture(t);runtime.store.trust(project.id,true);
 const {task}=await pipeline(runtime,project.id,'[ALWAYS_REJECT]');await allow(runtime,task.id);await allow(runtime,task.id);
 const done=await wait(runtime,task.id,value=>value.workflow?.status==='waiting');
 assert.equal(done.runs.length,6);assert.equal(done.workflow?.iteration,1);assert.match(done.group!.reason,/замечания остались/);
 assert.equal(runtime.store.groups().length,0);
 await assert.rejects(runtime.call({method:'task.accept',params:{taskId:task.id,note:'ignore'}}),/Цепочка ролей/);
});

test('quota attempts reset for the bounded repair stage, not for a repeated request',async t=>{
 const {runtime,project}=await fixture(t);runtime.store.trust(project.id,true);
 const {task}=await pipeline(runtime,project.id,'[REPAIR_ONCE] [LIMIT_CODEX]');await allow(runtime,task.id);
 const done=await wait(runtime,task.id,value=>value.workflow?.status==='ready');
 assert.equal(done.runs.length,8);assert.equal(done.transfers.length,2);
 assert.deepEqual(done.runs.filter(run=>run.role==='developer').map(run=>[run.iteration,run.status]),[[0,'limited'],[0,'completed'],[1,'limited'],[1,'completed']]);
});

test('missing structured review output cannot close a workflow',async t=>{
 const {runtime,project}=await fixture(t);runtime.store.trust(project.id,true);
 const {task}=await pipeline(runtime,project.id,'[NO_REVIEW_FORMAT]');await allow(runtime,task.id);
 const done=await wait(runtime,task.id,value=>value.workflow?.status==='waiting');
 assert.equal(done.runs.length,4);assert.equal(done.runs.at(-1)!.reviewVerdict,null);assert.match(done.group!.reason,/структурированный вывод/);
});

test('rename and reversible archive preserve accepted results and block archived execution',async t=>{
 const {runtime,project}=await fixture(t);runtime.store.trust(project.id,true);
 const task=await completedTask(runtime,project.id);
 await runtime.call({method:'task.accept',params:{taskId:task.id,note:'Manual text review'}});
 const before=runtime.store.detail(task.id);
 const renamed=await runtime.call({method:'task.rename',params:{taskId:task.id,title:'Renamed result'}}) as TaskDetail;
 assert.equal(renamed.task.title,'Renamed result');assert.equal(renamed.acceptance?.runId,before.acceptance?.runId);
 await runtime.call({method:'task.archive',params:{taskId:task.id,archived:true}});
 await assert.rejects(execute(runtime,task.id,'codex'),/архиве/);
 await assert.rejects(runtime.call({method:'task.message',params:{taskId:task.id,text:'Hidden work',requestId:randomUUID()}}),/архиве/);
 await assert.rejects(runtime.call({method:'check.start',params:{taskId:task.id,command:'printf NO',requestId:randomUUID()}}),/архиве/);
 const restored=await runtime.call({method:'task.archive',params:{taskId:task.id,archived:false}}) as TaskDetail;
 assert.equal(restored.task.archived,false);assert.equal(restored.task.status,'accepted');assert.deepEqual(restored.runs,before.runs);assert.deepEqual(restored.events,before.events);
});

test('active work cannot be hidden or renamed, and invalid role plans never start',async t=>{
 const {runtime,project}=await fixture(t);runtime.store.trust(project.id,true);
 const task=runtime.store.createTask(project.id,'Task controls',randomUUID()).task;
 await assert.rejects(runtime.call({method:'task.roles',params:{taskId:task.id,steps:roles.slice(0,3)}}),/четыре/);
 await assert.rejects(runtime.call({method:'task.rename',params:{taskId:task.id,title:'Two\nlines'}}),/одной строке/);
 await runtime.call({method:'check.start',params:{taskId:task.id,command:'sleep 60',requestId:randomUUID()}});
 await assert.rejects(runtime.call({method:'task.archive',params:{taskId:task.id,archived:true}}),/остановите/);
 await assert.rejects(runtime.call({method:'task.rename',params:{taskId:task.id,title:'Hidden'}}),/остановите/);
 await runtime.checker.stop(runtime.store.detail(task.id).checks[0]!.id);
});

test('blocked review and user permission denial never trigger automatic repair',async t=>{
 const {runtime,project}=await fixture(t);runtime.store.trust(project.id,true);
 for(const [marker,decision] of [['[REVIEW_BLOCKED]','allow'],['[ALWAYS_REJECT]','deny']] as const){
  const {task}=await pipeline(runtime,project.id,marker);await allow(runtime,task.id,decision);
  const done=await wait(runtime,task.id,value=>value.workflow?.status==='waiting');
  assert.equal(done.runs.length,4);assert.equal(done.workflow?.iteration,0);assert.match(done.group!.reason,/решения пользователя/);
 }
});

test('v3 release migration preserves completed runs, history, models and request keys',async()=>{
 const directory=mkdtempSync(path.join(tmpdir(),'ade-v3-migration-')),filename=path.join(directory,'ade.sqlite');
 const original=new Runtime(filename),project=original.store.addProject('/tmp/ade-legacy-project');original.store.trust(project.id,true);
 const requestId=randomUUID(),detail=original.store.createTask(project.id,'Legacy completed task',requestId);
 const packet:Checkpoint={id:randomUUID(),taskId:detail.task.id,eventSequence:2,head:null,gitDigest:'old',manifest:[],prompt:'legacy context',digest:'old',createdAt:new Date().toISOString()};
 const run=original.store.beginRun(detail.task.id,'codex','legacy-model',randomUUID(),packet);original.store.appendRun(run.id,'run.output',{itemId:'answer',text:'Preserved output',replace:'true'});original.store.finishRun(run.id,'completed');
 const before=original.store.detail(detail.task.id);original.close();
 const db=new DatabaseSync(filename);downgradeTo4(db);db.exec(`PRAGMA foreign_keys=OFF;DROP TABLE acceptances;DROP TABLE verifications;DROP TABLE workflows;ALTER TABLE runs DROP COLUMN role;ALTER TABLE runs DROP COLUMN artifactDigest;ALTER TABLE runs DROP COLUMN iteration;ALTER TABLE runs DROP COLUMN reviewVerdict;ALTER TABLE tasks DROP COLUMN rolePlanData;ALTER TABLE tasks DROP COLUMN archived;PRAGMA user_version=3;`);db.close();
 const restored=new Runtime(filename);
 try {
  assert.deepEqual(restored.store.detail(detail.task.id),before);assert.equal(restored.store.project(project.id).trusted,true);
  assert.equal(restored.store.createTask(project.id,'Legacy completed task',requestId).runs.length,1);
  assert.equal(restored.store.bootstrap().tasks.length,1);assert.equal(restored.store.bootstrap().schemaVersion,6);
 } finally {await restored.shutdown();rmSync(directory,{recursive:true,force:true});}
});

test('orchestrator quota replacement preserves the plan chain and independent developer reserve',async t=>{
 const {runtime,project}=await fixture(t);runtime.store.trust(project.id,true);
 const {task}=await pipeline(runtime,project.id,'[ROLE_LIMIT:orchestrator] [LIMIT_CODEX]');await allow(runtime,task.id);
 const done=await wait(runtime,task.id,value=>value.workflow?.status==='ready');
 assert.deepEqual(done.runs.slice(0,2).map(run=>[run.role,run.provider,run.status]),[['orchestrator','codex','limited'],['orchestrator','claude','completed']]);
 assert.equal(done.transfers.length,2);assert.equal(done.runs.at(-1)!.role,'reviewer');assert.equal(done.workflow!.stepIndex,3);
});

test('verification logs preserve Unicode split across process output chunks',async t=>{
 const {runtime,project}=await fixture(t);runtime.store.trust(project.id,true);
 const task=runtime.store.createTask(project.id,'Unicode check',randomUUID()).task;
 const done=await check(runtime,task.id,`node -e 'const b=Buffer.from("А😊");let i=0;const t=setInterval(()=>{process.stdout.write(b.subarray(i,i+1));if(++i===b.length)clearInterval(t)},10)'`);
 assert.equal(done.checks[0]!.status,'passed');assert.equal(done.checks[0]!.output,'А😊');
});

function downgradeTo4(db: DatabaseSync) {
 db.exec(`PRAGMA foreign_keys=OFF;
 ALTER TABLE runs DROP COLUMN profileId;ALTER TABLE execution_groups DROP COLUMN profileBindings;
 DROP TABLE handoff_receipts;DROP TABLE handoffs;DROP INDEX run_project_writer;DROP INDEX run_role_owner;
 CREATE UNIQUE INDEX run_project_owner ON runs(projectId) WHERE status IN ('starting','running','awaiting_approval','stopping');
 ALTER TABLE runs DROP COLUMN compact;ALTER TABLE runs DROP COLUMN promptBytes;ALTER TABLE runs DROP COLUMN summaryData;ALTER TABLE runs DROP COLUMN usageData;
 ALTER TABLE tasks DROP COLUMN parallel;ALTER TABLE tasks DROP COLUMN economy;
 ALTER TABLE workflows DROP COLUMN parallel;ALTER TABLE workflows DROP COLUMN economy;ALTER TABLE workflows DROP COLUMN baseDigest;ALTER TABLE workflows DROP COLUMN inputSequence;
 PRAGMA user_version=4;`);
}

async function parallelPipeline(runtime: Runtime, projectId: string, text = '[PARALLEL_DELAY] Implement a small result') {
 const task=runtime.store.createTask(projectId,text,randomUUID()).task;
 runtime.store.configureRoles(task.id,roles);runtime.store.configureWorkflow(task.id,true,true);
 const requestId=randomUUID();const detail=runtime.runner.startWorkflow(task.id,requestId);return {task,requestId,groupId:detail.workflow!.groupId};
}

test('parallel preparation overlaps two native processes, gates the writer, and delivers compact results with measured usage',async t=>{
 const {runtime,project,repo,directory}=await fixture(t);runtime.store.trust(project.id,true);
 mkdirSync(path.join(repo,'child'));const child=await runtime.addProject(path.join(repo,'child'));runtime.store.trust(child.id,true);
 const {task,requestId}=await parallelPipeline(runtime,project.id);
 const active=await wait(runtime,task.id,d=>d.runs.filter(run=>ACTIVE_RUNS.includes(run.status)).length===2);
 assert.equal(new Set(active.runs.map(run=>run.pid)).size,2);assert.deepEqual(active.runs.map(run=>run.role).sort(),['orchestrator','researcher']);
 const other=runtime.store.createTask(child.id,'Conflicting writer',randomUUID()).task;
 await assert.rejects(execute(runtime,other.id,'codex'),/активный исполнитель/);
 const waiting=await wait(runtime,task.id,d=>!!d.approvals.length);assert.equal(waiting.runs.at(-1)!.role,'developer');
 assert.ok(waiting.runs.slice(0,2).every(run=>run.status==='completed'));
 await allow(runtime,task.id);const done=await wait(runtime,task.id,d=>d.workflow?.status==='ready');
 assert.equal(done.runs.length,4);assert.ok(done.runs.every(run=>run.compact&&run.summary&&run.usage&&run.promptBytes<=32768));
 const [a,b]=done.runs;assert.ok(Date.parse(a!.startedAt)<Date.parse(b!.endedAt!)&&Date.parse(b!.startedAt)<Date.parse(a!.endedAt!));
 assert.ok(done.runs.slice(0,2).every(run=>Date.parse(run.endedAt!)<=Date.parse(done.runs[2]!.startedAt)));
 assert.equal(done.handoffs.length,5);assert.ok(done.handoffs.every(item=>item.recipients.length===1));
 assert.ok(done.runs.every(run=>run.usage!.cachedInput<=run.usage!.input));
 const db=new DatabaseSync(path.join(directory,'data','ade.sqlite'),{readOnly:true});
 const packet=JSON.parse(db.prepare('SELECT data FROM checkpoints WHERE id=?').get(done.runs[2]!.checkpointId)!.data as string);db.close();
 assert.match(packet.prompt,/ROLE_ORCHESTRATOR/);assert.match(packet.prompt,/ROLE_RESEARCHER/);
 assert.equal(packet.prompt.match(/ROLE_ORCHESTRATOR/g).length,1);assert.ok(done.runs.reduce((sum,run)=>sum+run.promptBytes,0)<=131072);
 runtime.runner.startWorkflow(task.id,requestId);assert.equal(runtime.store.detail(task.id).runs.length,4);
});

test('Stop terminates both parallel members and releases their shared lease',async t=>{
 const {runtime,project}=await fixture(t);runtime.store.trust(project.id,true);
 const {task,groupId}=await parallelPipeline(runtime,project.id,'[PARALLEL_HOLD]');
 const running=await wait(runtime,task.id,d=>d.runs.length===2&&d.runs.every(run=>run.status==='running'));
 await runtime.runner.stopWorkflow(groupId);
 const done=runtime.store.detail(task.id);assert.equal(done.workflow!.status,'stopped');assert.equal(done.task.status,'stopped');assert.ok(done.runs.every(run=>run.status==='stopped'));
 assert.equal(runtime.store.activeRuns().length,0);assert.equal(runtime.store.groups().length,0);
 const states=execFileSync('/bin/ps',['-axo','pid=,stat='],{encoding:'utf8'});
 assert.ok(running.runs.every(run=>!states.split('\n').some(line=>{const [pid,state]=line.trim().split(/\s+/);return Number(pid)===run.pid&&!state?.startsWith('Z');})));
});

test('a malformed parallel handoff stops its peer and never starts a writer or a repair call',async t=>{
 const {runtime,project}=await fixture(t);runtime.store.trust(project.id,true);
 const {task}=await parallelPipeline(runtime,project.id,'[PARALLEL_DELAY] [NO_HANDOFF]');
 const done=await wait(runtime,task.id,d=>d.workflow?.status==='waiting'&&d.runs.every(run=>!ACTIVE_RUNS.includes(run.status)));
 assert.equal(done.runs.length,2);assert.ok(done.runs.some(run=>run.status==='failed'&&/передач/.test(run.error!)));assert.equal(done.handoffs.length,0);
});

test('parallel quota handoffs preserve branch identity and independent developer reserve within six calls',async t=>{
 const {runtime,project}=await fixture(t);runtime.store.trust(project.id,true);
 const {task}=await parallelPipeline(runtime,project.id,'[LIMIT_CODEX] [ROLE_LIMIT:orchestrator]');
 await allow(runtime,task.id);const done=await wait(runtime,task.id,d=>d.workflow?.status==='ready');
 assert.equal(done.runs.length,6);assert.equal(done.transfers.length,2);
 assert.deepEqual(done.runs.filter(run=>run.role==='orchestrator').map(run=>[run.provider,run.status]),[['codex','limited'],['claude','completed']]);
 assert.equal(done.runs.at(-1)!.role,'reviewer');assert.ok(done.transfers.every(item=>item.status==='started'&&done.runs.some(run=>run.id===item.toRunId&&run.provider===item.toProvider)));
});

test('economy blocks a seventh call and aggregate context overflow without dropping requirements',async t=>{
 const {runtime,project}=await fixture(t);runtime.store.trust(project.id,true);
 const first=await parallelPipeline(runtime,project.id,'[LIMIT_CODEX] [ROLE_LIMIT:orchestrator] [ALWAYS_REJECT]');
 await allow(runtime,first.task.id);const capped=await wait(runtime,first.task.id,d=>d.workflow?.status==='waiting'&&d.runs.length===6);
 assert.match(capped.group!.reason,/бюджет/);
 const second=await parallelPipeline(runtime,project.id,'[REPAIR_ONCE]\n'+'x'.repeat(24000));
 const total=await wait(runtime,second.task.id,d=>d.workflow?.status==='waiting');
 assert.equal(total.runs.length,4);assert.match(total.group!.reason,/бюджет/);assert.ok(total.runs.every(run=>run.promptBytes<=32768));
 assert.ok(total.events.some(event=>event.type==='message.created'&&event.payload.text?.includes('x'.repeat(24000))));
});

test('oversized economy input and output pause explicitly; no-usage remains unknown',async t=>{
 const {runtime,project}=await fixture(t);runtime.store.trust(project.id,true);
 const first=await parallelPipeline(runtime,project.id,'x'.repeat(32000));
 const input=await wait(runtime,first.task.id,d=>d.workflow?.status==='waiting');assert.equal(input.runs.length,0);assert.match(input.group!.reason,/32 КиБ/);
 const second=await parallelPipeline(runtime,project.id,'[HUGE_ANSWER] [NO_USAGE]');
 const output=await wait(runtime,second.task.id,d=>d.workflow?.status==='waiting'&&d.runs.every(run=>!ACTIVE_RUNS.includes(run.status)));
 assert.ok(output.runs.some(run=>/64 КиБ/.test(run.error||'')));assert.ok(output.runs.every(run=>run.usage===null));assert.ok(output.runs.every(run=>run.role!=='developer'));
});

test('schema 4 migration preserves accepted artifacts and CLI assignments without enabling concurrency retroactively',async t=>{
 const {runtime,project,directory}=await fixture(t);runtime.store.trust(project.id,true);
 const task=await completedTask(runtime,project.id);await check(runtime,task.id,'printf VERIFIED');await runtime.call({method:'task.accept',params:{taskId:task.id,note:''}});
 runtime.store.configureRoles(task.id,roles);const before=runtime.store.detail(task.id);await runtime.shutdown();
 const file=path.join(directory,'data','ade.sqlite'),db=new DatabaseSync(file);downgradeTo4(db);db.close();
 const restored=new Runtime(file);t.after(()=>restored.shutdown());await restored.initialize();
 const after=restored.store.detail(task.id);assert.equal(after.task.status,'accepted');assert.deepEqual(after.acceptance,before.acceptance);assert.deepEqual(after.task.rolePlan,before.task.rolePlan);
 assert.equal(after.task.parallel,false);assert.equal(after.task.economy,false);assert.deepEqual(after.handoffs,[]);assert.equal(after.runs[0]!.id,before.runs[0]!.id);assert.equal(after.runs[0]!.promptBytes,before.runs[0]!.promptBytes);
 assert.equal(restored.store.bootstrap().schemaVersion,6);
});

test('recovery resumes only an unstarted parallel branch and never repeats its completed peer',async t=>{
 const {runtime,project}=await fixture(t);runtime.store.trust(project.id,true);
 const task=runtime.store.createTask(project.id,'Recovered compact preparation',randomUUID()).task;
 runtime.store.configureRoles(task.id,roles);runtime.store.configureWorkflow(task.id,true,true);
 const group=runtime.store.startWorkflow(task.id,randomUUID()).workflow!;
 const packet=await checkpoint(project,runtime.store.detail(task.id),'orchestrator',0,{compact:true,parallel:true});
 const run=runtime.store.beginRun(task.id,'codex','',randomUUID(),packet,group.groupId,'orchestrator');
 const summary={summary:'Saved plan',files:[],next:'Implement after research',blockers:[]};
 runtime.store.appendRun(run.id,'run.output',{itemId:'answer',text:'ADE_HANDOFF '+JSON.stringify(summary),replace:'true'});
 runtime.store.finishRun(run.id,'completed','',null,workspaceDigest(packet.gitDigest,packet.manifest),null,summary);
 await runtime.runner.recover();await runtime.runner.recover();await allow(runtime,task.id);
 const done=await wait(runtime,task.id,d=>d.workflow?.status==='ready');assert.equal(done.runs.length,4);assert.equal(done.runs[0]!.id,run.id);
 assert.equal(done.runs.filter(run=>run.role==='orchestrator').length,1);assert.ok(done.handoffs.every(item=>item.recipients.length===1));
});

test('recovery interrupts both persisted active branches, retains partial replies, and never replays them',async t=>{
 const {runtime,project}=await fixture(t);runtime.store.trust(project.id,true);
 const task=runtime.store.createTask(project.id,'Interrupted parallel work',randomUUID()).task;
 runtime.store.configureRoles(task.id,roles);runtime.store.configureWorkflow(task.id,true,true);
 const group=runtime.store.startWorkflow(task.id,randomUUID()).workflow!;
 for(const role of ['orchestrator','researcher'] as const){const packet=await checkpoint(project,runtime.store.detail(task.id),role,0,{compact:true,parallel:true});const run=runtime.store.beginRun(task.id,role==='orchestrator'?'codex':'claude','',randomUUID(),packet,group.groupId,role);runtime.store.appendRun(run.id,'run.output',{itemId:'answer',text:'partial '+role,replace:'false'});}
 await runtime.runner.recover();await runtime.runner.recover();
 const done=runtime.store.detail(task.id);assert.equal(done.runs.length,2);assert.ok(done.runs.every(run=>run.status==='interrupted'));assert.equal(done.workflow!.status,'interrupted');assert.equal(done.task.status,'interrupted');
 assert.equal(conversation(done.events).filter(message=>message.text.startsWith('partial ')).length,2);assert.equal(runtime.store.groups().length,0);
});

test('parallel branches cannot join with different file versions',async t=>{
 const {runtime,project,repo}=await fixture(t);runtime.store.trust(project.id,true);
 const task=runtime.store.createTask(project.id,'Same snapshot required',randomUUID()).task;
 runtime.store.configureRoles(task.id,roles);runtime.store.configureWorkflow(task.id,true,true);const group=runtime.store.startWorkflow(task.id,randomUUID()).workflow!;
 const a=await checkpoint(project,runtime.store.detail(task.id),'orchestrator',0,{compact:true,parallel:true});runtime.store.beginRun(task.id,'codex','',randomUUID(),a,group.groupId,'orchestrator');
 writeFileSync(path.join(repo,'external.txt'),'user edit');
 const b=await checkpoint(project,runtime.store.detail(task.id),'researcher',0,{compact:true,parallel:true});
 assert.throws(()=>runtime.store.beginRun(task.id,'claude','',randomUUID(),b,group.groupId,'researcher'),/одну версию/);assert.equal(readFileSync(path.join(repo,'external.txt'),'utf8'),'user edit');
});

test('compact context retains unabridged legacy answers, every user requirement and explicit permission refusals',async t=>{
 const {runtime,project}=await fixture(t);runtime.store.trust(project.id,true);
 const task=runtime.store.createTask(project.id,'Original acceptance criterion',randomUUID()).task;
 const packet=await checkpoint(project,runtime.store.detail(task.id));const run=runtime.store.beginRun(task.id,'codex','',randomUUID(),packet);
 const answer='Important legacy decision: '+'z'.repeat(9000);runtime.store.appendRun(run.id,'run.output',{itemId:'answer',text:answer,replace:'true'});
 const approval=runtime.store.approval(run.id,'command','Rejected action','Do not execute');runtime.store.resolveApproval(run.id,approval.id,'deny');runtime.store.finishRun(run.id,'completed');
 runtime.store.message(task.id,'A new criterion with reference to the saved decision',randomUUID());
 const compact=await checkpoint(project,runtime.store.detail(task.id),'developer',0,{compact:true,parallel:false});
 assert.ok(compact.prompt.includes(answer));assert.match(compact.prompt,/Original acceptance criterion/);assert.match(compact.prompt,/A new criterion/);assert.ok(compact.prompt.includes('User denied approval '+approval.id));
});
