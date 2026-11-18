import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync, realpathSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Runtime } from '../packages/runtime/src/service.js';
import { parseRequest, type Bootstrap, type TaskDetail, type GitSnapshot } from '../packages/contracts/src/index.js';
import { checkpoint } from '../packages/runtime/src/checkpoint.js';
import { parseStatus } from '../packages/runtime/src/git.js';
import { mutationId, confirmMutation } from '../apps/desktop/src/mutations.js';
import './execution.test.js';
import './accounts.test.js';
import './insights.test.js';
import './device-usage.test.js';

function fixture(t: { after: (fn: () => void) => void }) {
  const directory = mkdtempSync(path.join(tmpdir(), 'ade-runtime-'));
  const repo = path.join(directory, 'repo');
  const db = path.join(directory, 'data', 'ade.sqlite');
  execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'pipe' });
  const runtime = new Runtime(db);
  let closed = false;
  t.after(() => { if (!closed) runtime.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, repo, db, runtime, close: () => { runtime.close(); closed = true; } };
}

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

test('first boot contains no demonstration projects, profiles or tasks', async t => {
  const { runtime } = fixture(t);
  const data = await runtime.call({ method: 'bootstrap', params: {} }) as Bootstrap;
  assert.deepEqual(data.projects, []); assert.deepEqual(data.tasks, []);
  assert.equal(data.execution.available, true);
});

test('imports actual Git roots and deduplicates symlink paths', async t => {
  const f = fixture(t);
  const link = path.join(f.directory, 'alias');
  symlinkSync(f.repo, link);
  const a = await f.runtime.addProject(f.repo), b = await f.runtime.addProject(link);
  assert.equal(a.id, b.id); assert.equal(a.path, realpathSync(f.repo));
  const folder = await f.runtime.addProject(f.directory);
  assert.equal(folder.path, realpathSync(f.directory));
  assert.equal(folder.kind, 'directory');
  await assert.rejects(f.runtime.addProject(path.join(f.directory, 'missing')));
  assert.ok(f.runtime.store.bootstrap().projects.length >= 2);
});

test('tasks, messages and monotonic events survive restart', async t => {
  const f = fixture(t), project = await f.runtime.addProject(f.repo);
  const created = await f.runtime.call({ method: 'task.create', params: { projectId: project.id, text: 'Implement a feature\nAcceptance criteria', requestId: randomUUID() } }) as TaskDetail;
  assert.equal(created.task.status, 'draft');
  const id = created.task.id;
  const saved = await f.runtime.call({ method: 'task.message', params: { taskId: id, text: '<script>unsafe()</script>', requestId: randomUUID() } }) as TaskDetail;
  f.close();
  const restored = new Runtime(f.db);
  try {
    const detail = await restored.call({ method: 'task.get', params: { taskId: id } }) as TaskDetail;
    assert.deepEqual(detail, saved);
    assert.deepEqual(detail.events.map(event => event.sequence), [1, 2, 3]);
    assert.equal(detail.events.filter(event => event.payload.role === 'assistant').length, 0);
    assert.equal(detail.events[2]!.payload.text, '<script>unsafe()</script>');
    assert.equal(detail.runs.length, 0);
  } finally { restored.close(); }
});

test('replayed mutations do not duplicate tasks or messages and reject altered payloads', async t => {
  const { runtime, repo } = fixture(t), project = await runtime.addProject(repo);
  const params = { projectId: project.id, text: 'Persistent task', requestId: randomUUID() };
  const a = await runtime.call({ method: 'task.create', params }) as TaskDetail;
  const b = await runtime.call({ method: 'task.create', params }) as TaskDetail;
  assert.deepEqual(a, b); assert.equal(runtime.store.bootstrap().tasks.length, 1);
  await assert.rejects(runtime.call({ method: 'task.create', params: { ...params, text: 'Changed payload' } }), /другими данными/);
  const message = { taskId: a.task.id, text: 'Follow-up', requestId: randomUUID() };
  await runtime.call({ method: 'task.message', params: message });
  await runtime.call({ method: 'task.message', params: message });
  assert.equal(runtime.store.detail(a.task.id).events.length, 3);
  assert.equal(runtime.store.bootstrap().tasks.length, 1);
});

test('invalid project mutation rolls back and the same key remains usable', async t => {
  const { runtime, repo } = fixture(t), requestId = randomUUID();
  await assert.rejects(runtime.call({ method: 'task.create', params: { projectId: 'missing', text: 'Task', requestId } }), /не найден/);
  const project = await runtime.addProject(repo);
  await runtime.call({ method: 'task.create', params: { projectId: project.id, text: 'Task', requestId } });
  assert.equal(runtime.store.bootstrap().tasks.length, 1);
});

