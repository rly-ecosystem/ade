import { useEffect, useState } from 'react';
import type { UsageCounts, UsageInsights, InsightPeriod } from '../../../packages/contracts/src/insights.js';
import type { AccountProfiles } from '../../../packages/contracts/src/accounts.js';
import type { Project } from '../../../packages/contracts/src/index.js';
import { PlanUsage } from './plan-usage.js';
import type { DeviceRow, DeviceUsage, UsageSource } from '../../../packages/contracts/src/device-usage.js';
import { profileLabel } from './profile-label.js';
import { projectTrail } from './projects.js';
import './insights.css';

const number = new Intl.NumberFormat('ru-RU');
const plural = new Intl.PluralRules('ru-RU');
function tokenUnit(count: number) {
  const form = plural.select(count);
  return form === 'one' ? 'токен' : form === 'few' ? 'токена' : 'токенов';
}
const dayFormat = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' });
const dateLabel = (date: string) => dayFormat.format(new Date(date + 'T12:00:00'));
type ChartRow = Omit<UsageCounts, 'completed'> & { cacheWrite?: number };
const sum = (value: Pick<ChartRow, 'input' | 'output'>) => value.input + value.output;
const tokens = (value: ChartRow) => value.measured ? number.format(sum(value)) : '—';

function Trend({ data, device = false }: { data: { totals: ChartRow; days: (ChartRow & { date: string })[]; timeZone: string }; device?: boolean }) {
  const [selected, select] = useState<string | null>(null);
  const { days, totals } = data;
  const peakDay = days.reduce((best, day) => sum(day) > sum(best) ? day : best);
  const peak = Math.max(1, sum(peakDay));
  const current = days.find(day => day.date === selected) || days.at(-1)!;
  const emptyLabel = device ? 'Нет записей' : 'Без запусков';
  const currentText = current.runs === 0 ? emptyLabel : device ? tokens(current) + ' ' + tokenUnit(sum(current)) + ' · сеансов: ' + current.measured : current.measured === 0 ? 'Расход неизвестен' : tokens(current) + ' ' + tokenUnit(sum(current)) + ' · замерено ' + current.measured + ' из ' + current.runs;
  return <section className="usage-trend" aria-labelledby="usage-total-label">
    <h2 id="usage-total-label">{device ? 'Токены на этом Mac' : 'Известный расход'}</h2>
    <div className="usage-total"><strong>{tokens(totals)}</strong> {tokenUnit(sum(totals))}</div>
    <p className="usage-note">{device ? 'Сеансов с замерами · ' + totals.runs : 'Замерено запусков · ' + totals.measured + ' из ' + totals.runs}</p>
    {sum(peakDay) > 0 ? <button className="small-action usage-peak" onClick={() => select(peakDay.date)}>Пик за день · {dateLabel(peakDay.date)} · {number.format(sum(peakDay))}</button> : null}
    <div className="usage-chart" role="group" aria-label="Токены по дням" onKeyDown={event => {
      const i = days.indexOf(current);
      const next = event.key === 'ArrowLeft' ? Math.max(0, i - 1) : event.key === 'ArrowRight' ? Math.min(days.length - 1, i + 1) : event.key === 'Home' ? 0 : event.key === 'End' ? days.length - 1 : -1;
      if (next === -1) return;
      event.preventDefault();
      event.currentTarget.querySelectorAll('button')[next]?.focus();
    }}>
      {days.map(day => <button key={day.date} type="button" tabIndex={day === current ? 0 : -1} aria-pressed={day === current} aria-label={dateLabel(day.date) + ', ' + (!day.runs ? emptyLabel.toLowerCase() : !day.measured ? 'расход неизвестен' : tokens(day) + ' ' + tokenUnit(sum(day)))} onFocus={() => select(day.date)} onClick={() => select(day.date)}>
        <span className={day.runs && !day.measured ? 'usage-unknown' : ''} style={{ height: day.measured ? Math.max(2, 100 * sum(day) / peak) + '%' : day.runs ? '6px' : '1px' }} />
      </button>)}
    </div>
    <div className="usage-axis"><span>{dateLabel(days[0]!.date)}</span><span title={data.timeZone}>Местное время</span><span>{dateLabel(days.at(-1)!.date)}</span></div>
    <p className="usage-point" aria-live="polite">{dateLabel(current.date)} · {currentText}</p>
    <details className="usage-days"><summary>Значения по дням</summary><table><thead><tr><th scope="col">Дата</th><th scope="col">Токены</th><th scope="col">{device ? 'Сеансы' : 'Замерено / запуски'}</th></tr></thead><tbody>{days.map(day => <tr key={day.date}><th scope="row">{dateLabel(day.date)}</th><td>{day.runs ? tokens(day) : emptyLabel}</td><td>{device ? day.runs : day.measured + ' / ' + day.runs}</td></tr>)}</tbody></table></details>
    {totals.measured > 0 ? <><h3 className="usage-composition">Расход за {days.length} дней</h3><dl className="usage-breakdown">{[['Вход', totals.input], ['В том числе из кеша', totals.cachedInput], ...(device ? [['В том числе запись в кеш', totals.cacheWrite || 0]] : []), ['Выход', totals.output]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{number.format(Number(value))}</dd></div>)}</dl></> : null}
  </section>;
}

