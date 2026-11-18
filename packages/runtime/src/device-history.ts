import { constants } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { Provider } from '../../contracts/src/index.js';
import type { DeviceRow, DeviceUsage } from '../../contracts/src/device-usage.js';
import type { TokenUsage } from '../../contracts/src/handoff.js';
import type { InsightPeriod } from '../../contracts/src/insights.js';
import { SHARED_PROFILES } from '../../contracts/src/accounts.js';
import { tokenUsage } from './usage.js';

export interface HistoryRoot { home: string; provider: Provider; profileId: string }
export interface RecordedRun { id: string; profileId: string | null; sessionId: string | null; provider: Provider; model: string; startedAt: string; usageData: string }
interface Entry { key: string; sharedKey: boolean; session: string; model: string; at: number; usage: TokenUsage }
interface Parsed { entries: Entry[]; partial: boolean }
const short = (v: unknown) => typeof v === 'string' && v.length <= 200 && !/[\p{C}]/u.test(v) ? v : '';
const dayKey = (d: Date) => [d.getFullYear(), String(d.getMonth()+1).padStart(2,'0'), String(d.getDate()).padStart(2,'0')].join('-');
const blank = (): DeviceRow => ({ input: 0, output: 0, cachedInput: 0, cacheWrite: 0, sessions: 0 });

async function parseFile(file: string, provider: Provider): Promise<Parsed> {
  // Keep only metering records. A transcript line may contain a very large image.
  const result: Parsed = { entries: [], partial: false };
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!(await handle.stat()).isFile()) throw new Error('Invalid log');
    let session = path.basename(file, '.jsonl'), model = '', turn = '', previous = '', lineNo = 0;
    let sessionFromLog = false;
    const processLine = (line: string) => {
      lineNo++;
      if (!(provider === 'claude' ? line.includes('"assistant"') && line.includes('"usage"') : /"token_count"|"session_meta"|"turn_context"/.test(line))) return;
      let row; try { row = JSON.parse(line); } catch { result.partial = true; return; }
      if (!row || typeof row !== 'object') return;
      let sharedKey = false, key: string, usage: TokenUsage | null, currentSession = session;
      const at = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : NaN;
      if (provider === 'codex') {
        const p = row.payload;
        if (row.type === 'session_meta') { sessionFromLog = !!short(p?.id); session = short(p?.id) || session; model = short(p?.model) || model; return; }
        if (row.type === 'turn_context') { turn = short(p?.turn_id); model = short(p?.model) || model; return; }
        const delta = p?.info?.last_token_usage;
        if (row.type !== 'event_msg' || p?.type !== 'token_count' || !delta) return;
        usage = tokenUsage(provider, { inputTokens: delta.input_tokens, outputTokens: delta.output_tokens, cachedInputTokens: delta.cached_input_tokens, cacheWriteInputTokens: delta.cache_write_input_tokens });
        if (!usage) return;
        const total = p.info.total_token_usage;
        const stamp = JSON.stringify(total ? [total.input_tokens, total.output_tokens, total.cached_input_tokens, total.total_tokens] : [at, usage]);
        if (stamp === previous) return;
        previous = stamp; sharedKey = !!turn || sessionFromLog; key = (turn || session) + '|' + at + '|' + stamp;
      } else {
        if (row.type !== 'assistant' || row.message?.model === '<synthetic>') return;
        usage = tokenUsage(provider, row.message?.usage);
        if (!usage) return;
        model = short(row.message.model); currentSession = short(row.sessionId) || session;
        const message = short(row.message.id), request = short(row.requestId);
        sharedKey = !!(message || request);
        key = sharedKey ? message + '|' + request : session + ':' + lineNo;
      }
      if (Number.isFinite(at)) result.entries.push({ key, sharedKey, session: currentSession, model: model || 'Модель не указана', at, usage });
    };
    let carry = '', skipping = false;
    for await (const chunk of handle.createReadStream({ encoding: 'utf8', autoClose: false })) {
      const parts = (chunk as string).split('\n');
      for (let i = 0; i < parts.length; i++) {
        if (!skipping) {
          carry += parts[i];
          if (carry.length > 32 * 1024 * 1024) { carry = ''; skipping = true; result.partial = true; }
        }
        if (i < parts.length - 1) { if (!skipping) processLine(carry); carry = ''; skipping = false; }
      }
    }
    if (carry) processLine(carry);
  } finally { await handle.close(); }
  return result;
}

export class DeviceHistory {
  private cache = new Map<string, { stamp: string; data: Parsed }>();
  private scanKey = '';
  private scan: Promise<{ sources: { root: HistoryRoot; parsed: Parsed }[]; partial: boolean }> | null = null;