test('runtime rejects unknown operations, paths, extra keys and invalid inputs', async t => {
  const { runtime } = fixture(t);
  const invalid: unknown[] = [null, [], { method: 'readFile', params: { path: '/etc/passwd' } },
    { method: 'project.add', params: { path: '/' } }, { method: 'bootstrap', params: { extra: 'value' } },
    { method: '__proto__', params: {} }, { method: 'task.create', params: { projectId: 'id', text: ' ', requestId: 'id' } },
    { method: 'task.create', params: { projectId: 'id', text: 'x'.repeat(32001), requestId: 'id' } },
    { method: 'task.get', params: { taskId: '\0' } }, { method: 'task.get', params: { taskId: 4 } }];
  for (const request of invalid) { assert.throws(() => parseRequest(request)); await assert.rejects(runtime.call(request)); }
});

test('unknown database version blocks startup without downgrading the schema', t => {
  const f = fixture(t); f.close();
  const db = new DatabaseSync(f.db); db.exec('PRAGMA user_version=9'); db.close();
  assert.throws(() => new Runtime(f.db), /более новой/);
  const check = new DatabaseSync(f.db);
  assert.equal(check.prepare('PRAGMA user_version').get()!.user_version, 9); check.close();
});

test('abrupt exit rolls back incomplete changes while retaining committed events', async t => {
  const f = fixture(t), project = await f.runtime.addProject(f.repo);
  const task = f.runtime.store.createTask(project.id, 'Committed task', randomUUID());
  f.close();
  const interrupted = spawnSync(process.execPath, ['-e', `const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1]);db.exec('BEGIN IMMEDIATE');db.prepare('UPDATE tasks SET title=? WHERE id=?').run('Uncommitted',process.argv[2]);process.exit(21);`, f.db, task.task.id]);
  assert.equal(interrupted.status, 21);
  const recovered = new Runtime(f.db);
  try { assert.deepEqual(recovered.store.detail(task.task.id), task); } finally { recovered.close(); }
});

test('Git parser preserves spaces, newlines and rename source names', () => {
  assert.deepEqual(parseStatus(' M file with spaces.ts\0R  renamed\nfile.ts\0old file.ts\0?? new.ts\0'), [
    { status: ' M', path: 'file with spaces.ts' },
    { status: 'R ', path: 'renamed\nfile.ts', previousPath: 'old file.ts' },
    { status: '??', path: 'new.ts' },
  ]);
  assert.throws(() => parseStatus('R  new.ts\0')); assert.throws(() => parseStatus('bad\0'));
});

test('reads staged, unstaged and untracked changes without modifying the index or files', async t => {
  const { runtime, repo } = fixture(t);
  writeFileSync(path.join(repo, 'file.txt'), 'original\n');
  git(repo, 'add', '.'); git(repo, '-c', 'user.name=ADE Test', '-c', 'user.email=ade@example.invalid', 'commit', '-m', 'fixture');
  writeFileSync(path.join(repo, 'file.txt'), 'staged content\n'); git(repo, 'add', 'file.txt');
  writeFileSync(path.join(repo, 'file.txt'), 'unstaged content\n');
  writeFileSync(path.join(repo, 'new file.txt'), 'untracked\n');
  const index = () => createHash('sha256').update(readFileSync(path.join(repo, '.git', 'index'))).digest('hex');
  const before = index(), project = await runtime.addProject(repo);
  const snapshot = await runtime.call({ method: 'git.inspect', params: { projectId: project.id } }) as GitSnapshot;
  assert.match(snapshot.staged, /staged content/); assert.match(snapshot.unstaged, /unstaged content/);
  assert.equal(snapshot.branch, 'main'); assert.ok(snapshot.head);
  assert.deepEqual(snapshot.files.map(file => file.path), ['file.txt', 'new file.txt']);
  assert.equal(index(), before); assert.equal(readFileSync(path.join(repo, 'file.txt'), 'utf8'), 'unstaged content\n');
  assert.equal(snapshot.digest.length, 64);
});

test('supports repositories before the first commit and reports removed roots', async t => {
  const { runtime, repo } = fixture(t), project = await runtime.addProject(repo);
  writeFileSync(path.join(repo, 'first.txt'), 'first\n'); git(repo, 'add', 'first.txt');
  const snapshot = await runtime.call({ method: 'git.inspect', params: { projectId: project.id } }) as GitSnapshot;
  assert.equal(snapshot.head, null); assert.equal(snapshot.branch, 'main'); assert.match(snapshot.staged, /first/);
  rmSync(repo, { recursive: true });
  await assert.rejects(runtime.call({ method: 'git.inspect', params: { projectId: project.id } }));
});

