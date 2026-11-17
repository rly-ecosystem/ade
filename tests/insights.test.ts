import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../packages/runtime/src/store.js';
import { usageInsights } from '../packages/runtime/src/insights.js';
import { parseRequest } from '../packages/contracts/src/index.js';

const seed: (filename: string, now: Date, a: string, b: string) => void = require('./fixtures/insights.cjs');

test('local insight cohorts keep snapshots, coverage, archived tasks, zeroes and missing profiles distinct', t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ade-insights-')), filename = path.join(dir, 'usage.sqlite');
  const store = new Store(filename), a = store.addProject('/fixture/a'), b = store.addProject('/fixture/b');
  store.close();
  const now = new Date(2026, 10, 3, 12); // Includes the US autumn clock change.
  seed(filename, now, a.id, b.id);
  const db = new DatabaseSync(filename);
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const read = () => usageInsights(db, 7, null, now);
  const result = read();
  assert.deepEqual(result.totals, { runs: 5, measured: 4, input: 1615, output: 403, cachedInput: 807, completed: 4 });
  assert.deepEqual(result.tasks, { started: 3, completed: 2, accepted: 1 });
  assert.equal(result.days.length, 7);
  assert.equal(result.days[0]!.date, '2026-10-28');
  assert.equal(result.days[5]!.measured, 1); assert.equal(result.days[5]!.input, 0);
  assert.equal(result.days[4]!.measured, 0); assert.equal(result.days[6]!.runs, 2);
  assert.equal(result.profiles.find(p => p.profileId === 'shared-codex')!.runs, 2);
  assert.equal(result.profiles.find(p => !p.profileId.startsWith('shared-'))!.measured, 0);
  assert.equal(usageInsights(db, 30, null, now).totals.runs, 7);
  assert.equal(usageInsights(db, 7, a.id, now).totals.runs, 3);
  assert.equal(usageInsights(db, 7, 'empty', now).totals.runs, 0);
  assert.doesNotMatch(JSON.stringify(result), /Private task|fixture\/|workspaceDigest|requestId|email/);
  db.prepare("UPDATE runs SET usageData=json_set(usageData,'$.input',1100) WHERE id='run0'").run();
  assert.equal(read().totals.input, 1715); assert.equal(read().totals.runs, 5);
  db.prepare("UPDATE acceptances SET runId='run7',stale=0 WHERE taskId='b'").run();
  db.prepare("UPDATE tasks SET status='accepted' WHERE id='b'").run();
  assert.equal(read().tasks.accepted, 1);
  db.prepare("UPDATE acceptances SET stale=1 WHERE taskId='a'").run();
  assert.equal(read().tasks.accepted, 0);
});
test('insights accepts only the two periods and an explicit scope', () => {
  assert.throws(() => parseRequest({ method: 'usage.insights', params: { period: 6, projectId: null } }));
  assert.throws(() => parseRequest({ method: 'usage.insights', params: { period: 7 } }));
  assert.equal(parseRequest({ method: 'usage.insights', params: { period: 30, projectId: null } }).method, 'usage.insights');
});
