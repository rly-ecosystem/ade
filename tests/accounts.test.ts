import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, chmodSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Profiles } from '../packages/runtime/src/profiles.js';
import { SIWC, type Session, type Registration } from '../packages/runtime/src/siwc.js';
import { readPrivate, writePrivate } from '../packages/runtime/src/secure-files.js';
import { cliEnvironment } from '../packages/runtime/src/processes.js';
import { Runtime } from '../packages/runtime/src/service.js';
import type { TaskDetail, RoleStep } from '../packages/contracts/src/index.js';
import { SHARED_PROFILES } from '../packages/contracts/src/accounts.js';
import { oidcFixture } from './oidc-fixture.js';

async function until(check: () => boolean, milliseconds = 7000) { const deadline = Date.now() + milliseconds; while (!check()) { if (Date.now() > deadline) throw new Error('fixture deadline'); await new Promise(resolve => setTimeout(resolve, 15)); } }
async function fixture(t: { after(fn: () => void | Promise<void>): void }, lifetimeMs?: number) {
  const directory = mkdtempSync(path.join(tmpdir(), 'ade-accounts-')), oidc = await oidcFixture();
  const profiles = new Profiles(directory, undefined, { issuer: oidc.issuer, lifetimeMs });
  t.after(async () => { await profiles.close(); await oidc.close(); rmSync(directory, { recursive: true, force: true }); });
  const create = (provider: 'codex' | 'claude', name: string) => profiles.create(provider, name, randomUUID()).profiles.at(-1)!;
  const file = (id: string) => path.join(directory, 'accounts', id, 'siwc-session.json');
  const signIn = async (id: string, subject: string, options?: Record<string, any>) => { const launch = await profiles.startLogin(id); assert.ok(launch.url); await oidc.callback(launch.url, subject, options); await until(() => !profiles.list().profiles.find(item => item.id === id)!.pending); return profiles.list().profiles.find(item => item.id === id)!; };
  return { directory, oidc, profiles, create, file, signIn };
}
function cliFixture(directory: string) {
  const bin = path.join(directory, 'bin'); mkdirSync(bin);
  for (const provider of ['codex', 'claude']) { copyFileSync(path.resolve('tests/fixtures/cli.cjs'), path.join(bin, provider)); chmodSync(path.join(bin, provider), 0o755); }
  writeFileSync(path.join(bin, 'profiles-strict'), '1');
  return bin;
}
async function localCLI(t: { after(fn: () => void): void }, directory: string) {
  const bin = cliFixture(directory), original = { PATH: process.env.PATH, CODEX_HOME: process.env.CODEX_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, OPENAI_API_KEY: process.env.OPENAI_API_KEY };
  const global = path.join(directory, 'global'); mkdirSync(global);
  writeFileSync(path.join(global, 'fixture-account.json'), 'GLOBAL_SENTINEL');
  process.env.PATH = bin + path.delimiter + process.env.PATH; process.env.CODEX_HOME = global; process.env.CLAUDE_CONFIG_DIR = global; process.env.OPENAI_API_KEY = 'GLOBAL_API_SENTINEL';
  t.after(() => { for (const [key, value] of Object.entries(original)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  return { bin, global };
}

test('SIWC fresh sign-in validates a real signature and keeps accounts and registrations separate', async t => {
  const f = await fixture(t), a = f.create('codex', 'Личный'), b = f.create('codex', 'Рабочий');
  const launch = await f.profiles.startLogin(a.id), url = new URL(launch.url!);
  assert.equal(url.searchParams.get('client_id'), 'dynamic_agent_client'); assert.equal(url.searchParams.get('agent_name_hint'), 'RLY ADE');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256'); assert.match(url.searchParams.get('redirect_uri')!, /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
  await f.oidc.callback(launch.url!, 'alice'); await until(() => !f.profiles.list().profiles.find(item => item.id === a.id)!.pending);
  assert.equal((await f.signIn(b.id, 'bob')).state, 'connected');
  const ca = readPrivate<Session>(f.file(a.id))!, cb = readPrivate<Session>(f.file(b.id))!;
  assert.equal(ca.email, cb.email); assert.notEqual(ca.clientId, cb.clientId); assert.notEqual(ca.subject, cb.subject);
  assert.equal(statSync(f.file(a.id)).mode & 0o777, 0o600); assert.equal(statSync(path.dirname(f.file(a.id))).mode & 0o777, 0o700);
  assert.equal(JSON.stringify(f.profiles.list()).includes(ca.accessToken), false); assert.equal(JSON.stringify(f.profiles.list()).includes(ca.idToken), false);
  assert.deepEqual(f.profiles.snapshot(), SHARED_PROFILES);
  assert.equal(f.profiles.list().welcomeProfileId, a.id); f.profiles.welcome(a.id); assert.equal(f.profiles.list().welcomeProfileId, null);
  const registry = JSON.parse(readFileSync(path.join(f.directory, 'accounts/registry.json'), 'utf8'));
  assert.equal(registry.hostId, url.searchParams.get('ext_agent_host_id')); assert.equal(JSON.stringify(registry).includes(ca.refreshToken!), false);
});

test('SIWC rejects wrong and duplicate state without consuming the pending flow', async t => {
  const f = await fixture(t), account = f.create('codex', 'State'), launch = await f.profiles.startLogin(account.id);
  assert.equal((await f.oidc.callback(launch.url!, 'alice', { state: 'x'.repeat(new URL(launch.url!).searchParams.get('state')!.length) })).status, 400);
  assert.equal(f.oidc.exchanges, 0); assert.equal(existsSync(f.file(account.id)), false);
  assert.equal((await f.oidc.callback(launch.url!, 'alice', { state: 'я'.repeat(43) })).status, 400);
  const wrong = new URL(new URL(launch.url!).searchParams.get('redirect_uri')!); wrong.searchParams.append('state', 'bad'); wrong.searchParams.append('state', new URL(launch.url!).searchParams.get('state')!);
  assert.equal((await fetch(wrong)).status, 400);
  await f.oidc.callback(launch.url!, 'alice'); await until(() => !f.profiles.list().profiles.find(item => item.id === account.id)!.pending);
  assert.equal(f.oidc.exchanges, 1); await assert.rejects(f.oidc.callback(launch.url!, 'alice'));
});

test('SIWC rejects invalid signature, issuer, audience, nonce, expiry and missing identity', async t => {
  const f = await fixture(t);
  for (const [name, options] of Object.entries({ signature: { wrongSignature: true }, issuer: { issuer: 'https://attacker.invalid' }, audience: { audience: 'other' }, nonce: { nonce: 'other' }, expiry: { expired: true }, missing: { missingId: true } })) {
    await t.test(name, async () => {
      const profile = f.create('codex', name); const result = await f.signIn(profile.id, 'alice', options);
      assert.notEqual(result.state, 'connected'); assert.equal(existsSync(f.file(profile.id)), false);
      assert.deepEqual(f.profiles.snapshot(), SHARED_PROFILES);
    });
  }
});

test('reauthorization preserves the issued client, host and existing tokens on account mismatch', async t => {
  const f = await fixture(t), account = f.create('codex', 'Повторный вход'); await f.signIn(account.id, 'alice');
  const before = readFileSync(f.file(account.id), 'utf8'), launch = await f.profiles.startLogin(account.id), url = new URL(launch.url!);
  assert.equal(url.searchParams.get('client_id'), 'oaiapp_alice'); assert.equal(url.searchParams.has('agent_name_hint'), false);
  assert.equal(url.searchParams.get('id_token_hint'), JSON.parse(before).idToken);
  await f.oidc.callback(launch.url!, 'bob'); await until(() => !f.profiles.list().profiles.find(item => item.id === account.id)!.pending);
  assert.equal(readFileSync(f.file(account.id), 'utf8'), before); assert.match(f.profiles.list().profiles.find(item => item.id === account.id)!.reason, /другому аккаунту/);
  const next = await f.profiles.startLogin(account.id); await f.oidc.callback(next.url!, 'alice', { clientId: 'oaiapp_changed' }); await until(() => !f.profiles.list().profiles.find(item => item.id === account.id)!.pending);
  assert.equal(readFileSync(f.file(account.id), 'utf8'), before);
});

test('a failed code exchange retains registration and missing plan scope blocks inference', async t => {
  const f = await fixture(t), a = f.create('codex', 'Exchange'); await f.signIn(a.id, 'alice', { exchangeError: 'invalid_grant' });
  assert.equal(existsSync(f.file(a.id)), false);
  const next = await f.profiles.startLogin(a.id); assert.equal(new URL(next.url!).searchParams.get('client_id'), 'oaiapp_alice');
  await f.profiles.cancel(a.id);
  const b = f.create('codex', 'Identity only'); assert.equal((await f.signIn(b.id, 'bob', { scope: 'openid email profile' })).state, 'plan_disabled');
  await assert.rejects(f.profiles.acquire(b.id, 'codex'), /plan/); await assert.rejects(f.profiles.select(b.id), /plan/);
  assert.deepEqual(f.profiles.snapshot(), SHARED_PROFILES);
});

test('cancel, timeout, access_denied and incomplete registration leave saved accounts unchanged', async t => {
  const f = await fixture(t, 150), a = f.create('codex', 'Cancelled');
  await f.profiles.startLogin(a.id); await f.profiles.cancel(a.id); assert.equal(existsSync(f.file(a.id)), false);
  await f.profiles.startLogin(a.id); await until(() => !f.profiles.list().profiles.find(item => item.id === a.id)!.pending); assert.match(f.profiles.list().profiles.find(item => item.id === a.id)!.reason, /истекло/);
  assert.notEqual((await f.signIn(a.id, 'alice', { error: 'access_denied' })).state, 'connected'); assert.equal(f.oidc.exchanges, 0);
  const b = f.create('codex', 'Incomplete'); await f.signIn(b.id, 'bob', { missingClient: true }); assert.equal(existsSync(f.file(b.id)), false);
});

test('refresh is serialized across managers and atomically replaces a rotating token', async t => {
  const f = await fixture(t), account = f.create('codex', 'Refresh'); await f.signIn(account.id, 'alice');
  const saved = readPrivate<Session>(f.file(account.id))!; writePrivate(f.file(account.id), { ...saved, expiresAt: Date.now() - 1000 });
  const other = new Profiles(f.directory, undefined, { issuer: f.oidc.issuer }); t.after(() => other.close());
  await Promise.all([f.profiles.check(account.id), other.check(account.id), f.profiles.check(account.id)]);
  const updated = readPrivate<Session>(f.file(account.id))!; assert.equal(f.oidc.refreshes, 1); assert.notEqual(updated.refreshToken, saved.refreshToken); assert.notEqual(updated.accessToken, saved.accessToken);
  assert.equal(f.oidc.grants.filter(grant => grant.grant_type === 'refresh_token').every(grant => grant.client_id === saved.clientId && !grant.scope), true);
});

test('terminal refresh failure affects only its account and never falls back to a shared login', async t => {
  const f = await fixture(t), a = f.create('codex', 'Expired'), b = f.create('codex', 'Retained');
  await f.signIn(a.id, 'alice'); await f.signIn(b.id, 'bob');
  const other = readFileSync(f.file(b.id), 'utf8'), saved = readPrivate<Session>(f.file(a.id))!;
  writePrivate(f.file(a.id), { ...saved, expiresAt: 0 }); f.oidc.setRefreshError('invalid_grant');
  await assert.rejects(f.profiles.acquire(a.id, 'codex'), /недействителен/);
  assert.equal(existsSync(f.file(a.id)), false); assert.equal(readFileSync(f.file(b.id), 'utf8'), other);
  assert.equal(f.profiles.list().profiles.find(item => item.id === a.id)!.state, 'needs_sign_in');
});

test('logout revokes only the selected renewable session and preserves registration after restart', async t => {
  const f = await fixture(t), a = f.create('codex', 'Logout'), b = f.create('codex', 'Keep'); await f.signIn(a.id, 'alice'); await f.signIn(b.id, 'bob');
  const other = readFileSync(f.file(b.id), 'utf8'); await f.profiles.logout(a.id);
  assert.equal(f.oidc.revocations, 1); assert.equal(existsSync(f.file(a.id)), false); assert.equal(readFileSync(f.file(b.id), 'utf8'), other);
  const restored = new Profiles(f.directory, undefined, { issuer: f.oidc.issuer }); t.after(() => restored.close());
  const launch = await restored.startLogin(a.id), url = new URL(launch.url!);
  assert.equal(url.searchParams.get('client_id'), 'oaiapp_alice'); assert.equal(url.searchParams.has('id_token_hint'), false); await restored.cancel(a.id);
  f.oidc.setRevokeFailure(true); await f.profiles.logout(b.id); assert.equal(existsSync(f.file(b.id)), false); assert.match(f.profiles.list().profiles.find(item => item.id === b.id)!.reason, /отзыв не подтверждён/);
});

test('profile names, idempotency, disabled state and provider boundaries are enforced', async t => {
  const f = await fixture(t), key = randomUUID(), result = f.profiles.create('codex', 'Primary', key), id = result.profiles.at(-1)!.id;
  assert.equal(f.profiles.create('codex', 'Primary', key).profiles.at(-1)!.id, id);
  assert.throws(() => f.profiles.create('codex', 'primary', randomUUID()), /уникальным/);
  f.profiles.rename(id, 'Renamed'); assert.equal(f.profiles.list().profiles.at(-1)!.name, 'Renamed');
  assert.throws(() => f.profiles.assertProvider(id, 'claude'), /другому/); f.profiles.enable(id, false);
  await assert.rejects(f.profiles.acquire(id, 'codex'), /отключён/); await assert.rejects(f.profiles.logout(SHARED_PROFILES.codex), /профиль/);
});

test('official Claude sign-in/code/logout uses isolated directories and leaves global and sibling accounts intact', async t => {
  const f = await fixture(t), cli = await localCLI(t, f.directory), a = f.create('claude', 'Claude A'), b = f.create('claude', 'Claude B');
  writeFileSync(path.join(cli.bin, 'hold-login'), '1'); await f.profiles.startLogin(a.id);
  await until(() => !!f.profiles.list().profiles.find(item => item.id === a.id)!.needsCode);
  f.profiles.code(a.id, 'FIXTURE_AUTH_CODE'); await until(() => !f.profiles.list().profiles.find(item => item.id === a.id)!.pending);
  assert.equal(f.profiles.list().profiles.find(item => item.id === a.id)!.state, 'connected');
  rmSync(path.join(cli.bin, 'hold-login')); await f.profiles.startLogin(b.id); await until(() => !f.profiles.list().profiles.find(item => item.id === b.id)!.pending);
  await f.profiles.select(a.id); const lease = await f.profiles.acquire(a.id, 'claude');
  const env = cliEnvironment(path.join(cli.bin, 'claude'), lease.environment);
  assert.equal(env.CODEX_HOME, undefined); assert.equal(env.OPENAI_API_KEY, undefined); assert.notEqual(env.CLAUDE_CONFIG_DIR, cli.global);
  await assert.rejects(f.profiles.logout(a.id), /занят/); await assert.rejects(f.profiles.startLogin(a.id), /занят/);
  lease.release(); await f.profiles.logout(a.id);
  assert.equal((await f.profiles.status(b.id)).authenticated, true); assert.equal(readFileSync(path.join(cli.global, 'fixture-account.json'), 'utf8'), 'GLOBAL_SENTINEL');
});

test('shared Claude authentication, quota and task execution use the first configured home', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'ade-claude-homes-'));
  const runtime = new Runtime(path.join(directory, 'runtime.sqlite'));
  t.after(async () => { await runtime.shutdown(); rmSync(directory, { recursive: true, force: true }); });
  const cli = await localCLI(t, directory);
  const secondary = path.join(directory, 'other'), xdg = path.join(directory, 'xdg');
  mkdirSync(secondary); mkdirSync(xdg);
  const originalXdg = process.env.XDG_CONFIG_HOME;
  t.after(() => { if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = originalXdg; });
  process.env.CLAUDE_CONFIG_DIR = [' ', cli.global, secondary].join(', ');
  process.env.XDG_CONFIG_HOME = xdg;

  // The fixture must reject a quota or task launched with different settings than the sign-in check.
  const binary = path.join(cli.bin, 'claude');
  const source = readFileSync(binary, 'utf8');
  const guard = 'if (process.env.CLAUDE_CONFIG_DIR !== ' + JSON.stringify(cli.global) +
    ' || process.env.XDG_CONFIG_HOME !== ' + JSON.stringify(xdg) +
    ' || !process.env.PATH.split(require("node:path").delimiter).includes(' + JSON.stringify(cli.bin) + ')) process.exit(42);';
  writeFileSync(binary, source.replace("'use strict';", "'use strict';\n" + guard));

  const roots = await runtime.profiles.historyRoots();
  assert.equal(roots.find(root => root.profileId === SHARED_PROFILES.claude)?.home, cli.global);
  assert.ok(roots.some(root => root.provider === 'claude' && root.home === secondary && root.profileId.startsWith('cli-')));
  assert.equal((await runtime.profiles.status(SHARED_PROFILES.claude)).authenticated, true);
  assert.ok((await runtime.profiles.quota(SHARED_PROFILES.claude)).windows.length);
  const folder = path.join(directory, 'project'); mkdirSync(folder);
  const project = await runtime.addProject(folder); runtime.store.trust(project.id, true);
  const task = runtime.store.createTask(project.id, 'Use shared Claude', randomUUID()).task;
  await runtime.runner.execute(task.id, 'claude', '', randomUUID());
  await until(() => runtime.store.detail(task.id).approvals.length > 0);
  const approval = runtime.store.detail(task.id).approvals[0]!;
  runtime.runner.respond(approval.runId, approval.id, 'allow');
  await until(() => runtime.store.detail(task.id).runs[0]?.status === 'completed');
});

