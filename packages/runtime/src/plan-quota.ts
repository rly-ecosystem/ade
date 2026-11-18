import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Provider } from '../../contracts/src/index.js';
import type { PlanQuota, QuotaWindow } from '../../contracts/src/device-usage.js';
import { cliEnvironment, executable, jsonLines } from './processes.js';

const safeLabel = (v: unknown) => typeof v === 'string' && v.length <= 80 && !/[\p{C}]/u.test(v) ? v : null;
export function emptyQuota(note: string | null): PlanQuota {
  return { asOf: new Date().toISOString(), plan: null, windows: [], credits: null, extraSpend: null, resetCredits: null, note };
}
function windowValue(label: string, percent: unknown, reset: unknown): QuotaWindow | null {
  if (typeof percent !== 'number' || !Number.isFinite(percent) || percent < 0) return null;
  const date = typeof reset === 'string' ? Date.parse(reset) : typeof reset === 'number' ? reset * 1000 : NaN;
  return { label, used: percent, resetAt: date > 0 && date <= 8.64e15 ? new Date(date).toISOString() : null };
}
function duration(minutes: number | null, fallback: string) {
  if (!Number.isSafeInteger(minutes) || !minutes || minutes < 0) return fallback;
  if (minutes === 10080) return 'Неделя';
  return minutes % 1440 === 0 ? minutes / 1440 + ' дн.' : minutes % 60 === 0 ? minutes / 60 + ' ч' : minutes + ' мин';
}
export function decodeQuota(provider: Provider, raw: Record<string, any>): PlanQuota {
  const result = emptyQuota(null);
  const append = (value: QuotaWindow | null) => { if (value && !result.windows.some(item => item.label === value.label)) result.windows.push(value); };
  if (provider === 'codex') {
    const available = raw.rateLimitResetCredits?.availableCount;
    if (Number.isSafeInteger(available) && available >= 0) result.resetCredits = available;
    if (raw.ordinaryUsageAllowed === false) result.note = 'Провайдер ограничил включённое использование.';
    const buckets = new Map(Object.entries(raw.rateLimitsByLimitId || {}) as [string, Record<string, any>][]);
    if (raw.rateLimits) {
      const id = raw.rateLimits.limitId || 'codex';
      if (!buckets.has(id)) buckets.set(id, raw.rateLimits);
    }
    for (const [id, bucket] of buckets) {
      if (!bucket) continue;
      result.plan ??= safeLabel(bucket.planType);
      const prefix = id === 'codex' ? '' : (safeLabel(bucket.limitName) || safeLabel(id) || 'Другой лимит') + ' · ';
      const individual = bucket.individualLimit;
      if (typeof individual?.remainingPercent === 'number' && individual.remainingPercent >= 0 && individual.remainingPercent <= 100)
        append(windowValue(prefix + 'Личный лимит', 100 - individual.remainingPercent, individual.resetsAt));
      if (bucket.spendControlReached === true) result.note = 'Достигнут лимит расходов.';
      for (const [kind, fallback] of [['primary', 'Основное окно'], ['secondary', 'Второе окно']] as const) {
        const v = bucket[kind];
        if (!v) continue;
        append(windowValue(prefix + duration(v.windowDurationMins, fallback), v.usedPercent, v.resetsAt));
      }
      const credits = bucket.credits;
      if (credits?.unlimited === true) result.credits = 'Без ограничения';
      else if (typeof credits?.balance === 'string' && /^\d+(\.\d+)?$/.test(credits.balance)) result.credits = credits.balance;
    }
  } else {
    result.plan = safeLabel(raw.subscription_type);
    const limits = raw.rate_limits;
    if (raw.rate_limits_available && limits) {
      for (const [key, obj] of Object.entries(limits)) {
        const v = obj as { utilization?: number; resets_at?: string } | null;
        if (!v || !/^(five_hour|seven_day)(_[a-z0-9_]+)?$/.test(key)) continue;
        const base = key.startsWith('five_hour') ? '5 ч' : 'Неделя';
        const scope = key.replace(/^(five_hour|seven_day)_?/, '').replaceAll('_', ' ');
        append(windowValue(scope ? base + ' · ' + scope : base, v.utilization, v.resets_at));
      }
      for (const row of [...(Array.isArray(limits.model_scoped) ? limits.model_scoped : []), ...(Array.isArray(limits.limits) ? limits.limits.filter((v: any) => v?.kind === 'weekly_scoped') : [])]) {
        const model = safeLabel(row?.display_name || row?.scope?.model?.display_name);
        if (model && !result.windows.some(w => w.label.toLowerCase() === ('Неделя · ' + model).toLowerCase())) append(windowValue('Неделя · ' + model, row.utilization ?? row.percent, row.resets_at));
      }
      const extra = limits.extra_usage;
      if (extra) {
        if (extra.is_enabled) append(windowValue('Дополнительный расход', extra.utilization, null));
        if (typeof extra.currency === 'string' && /^[A-Z]{3}$/i.test(extra.currency)) {
          const format = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: extra.currency.toUpperCase() });
          const unit = 10 ** (format.resolvedOptions().maximumFractionDigits ?? 2);
          const amount = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0 ? format.format(n / unit) : null;
          const spent = amount(extra.used_credits), limit = amount(extra.monthly_limit);
          if (spent) result.extraSpend = 'Дополнительный расход · ' + spent + (limit ? ' из ' + limit : '');
        }
      }
    }
  }
  if (!result.windows.length) result.note ??= 'Провайдер не передал окна лимитов.';
  return result;
}