function Ranking({ data, accounts }: { data: UsageInsights; accounts: AccountProfiles | null }) {
  const [sort, setSort] = useState('tokens');
  const rows = [...data.profiles].sort((a, b) => {
    const difference = sort === 'tokens' ? Number(b.measured > 0) - Number(a.measured > 0) || sum(b) - sum(a) : b.completed - a.completed;
    return difference || a.profileId.localeCompare(b.profileId, 'en');
  });
  return <section className="usage-ranking" aria-labelledby="rank-title">
    <div className="usage-section-head"><h2 id="rank-title">Рейтинг профилей</h2><select aria-label="Сортировка рейтинга" value={sort} onChange={event => setSort(event.target.value)}><option value="tokens">По токенам</option><option value="completed">По завершённым запускам</option></select></div>
    <ol>{rows.map(row => <li key={row.profileId}><div><strong>{profileLabel(accounts, row.profileId, row.provider)}</strong><small>{row.provider === 'codex' ? 'Codex' : 'Claude'} · замерено {row.measured} из {row.runs}</small></div><div className="usage-rank-value">{sort === 'tokens' ? tokens(row) : number.format(row.completed)}<small>{sort === 'tokens' ? row.measured ? tokenUnit(sum(row)) : 'нет замера' : 'завершено'}</small></div></li>)}</ol>
  </section>;
}

type InsightsProps = { projects: Project[]; accounts: AccountProfiles | null; onNew: (projectId: string) => void };
function TaskInsights({ projects, accounts, onNew }: InsightsProps) {
  const [period, setPeriod] = useState<InsightPeriod>(7), [projectId, setProject] = useState('');
  const [result, setResult] = useState<UsageInsights | null>(null), [error, setError] = useState(''), [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true, pending = false, timer: ReturnType<typeof setTimeout> | undefined;
    let dirty = false;
    async function refresh() {
      if (!active) return;
      if (pending) { dirty = true; return; }
      pending = true;
      try {
        const response = await window.ade.call('usage.insights', { period, projectId: projectId || null });
        if (!response.ok) throw new Error(response.error);
        if (active) { setResult(response.value); setError(''); }
      } catch (e) { if (active) setError((e as Error).message); }
      finally { pending = false; if (dirty && active) { dirty = false; schedule(); } }
    }
    function schedule() {
      if (!timer) timer = setTimeout(() => { timer = undefined; void refresh(); }, 250);
    }
    const midnight = () => { const next = new Date(); next.setHours(24, 0, 0, 0); return next.getTime() - Date.now() + 25; };
    let dayTimer: ReturnType<typeof setTimeout>;
    function rollover() { dayTimer = setTimeout(() => { schedule(); rollover(); }, midnight()); }
    setResult(null); setError(''); void refresh(); rollover();
    const unsubscribe = window.ade.onChange(schedule);
    window.addEventListener('focus', schedule);
    return () => { active = false; unsubscribe(); window.removeEventListener('focus', schedule); clearTimeout(timer); clearTimeout(dayTimer); };
  }, [period, projectId, retry]);
  return <div>
    <div className="usage-filters"><select aria-label="Проект статистики" value={projectId} onChange={event => setProject(event.target.value)}><option value="">Все проекты</option>{projects.map(p => <option value={p.id} key={p.id}>{projectTrail(p, projects).map(item => item.name).join(' / ')}</option>)}</select>
      <div className="usage-period" role="group" aria-label="Период статистики">{([7, 30] as const).map(days => <button key={days} aria-pressed={period === days} onClick={() => setPeriod(days)}>{days} дней</button>)}</div>
    </div>
    {error ? <p role="alert">{error} <button className="small-action" onClick={() => setRetry(value => value + 1)}>Повторить</button></p> : !result ? <p role="status">Считаю запуски…</p> : !result.totals.runs ? <section className="usage-empty"><h2>За этот период запусков нет</h2><p>Запустите исполнителя в задаче, чтобы увидеть расход профиля.</p><button className="button" onClick={() => onNew(projectId)}>Новая задача</button></section> : <>
      <Trend data={result} />
      <div className="usage-lower"><Ranking data={result} accounts={accounts} />
        <section className="usage-funnel"><h2>До приёмки</h2><p className="usage-note">Уникальные задачи за период</p>
        <ol>{[['С запуском', result.tasks.started], ['С завершённым шагом', result.tasks.completed], ['Приняты по последней сверке', result.tasks.accepted]].map(([label, value]) => <li key={label}><span>{label}</span><b>{number.format(Number(value))}</b></li>)}</ol></section>
      </div></>}
  </div>;
}