test('runtime records the SIWC profile and redacts the child access token from saved output', async t => {
  const f = await fixture(t); await localCLI(t, f.directory);
  const runtime = new Runtime(path.join(f.directory, 'runtime.sqlite'), undefined, { siwc: { issuer: f.oidc.issuer } }); t.after(() => runtime.shutdown());
  const created = runtime.profiles.create('codex', 'Runtime SIWC', randomUUID()).profiles.at(-1)!;
  const launch = await runtime.profiles.startLogin(created.id); await f.oidc.callback(launch.url!, 'alice'); await until(() => !runtime.profiles.list().profiles.find(item => item.id === created.id)!.pending);
  await runtime.profiles.select(created.id);
  const secret = readPrivate<Session>(f.file(created.id))!.accessToken, repo = path.join(f.directory, 'project'); mkdirSync(repo);
  const project = await runtime.addProject(repo); runtime.store.trust(project.id, true);
  const detail = runtime.store.createTask(project.id, '[PROFILE_LEAK]', randomUUID()); await runtime.runner.execute(detail.task.id, 'codex', '', randomUUID());
  await until(() => runtime.store.detail(detail.task.id).approvals.length > 0);
  const request = runtime.store.detail(detail.task.id).approvals[0]!; runtime.runner.respond(request.runId, request.id, 'allow');
  await until(() => runtime.store.detail(detail.task.id).runs.at(-1)!.status === 'completed');
  const done = runtime.store.detail(detail.task.id); assert.equal(done.runs[0]!.profileId, created.id); assert.equal(done.group!.profiles!.codex, created.id);
  assert.equal(JSON.stringify(done).includes(secret), false); assert.ok(done.events.some(event => event.payload.text?.includes('[credential]')));
});

