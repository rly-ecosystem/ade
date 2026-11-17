import type { DatabaseSync } from 'node:sqlite';
import type { UsageCounts, UsageInsights, InsightPeriod } from '../../contracts/src/insights.js';
import type { Provider } from '../../contracts/src/index.js';
import { SHARED_PROFILES } from '../../contracts/src/accounts.js';
import type { TokenUsage } from '../../contracts/src/handoff.js';

const counts = (): UsageCounts => ({ runs: 0, measured: 0, input: 0, output: 0, cachedInput: 0, completed: 0 });
function dayKey(date: Date): string {
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}
function add(target: UsageCounts, usage: TokenUsage | null, completed: boolean) {
  target.runs++;
  if (completed) target.completed++;
  if (usage) {
    target.measured++;
    target.input += usage.input;
    target.output += usage.output;
    target.cachedInput += usage.cachedInput;
  }
}

export function usageInsights(db: DatabaseSync, period: InsightPeriod, project: string | null, now = new Date()): UsageInsights {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - period + 1);
  const days = new Map<string, UsageCounts & { date: string }>();
  for (const cursor = new Date(start); cursor <= now; cursor.setDate(cursor.getDate() + 1)) {
    const date = dayKey(cursor);
    days.set(date, { date, ...counts() });
  }
  const totals = counts(), profiles = new Map<string, UsageInsights['profiles'][number]>();
  const started = new Set<string>(), completed = new Set<string>(), accepted = new Set<string>();
  const rows = db.prepare(`SELECT r.taskId,r.provider,r.profileId,r.startedAt,r.status,r.usageData,a.createdAt AS acceptedAt
    FROM runs r JOIN tasks t ON t.id=r.taskId LEFT JOIN acceptances a ON a.runId=r.id AND a.taskId=r.taskId AND a.stale=0 AND t.status='accepted'
    WHERE r.startedAt >= ? AND r.startedAt <= ? ${project === null ? '' : 'AND r.projectId=?'}`);
  const endISO = now.toISOString(), startISO = start.toISOString();
  for (const row of rows.iterate(startISO, endISO, ...(project === null ? [] : [project]))) {
    const provider = row.provider as Provider, profileId = row.profileId as string || SHARED_PROFILES[provider];
    let profile = profiles.get(profileId);
    if (!profile) { profile = { provider, profileId, ...counts() }; profiles.set(profileId, profile); }
    const usage: TokenUsage | null = row.usageData ? JSON.parse(String(row.usageData)) : null;
    const done = row.status === 'completed', taskId = String(row.taskId);
    started.add(taskId);
    if (done) {
      completed.add(taskId);
      if (row.acceptedAt && String(row.acceptedAt) >= startISO && String(row.acceptedAt) <= endISO) accepted.add(taskId);
    }
    add(totals, usage, done);
    add(profile, usage, done);
    add(days.get(dayKey(new Date(String(row.startedAt))))!, usage, done);
  }
  return { asOf: endISO, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, totals, days: [...days.values()], profiles: [...profiles.values()], tasks: { started: started.size, completed: completed.size, accepted: accepted.size } };
}