export async function queryPlan(provider: Provider, environment?: NodeJS.ProcessEnv): Promise<PlanQuota> {
  const directory = await mkdtemp(path.join(tmpdir(), 'ade-plan-'));
  try {
    const binary = executable(provider), codex = provider === 'codex';
    const args = codex ? ['app-server', '--disable', 'plugins', '--disable', 'hooks', '--disable', 'apps'] : ['-p', '--no-session-persistence', '--safe-mode', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'];
    return await new Promise<PlanQuota>((resolve) => {
      const child = spawn(binary, args, { cwd: directory, env: cliEnvironment(binary, environment), stdio: 'pipe' });
      let finished = false;
      const unavailable = () => finish(emptyQuota('CLI не вернул лимиты. Проверьте вход и повторите обновление.'));
      const timer = setTimeout(unavailable, 12000);
      function finish(result: PlanQuota) {
        if (finished) return;
        finished = true; clearTimeout(timer); child.stdin.end(); child.kill('SIGKILL'); resolve(result);
      }
      child.on('error', unavailable); child.once('close', unavailable); child.stdin.on('error', unavailable); child.stderr.resume();
      const send = (value: unknown) => { if (!finished) child.stdin.write(JSON.stringify(value) + '\n'); };
      jsonLines(child, message => {
        if (codex && message.id === 1) {
          if (message.error) return unavailable();
          send({ method: 'initialized' }); send({ id: 2, method: 'account/rateLimits/read', params: {} });
        } else if (codex && message.id === 2) {
          if (message.result) finish(decodeQuota(provider, message.result)); else unavailable();
        } else if (!codex && message.type === 'control_response') {
          const response = message.response;
          if (response?.subtype !== 'success') return unavailable();
          if (response.request_id === 'init') send({ type: 'control_request', request_id: 'usage', request: { subtype: 'get_usage', skip_behaviors: true } });
          if (response.request_id === 'usage') finish(decodeQuota(provider, response.response || {}));
        }
      }, unavailable);
      send(codex ? { id: 1, method: 'initialize', params: { clientInfo: { name: 'rly_ade', version: '0.6.1' }, capabilities: { experimentalApi: false } } } : { type: 'control_request', request_id: 'init', request: { subtype: 'initialize', hooks: null } });
    });
  } catch { return emptyQuota('Официальный CLI недоступен. Проверьте установку и вход.'); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