test('read-only inspection never invokes repository fsmonitor or diff helpers', async t => {
  const f = fixture(t), marker = path.join(f.directory, 'executed');
  writeFileSync(path.join(f.repo, 'file.txt'), 'before\n'); git(f.repo, 'add', '.');
  git(f.repo, '-c', 'user.name=ADE Test', '-c', 'user.email=ade@example.invalid', 'commit', '-m', 'fixture');
  writeFileSync(path.join(f.repo, 'file.txt'), 'after\n');
  const helper = path.join(f.directory, 'helper.sh');
  writeFileSync(helper, '#!/bin/sh\ntouch ' + marker + '\n', { mode: 0o755 });
  git(f.repo, 'config', 'core.fsmonitor', helper); git(f.repo, 'config', 'diff.external', helper);
  git(f.repo, 'config', 'diff.unsafe.textconv', helper);
  writeFileSync(path.join(f.repo, '.gitattributes'), '*.txt diff=unsafe\n');
  const project = await f.runtime.addProject(f.repo);
  const snapshot = await f.runtime.call({ method: 'git.inspect', params: { projectId: project.id } }) as GitSnapshot;
  assert.match(snapshot.unstaged, /after/); assert.equal(existsSync(marker), false);
});

test('client retains a mutation key for retries and reloads until acknowledged', () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  const params = { projectId: 'project', text: 'Task' };
  const first = mutationId(storage, 'task.create', params);
  assert.equal(mutationId(storage, 'task.create', { ...params }), first);
  confirmMutation(storage);
  const second = mutationId(storage, 'task.create', params);
  assert.notEqual(first, second);
  assert.notEqual(mutationId(storage, 'task.create', { ...params, text: 'Another task' }), second);
});


test('folder discovery preserves exact scopes, lazy descendants, IDs and missing tasks', async t => {
  const f = fixture(t), folder = path.join(f.directory, 'workspace');
  mkdirSync(path.join(folder, 'frontend', 'components'), { recursive: true });
  mkdirSync(path.join(folder, 'backend')); mkdirSync(path.join(folder, 'node_modules')); mkdirSync(path.join(folder, '.private'));
  symlinkSync(f.repo, path.join(folder, 'external-link'));
  const parent = await f.runtime.addProject(folder);
  let projects = f.runtime.store.bootstrap().projects;
  const frontend = projects.find(item => item.parentId === parent.id && item.name === 'frontend')!;
  assert.equal(frontend.kind, 'directory'); assert.equal(frontend.childrenLoaded, false);
  assert.equal(projects.some(item => ['node_modules', '.private', 'external-link', 'components'].includes(item.name)), false);
  await f.runtime.call({ method: 'project.children', params: { projectId: frontend.id } });
  assert.ok(f.runtime.store.bootstrap().projects.some(item => item.name === 'components' && item.parentId === frontend.id));
  const task = f.runtime.store.createTask(frontend.id, 'Saved folder task', randomUUID());
  rmSync(frontend.path, { recursive: true });
  await f.runtime.call({ method: 'project.children', params: { projectId: parent.id } });
  assert.equal(f.runtime.store.project(frontend.id).missing, true); assert.equal(f.runtime.store.detail(task.task.id).task.projectId, frontend.id);
  mkdirSync(frontend.path);
  await f.runtime.call({ method: 'project.children', params: { projectId: parent.id } });
  assert.equal(f.runtime.store.project(frontend.id).missing, false);
  assert.equal((await f.runtime.addProject(frontend.path)).id, frontend.id);
});

test('monorepo subdirectory snapshots and checkpoint never include sibling files', async t => {
  const f = fixture(t); mkdirSync(path.join(f.repo, 'app')); mkdirSync(path.join(f.repo, 'sibling'));
  writeFileSync(path.join(f.repo, 'app', 'inside.txt'), 'inside'); writeFileSync(path.join(f.repo, 'sibling', 'outside.txt'), 'outside');
  const project = await f.runtime.addProject(path.join(f.repo, 'app'));
  assert.equal(project.path, realpathSync(path.join(f.repo, 'app')));
  const snapshot = await f.runtime.call({ method: 'git.inspect', params: { projectId: project.id } }) as GitSnapshot;
  assert.equal(snapshot.repositoryRoot, realpathSync(f.repo)); assert.deepEqual(snapshot.files.map(file => file.path), ['inside.txt']);
  const detail = f.runtime.store.createTask(project.id, 'Scoped work', randomUUID());
  const packet = await checkpoint(project, detail); assert.deepEqual(packet.manifest.map(file => file.path), ['inside.txt']);
});