test('parallel role assignments and default accounts stay pinned when selection changes mid-workflow', async t => {
  const f = await fixture(t); await localCLI(t, f.directory);
  const runtime = new Runtime(path.join(f.directory, 'runtime.sqlite')); t.after(() => runtime.shutdown());
  const a = runtime.profiles.create('claude', 'A', randomUUID()).profiles.at(-1)!, b = runtime.profiles.create('claude', 'B', randomUUID()).profiles.at(-1)!;
  for (const profile of [a, b]) { const env = runtime.profiles.environment(profile.id)!; writeFileSync(path.join(env.CLAUDE_CONFIG_DIR!, 'fixture-account.json'), '{}'); await runtime.profiles.check(profile.id); }
  await runtime.profiles.select(a.id); const repo = path.join(f.directory, 'project'); mkdirSync(repo); const project = await runtime.addProject(repo); runtime.store.trust(project.id, true);
  const task = runtime.store.createTask(project.id, '[PARALLEL_DELAY] [PROFILE_ECHO]', randomUUID()).task;
  const roles: RoleStep[] = ['orchestrator', 'researcher', 'developer', 'reviewer'].map(role => ({ role, provider: 'claude', model: '', ...(role === 'researcher' ? { profileId: b.id } : {}) })) as RoleStep[];
  runtime.store.configureRoles(task.id, roles); runtime.store.configureWorkflow(task.id, true, true); runtime.runner.startWorkflow(task.id, randomUUID());
  await runtime.profiles.select(b.id);
  await until(() => runtime.store.detail(task.id).approvals.length > 0); const request = runtime.store.detail(task.id).approvals[0]!; runtime.runner.respond(request.runId, request.id, 'allow');
  await until(() => runtime.store.detail(task.id).workflow!.status === 'ready', 12000);
  const done = runtime.store.detail(task.id); assert.deepEqual(done.runs.map(run => [run.role, run.profileId]).sort(), [['developer', a.id], ['orchestrator', a.id], ['researcher', b.id], ['reviewer', a.id]].sort());
  assert.equal(done.group!.profiles!.claude, a.id); assert.equal(runtime.profiles.snapshot().claude, b.id);
});

test('an isolated account limit does not trigger an unverified switch to a shared account', async t => {
  const f = await fixture(t); await localCLI(t, f.directory); const runtime = new Runtime(path.join(f.directory, 'runtime.sqlite')); t.after(() => runtime.shutdown());
  const profile = runtime.profiles.create('claude', 'Limited', randomUUID()).profiles.at(-1)!; const env = runtime.profiles.environment(profile.id)!;
  writeFileSync(path.join(env.CLAUDE_CONFIG_DIR!, 'fixture-account.json'), '{}'); await runtime.profiles.select(profile.id);
  const repo = path.join(f.directory, 'project'); mkdirSync(repo); const project = await runtime.addProject(repo); runtime.store.trust(project.id, true);
  const task = runtime.store.createTask(project.id, '[LIMIT_CLAUDE]', randomUUID()).task; await runtime.runner.execute(task.id, 'claude', '', randomUUID());
  await until(() => runtime.store.detail(task.id).runs[0]!.status === 'limited');
  const detail: TaskDetail = runtime.store.detail(task.id); assert.equal(detail.transfers.length, 0); assert.equal(detail.runs.length, 1); assert.equal(detail.group!.status, 'waiting');
});