function DeviceHistoryView({ accounts }: { accounts: AccountProfiles | null }) {
  const [period, setPeriod] = useState<InsightPeriod>(7);
  const [sources, setSources] = useState<UsageSource[]>([]);
  useEffect(() => {
    let active = true;
    void window.ade.call('usage.sources', {}).then(response => { if (active && response.ok) setSources(response.value); }).catch(() => {});
    return () => { active = false; };
  }, []);
  const [result, setResult] = useState<DeviceUsage | null>(null), [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true, pending = false;
    async function refresh() {
      if (pending || document.hidden) return;
      pending = true;
      try {
        const response = await window.ade.call('usage.device', { period });
        if (!response.ok) throw new Error(response.error);
        if (active) { setResult(response.value); setError(''); }
      } catch (e) { if (active) setError((e as Error).message); }
      finally { pending = false; }
    }
    setResult(null); setError(''); void refresh();
    const timer = setInterval(refresh, 60000);
    window.addEventListener('focus', refresh);
    return () => { active = false; clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, [period, retry]);
  const chartRow = (row: DeviceRow): ChartRow => ({ ...row, runs: row.sessions, measured: row.sessions });
  return <>
    <PlanUsage accounts={accounts} sources={sources} />
    <div className="usage-filters"><div><h2>История использования</h2><p className="usage-note">Сеансы Codex и Claude Code на этом Mac, включая запуски вне ADE.</p></div>
      <div className="usage-period" role="group" aria-label="Период истории">{([7, 30] as const).map(days => <button key={days} aria-pressed={days === period} onClick={() => setPeriod(days)}>{days} дней</button>)}</div></div>
    {error ? <p role="alert">{error} <button className="small-action" onClick={() => setRetry(n => n + 1)}>Повторить</button></p> : !result ? <p role="status">Читаю историю CLI…</p> : <>
      {result.partial ? <p role="status" className="usage-note">Часть данных неполна. Показан подтверждённый расход.</p> : null}
      {result.totals.sessions === 0 ? <p className="usage-empty">За этот период нет записей о токенах.</p> : <>
        <Trend device data={{ totals: chartRow(result.totals), days: result.days.map(d => ({ ...chartRow(d), date: d.date })), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }} />
        <div className="usage-lower">{[
          { title: 'По профилям', rows: result.profiles.map(r => ({ ...r, key: r.profileId, label: sources.find(s => s.id === r.profileId)?.name || profileLabel(accounts, r.profileId, r.provider) })) },
          { title: 'По моделям', rows: result.models.map(r => ({ ...r, key: r.provider + r.model, label: r.model })) },
        ].map(({ title, rows }) => <section key={title} className="usage-ranking"><h2>{title}</h2><ol>{rows.map(row => <li key={row.key}>
          <div><strong>{row.label}</strong><small>{row.provider === 'codex' ? 'Codex' : 'Claude Code'} · сеансов: {row.sessions}</small></div>
          <div className="usage-rank-value">{number.format(sum(row))}<small>{tokenUnit(sum(row))}</small></div>
        </li>)}</ol></section>)}</div>
      </>}
    </>}
  </>;
}

export function InsightsPage(props: InsightsProps) {
  const [view, setView] = useState<'device' | 'ade'>('device');
  return <section className="local-page usage-page"><div className="usage-section-head usage-heading"><h1>Статистика</h1>
    <div className="usage-period" role="group" aria-label="Источник статистики"><button aria-pressed={view === 'device'} onClick={() => setView('device')}>На этом Mac</button><button aria-pressed={view === 'ade'} onClick={() => setView('ade')}>Задачи ADE</button></div></div>
    {view === 'device' ? <DeviceHistoryView accounts={props.accounts} /> : <TaskInsights {...props} />}
  </section>;
}