  private async collect(roots: HistoryRoot[], since: number) {
    const sources: { root: HistoryRoot; parsed: Parsed }[] = [];
    const seen = new Set<string>();
    let partial = false;
    const optionalMissing = (err: unknown) => (err as NodeJS.ErrnoException)?.code === 'ENOENT';
    const visit = async (root: HistoryRoot, directory: string) => {
      try {
        const stat = await lstat(directory);
        if (!stat.isDirectory()) { partial = true; return; }
        for await (const item of await opendir(directory)) {
          const file = path.join(directory, item.name);
          if (item.isDirectory()) { await visit(root, file); continue; }
          if (!item.isFile() || !item.name.endsWith('.jsonl')) continue;
          try {
            const stat = await lstat(file);
            if (!stat.isFile() || stat.mtimeMs < since) continue;
            const id = stat.dev + ':' + stat.ino;
            if (seen.has(id)) continue;
            seen.add(id);
            const stamp = [root.provider, stat.ctimeMs, stat.size, file].join('|');
            const cached = this.cache.get(id);
            const parsed = cached?.stamp === stamp ? cached.data : await parseFile(file, root.provider);
            this.cache.set(id, { stamp, data: parsed });
            sources.push({ root, parsed }); partial ||= parsed.partial;
          } catch (err) { if (!optionalMissing(err)) partial = true; }
        }
      } catch (err) { if (!optionalMissing(err)) partial = true; }
    };
    const visitedRoots = new Set<string>();
    for (const root of roots) {
      for (const name of root.provider === 'codex' ? ['sessions', 'archived_sessions'] : ['projects']) {
        try {
          const target = await realpath(path.join(root.home, name));
          if (visitedRoots.has(target)) continue;
          visitedRoots.add(target); await visit(root, target);
        } catch (err) { if (!optionalMissing(err)) partial = true; }
      }
    }
    for (const key of this.cache.keys()) if (!seen.has(key)) this.cache.delete(key);
    return { sources, partial };
  }

  async read(roots: HistoryRoot[], period: InsightPeriod, runs: RecordedRun[], now = new Date()): Promise<DeviceUsage> {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - period + 1);
    // Both periods share the same scan when the user changes the selector mid-read.
    const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29).getTime();
    const key = JSON.stringify([cutoff, roots]);
    if (!this.scan || this.scanKey !== key) {
      this.scanKey = key;
      const scan = this.collect(roots, cutoff).finally(() => { if (this.scan === scan) this.scan = null; });
      this.scan = scan;
    }
    const collected = await this.scan;
    let partial = collected.partial;
    const days = new Map<string, DeviceRow & { date: string }>(), profiles = new Map<string, DeviceUsage['profiles'][number]>(), models = new Map<string, DeviceUsage['models'][number]>();
    for (let d = new Date(start); d <= now; d.setDate(d.getDate() + 1)) { const date = dayKey(d); days.set(date, { ...blank(), date }); }
    const totals = blank(), sessions = new Map<DeviceRow, Set<string>>();
    const add = (bucket: DeviceRow, id: string, usage: TokenUsage) => {
      bucket.input += usage.input; bucket.output += usage.output; bucket.cachedInput += usage.cachedInput; bucket.cacheWrite += usage.cacheWrite;
      let seen = sessions.get(bucket);
      if (!seen) { seen = new Set(); sessions.set(bucket, seen); }
      if (!seen.has(id)) { seen.add(id); bucket.sessions++; }
    };
    const record = (profileId: string, provider: Provider, entry: Entry) => {
      if (entry.at < start.getTime() || entry.at > now.getTime()) return;
      const date = days.get(dayKey(new Date(entry.at)))!;
      const modelKey = provider + ':' + entry.model, sessionKey = profileId + ':' + entry.session;
      const profile = profiles.get(profileId) || { ...blank(), provider, profileId };
      const model = models.get(modelKey) || { ...blank(), provider, model: entry.model };
      profiles.set(profileId, profile); models.set(modelKey, model);
      for (const bucket of [totals, date, profile, model]) add(bucket, sessionKey, entry.usage);
    };
    const unique = new Map<string, { root: HistoryRoot; entry: Entry }>(), logged = new Set<string>();
    for (const { root, parsed } of collected.sources) for (const entry of parsed.entries) {
      logged.add(root.provider + ':' + entry.session);
      const key = (entry.sharedKey ? root.provider : root.profileId) + ':' + entry.key, old = unique.get(key);
      // Claude can repeat one message in multiple blocks or resumed files.
      if (!old || entry.usage.input + entry.usage.output > old.entry.usage.input + old.entry.usage.output) unique.set(key, { root, entry });
    }
    const runOwners = new Map<string, string>();
    for (const run of runs) if (run.sessionId) runOwners.set(run.provider + ':' + run.sessionId, run.profileId || SHARED_PROFILES[run.provider]);
    for (const { root, entry } of unique.values()) {
      const owner = runOwners.get(root.provider + ':' + entry.session) || root.profileId;
      record(owner, root.provider, entry);
    }
    for (const run of runs) {
      const profile = run.profileId || SHARED_PROFILES[run.provider];
      if (run.sessionId && logged.has(run.provider + ':' + run.sessionId)) continue;
      let counters;
      try { counters = JSON.parse(run.usageData); } catch { partial = true; continue; }
      const usage = tokenUsage('codex', { inputTokens: counters?.input, outputTokens: counters?.output, cachedInputTokens: counters?.cachedInput, cacheWriteInputTokens: counters?.cacheWrite });
      const at = Date.parse(run.startedAt);
      if (!usage || !Number.isFinite(at)) { partial = true; continue; }
      record(profile, run.provider, { key: run.id, sharedKey: false, session: run.sessionId || run.id, model: run.model || 'Модель не указана', at, usage });
    }
    const descending = (a: DeviceRow, b: DeviceRow) => (b.input + b.output) - (a.input + a.output);
    return { asOf: now.toISOString(), totals, days: [...days.values()], profiles: [...profiles.values()].sort(descending), models: [...models.values()].sort(descending), partial };
  }
}
