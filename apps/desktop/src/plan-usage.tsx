import { useEffect, useState } from 'react';
import type { AccountProfile, AccountProfiles } from '../../../packages/contracts/src/accounts.js';
import type { PlanQuota, UsageSource } from '../../../packages/contracts/src/device-usage.js';
import type { Provider } from '../../../packages/contracts/src/index.js';

const resetTime = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const clock = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });
const percent = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });

type QuotaProfile = UsageSource & Partial<Pick<AccountProfile, 'email' | 'state' | 'pending' | 'enabled' | 'mode'>>;
export function QuotaReading({ profile }: { profile: QuotaProfile }) {
  const [result, setResult] = useState<PlanQuota | null>(null);
  const [loading, setLoading] = useState(false), [error, setError] = useState('');
  const [attempt, retry] = useState(0);
  const siwc = profile.mode === 'siwc';
  const available = !siwc && profile.enabled !== false && !profile.pending && (!profile.mode || profile.mode === 'shared_cli' || profile.state === 'connected');
  useEffect(() => {
    let active = true, pending = false;
    setResult(null); setError('');
    if (!available) return;
    async function refresh() {
      if (pending || document.hidden) return;
      pending = true; setLoading(true);
      try {
        const response = await window.ade.call('usage.quota', { profileId: profile.id });
        if (!response.ok) throw new Error(response.error);
        if (active) { setResult(response.value); setError(''); }
      } catch (e) { if (active) { setError((e as Error).message); setResult(null); } }
      finally { pending = false; if (active) setLoading(false); }
    }
    void refresh();
    const timer = setInterval(refresh, 180000);
    document.addEventListener('visibilitychange', refresh);
    return () => { active = false; clearInterval(timer); document.removeEventListener('visibilitychange', refresh); };
  }, [profile.id, profile.email, profile.state, available, attempt]);
  if (siwc) return <div className="plan-reading"><p className="usage-note">Лимиты и кредиты этого профиля доступны в настройках ChatGPT.</p><button className="small-action" onClick={() => void window.ade.openExternal('https://chatgpt.com/settings/usage')}>Manage usage</button></div>;
  if (!available) return <p className="usage-note">{!profile.enabled ? 'Профиль отключён.' : 'Войдите в профиль, чтобы увидеть лимиты.'}</p>;
  return <div className="plan-reading">
    {result?.windows.map(w => <div key={w.label} className="quota-row">
      <label><span>{w.label}</span><strong>{percent.format(w.used)} %</strong><progress aria-label={w.label + ' · использовано'} value={Math.min(100, w.used)} max={100} /></label>
      {w.resetAt ? <small>Сброс {resetTime.format(new Date(w.resetAt))}</small> : null}
    </div>)}
    {result && result.credits !== null ? <p className="usage-note">Баланс кредитов · {result.credits}</p> : null}
    {result && result.resetCredits !== null ? <p className="usage-note">Доступно сбросов лимита · {result.resetCredits}</p> : null}
    {result?.extraSpend ? <p className="usage-note">{result.extraSpend}</p> : null}
    {result?.note || error ? <p role="status" className="usage-note">{error || result?.note}</p> : null}
    <div className="quota-meta"><small>{result ? [result.plan, clock.format(new Date(result.asOf))].filter(Boolean).join(' · ') : loading ? 'Запрашиваю лимиты…' : ''}</small>
      <button className="small-action" aria-label={'Обновить лимиты · ' + profile.name} disabled={loading} onClick={() => retry(n => n + 1)}>Обновить</button></div>
  </div>;
}
function ProviderQuota({ data, provider, sources }: { data: AccountProfiles; provider: Provider; sources: UsageSource[] }) {
  const [chosen, choose] = useState('');
  const profiles: QuotaProfile[] = [...data.profiles, ...sources].filter(p => p.provider === provider);
  const current = profiles.find(p => p.id === chosen) || profiles.find(p => p.id === data.selected[provider]) || profiles[0];
  if (!current) return null;
  const name = provider === 'codex' ? 'Codex' : 'Claude Code';
  return <section className="quota-provider"><div className="usage-section-head"><h3>{name}</h3>
    {profiles.length > 1 ? <select aria-label={'Профиль для лимитов ' + name} value={current.id} onChange={e => choose(e.target.value)}>{profiles.map(p => <option value={p.id} key={p.id}>{p.name}</option>)}</select> : <small>{current.name}</small>}</div>
    <QuotaReading key={current.id} profile={current} /></section>;
}
export function PlanUsage({ accounts, sources }: { accounts: AccountProfiles | null; sources: UsageSource[] }) {
  return <section aria-labelledby="plans-title"><h2 id="plans-title">Лимиты подписки</h2><p className="usage-note">Доля лимита, использованная в выбранном аккаунте на всех устройствах.</p>
    {accounts ? <div className="quota-grid"><ProviderQuota provider="codex" data={accounts} sources={sources} /><ProviderQuota provider="claude" data={accounts} sources={sources} /></div> : <p role="status">Загружаю профили…</p>}
  </section>;
}