test('ordinary folders use file hashes and never follow external directory symlinks', async t => {
  const f = fixture(t), directory = path.join(f.directory, 'plain'); mkdirSync(directory);
  writeFileSync(path.join(directory, 'notes.txt'), 'version A'); symlinkSync(f.repo, path.join(directory, 'outside'));
  const project = await f.runtime.addProject(directory), detail = f.runtime.store.createTask(project.id, 'Plain folder', randomUUID());
  const first = await checkpoint(project, detail); writeFileSync(path.join(directory, 'notes.txt'), 'version B');
  const second = await checkpoint(project, detail);
  assert.notEqual(first.digest, second.digest); assert.ok(second.manifest.some(file => file.kind === 'symlink'));
  assert.equal(second.manifest.some(file => file.path.startsWith('outside/')), false);
  assert.equal((await f.runtime.call({ method: 'git.inspect', params: { projectId: project.id } }) as GitSnapshot).kind, 'directory');
});

test('root and subprojects share ownership even when imported child first', async t => {
  const f = fixture(t); mkdirSync(path.join(f.repo, 'app'));
  const child = await f.runtime.addProject(path.join(f.repo, 'app')), root = await f.runtime.addProject(f.repo);
  f.runtime.store.trust(child.id, true); f.runtime.store.trust(root.id, true);
  const task = f.runtime.store.createTask(child.id, 'Child task', randomUUID());
  const run = f.runtime.store.beginRun(task.task.id, 'codex', '', randomUUID(), await checkpoint(child, task));
  const other = f.runtime.store.createTask(root.id, 'Root task', randomUUID());
  const packet = await checkpoint(root, other);
  assert.throws(() => f.runtime.store.beginRun(other.task.id, 'claude', '', randomUUID(), packet), /активный исполнитель/);
  f.runtime.store.finishRun(run.id, 'limited', 'quota', { source: 'codex.usageLimitExceeded' });
  assert.throws(() => f.runtime.store.beginRun(other.task.id, 'claude', '', randomUUID(), packet), /активный исполнитель/);
  f.runtime.store.endGroup(run.groupId!, true, 'test cancelled');
  assert.ok(f.runtime.store.beginRun(other.task.id, 'claude', '', randomUUID(), packet));
});


test('review protocol rejects incomplete, duplicate and trailing records',async()=>{
 const {reviewVerdict}=await import('../packages/runtime/src/review.js');
 const report='ADE_REVIEW_RESULT '+JSON.stringify({verdict:'ready',summary:'Checked'});
 assert.equal(reviewVerdict('Findings\n'+report),'ready');
 assert.equal(reviewVerdict(report+'\ntrailing text'),null);
 assert.equal(reviewVerdict(report+'\n'+report),null);
 assert.equal(reviewVerdict('ADE_REVIEW_RESULT {"verdict":"ready"}'),null);
 assert.equal(reviewVerdict('ADE_REVIEW_RESULT {"verdict":"yes","summary":"Checked"}'),null);
});

test('handoff protocol validates size, destinations and final framing; usage normalizes cache without inventing zeros',async()=>{
 const {parseHandoff}=await import('../packages/contracts/src/handoff.js');const {tokenUsage}=await import('../packages/runtime/src/usage.js');
 const report={summary:'Implemented',files:['src/main.ts'],next:'Review actual files',blockers:[]};
 const line='ADE_HANDOFF '+JSON.stringify(report);assert.deepEqual(parseHandoff(line),report);assert.equal(parseHandoff(line+'\ntrailing'),null);assert.equal(parseHandoff(line+'\n'+line),null);
 assert.equal(parseHandoff('ADE_HANDOFF '+JSON.stringify({...report,files:['../secret']})),null);assert.equal(parseHandoff('ADE_HANDOFF '+JSON.stringify({...report,summary:'x'.repeat(2001)})),null);
 assert.ok(parseHandoff(line+'\nADE_REVIEW_RESULT {"verdict":"ready","summary":"Verified"}',true));
 const spacedReview=line+'\n \t\nADE_REVIEW_RESULT {"verdict":"ready","summary":"Verified"}';
 assert.deepEqual(parseHandoff(spacedReview,true),report);
 assert.equal(parseHandoff(line+'\nextra content\nADE_REVIEW_RESULT {"verdict":"ready","summary":"Verified"}',true),null);
 assert.equal(parseHandoff(spacedReview+'\ntrailing',true),null);
 assert.deepEqual(tokenUsage('codex',{inputTokens:100,outputTokens:5,cachedInputTokens:80}),{input:100,output:5,cachedInput:80,cacheWrite:0});
 assert.deepEqual(tokenUsage('claude',{input_tokens:10,output_tokens:5,cache_read_input_tokens:80,cache_creation_input_tokens:20}),{input:110,output:5,cachedInput:80,cacheWrite:20});
 assert.equal(tokenUsage('codex',undefined),null);assert.equal(tokenUsage('claude',{}),null);assert.equal(tokenUsage('codex',{inputTokens:-1,outputTokens:1}),null);
});
