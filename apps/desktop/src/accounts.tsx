import { useEffect, useRef, useState } from 'react';
import type { Provider, RuntimeRequest } from '../../../packages/contracts/src/index.js';
import type { AccountProfiles, AccountProfile } from '../../../packages/contracts/src/accounts.js';
import { Icon } from './ui.js';

export type ProfileRequest = Extract<RuntimeRequest, { method: `profile.${string}` }>;
const stateLabel = (profile: AccountProfile) => !profile.enabled ? 'Отключён' : profile.pending ? 'Ожидает входа' : ({ connected: 'Вход выполнен', signed_out: 'Не выполнен вход', needs_sign_in: 'Нужен вход', plan_disabled: 'ChatGPT plan не разрешён' })[profile.state];
export function AccountsPage({ data, busy, refreshing, onRefresh, onAction, onSignIn }: { data: AccountProfiles | null; busy: boolean; refreshing: boolean; onRefresh(): void; onAction(request: ProfileRequest): Promise<AccountProfiles | null>; onSignIn(id: string): void }) {
  const [selected, setSelected] = useState(() => { try { return localStorage.getItem('ade:last-profile') || ''; } catch { return ''; } }), [adding, setAdding] = useState(false), [provider, setProvider] = useState<Provider>('codex'), [name, setName] = useState('');
  const profiles = data?.profiles || [], profile = profiles.find(item => item.id === selected) || profiles.find(item => item.id === data?.selected[item.provider] && item.mode !== 'shared_cli') || profiles.find(item => item.id === data?.selected.codex) || profiles[0];
  const addToggle = useRef<HTMLButtonElement>(null), nameField = useRef<HTMLInputElement>(null), detailHeading = useRef<HTMLHeadingElement>(null), focusDetails = useRef(false);
  useEffect(() => { if (adding) nameField.current?.focus(); }, [adding]);
  useEffect(() => { if (focusDetails.current && detailHeading.current) { focusDetails.current = false; detailHeading.current.focus(); detailHeading.current.scrollIntoView({ block: 'start', behavior: 'instant' }); } }, [selected]);
  function choose(id: string, created = false) { focusDetails.current = created || matchMedia('(max-width:900px)').matches; setSelected(id); try { localStorage.setItem('ade:last-profile', id); } catch {} if (id === selected && focusDetails.current) { detailHeading.current?.focus(); detailHeading.current?.scrollIntoView({ block: 'start', behavior: 'instant' }); focusDetails.current = false; } }
  async function create() {
    const result = await onAction({ method: 'profile.create', params: { provider, name: name.trim(), requestId: crypto.randomUUID() } });
    if (result) { choose(result.profiles.at(-1)!.id, true); setAdding(false); setName(''); }
  }
  return <section className="local-page accounts-page" aria-label="Профили AI">
    <div className="local-section-head"><h1>Профили AI</h1><div className="account-actions"><button className="button" onClick={onRefresh} disabled={busy || refreshing}>{refreshing ? 'Проверяю подключения…' : 'Обновить профили'}</button><button ref={addToggle} className="button" aria-expanded={adding} aria-controls="add-account-form" disabled={busy} onClick={() => setAdding(value => !value)}><Icon name="plus" />Добавить аккаунт</button></div></div>
    <p className="local-muted">Каждый новый аккаунт хранит отдельный вход. Выбор действует на следующие запуски; работающая цепочка сохраняет свои назначения.</p>
    {adding ? <form id="add-account-form" className="account-create" onSubmit={event => { event.preventDefault(); if (!busy && name.trim()) void create(); }} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); setAdding(false); addToggle.current?.focus(); } }}>
      <label>Исполнитель<select aria-label="Исполнитель нового аккаунта" value={provider} disabled={busy} onChange={event => setProvider(event.target.value as Provider)}><option value="codex">Codex · Sign in with ChatGPT</option><option value="claude">Claude Code · официальный CLI</option></select></label>
      <label>Название аккаунта<input ref={nameField} aria-label="Название нового аккаунта" value={name} maxLength={40} placeholder="Как различать этот аккаунт" disabled={busy} onChange={event => setName(event.target.value)} /></label>
      <button className="button" type="submit" disabled={busy || !name.trim()}>Создать профиль</button>
    </form> : null}
    {!data ? <p className="local-empty" role="status">Загружаю профили аккаунтов…</p> : <div className="accounts-layout"><nav className="accounts-list" aria-label="Аккаунты AI">{(['codex', 'claude'] as Provider[]).map(provider => <div key={provider}><h2>{provider === 'codex' ? 'Codex / ChatGPT' : 'Claude Code'}</h2>{profiles.filter(item => item.provider === provider).map(item => <button key={item.id} className="account-row" aria-current={profile?.id === item.id ? 'true' : undefined} onClick={() => choose(item.id)}><strong>{item.name}</strong><span>{data.selected[provider] === item.id ? 'Выбран · ' : ''}{stateLabel(item)}</span><small>{item.mode === 'shared_cli' ? 'Общий вход CLI' : 'Изолированный аккаунт'}</small></button>)}</div>)}</nav>
      {profile ? <AccountDetails key={profile.id} headingRef={detailHeading} profile={profile} selected={data.selected[profile.provider] === profile.id} busy={busy} onAction={onAction} onSignIn={onSignIn} /> : <p className="local-empty">Добавьте первый аккаунт.</p>}
    </div>}
  </section>;
}

function AccountDetails({ profile, headingRef, selected, busy, onAction, onSignIn }: { profile: AccountProfile; headingRef: React.RefObject<HTMLHeadingElement | null>; selected: boolean; busy: boolean; onAction(request: ProfileRequest): Promise<AccountProfiles | null>; onSignIn(id: string): void }) {
  const [name, setName] = useState(profile.name), [code, setCode] = useState(''), [enabled, setEnabled] = useState(profile.enabled);
  const shared = profile.mode === 'shared_cli', active = busy || profile.pending;
  useEffect(() => setName(profile.name), [profile.name]);
  useEffect(() => setEnabled(profile.enabled), [profile.enabled]);
  const ready = profile.state === 'connected' && profile.enabled && !profile.pending;
  return <section className="account-details" aria-label="Настройки аккаунта"><h2 ref={headingRef} tabIndex={-1}>{profile.name}</h2><p className="account-state" role="status">{stateLabel(profile)}{selected ? ' · выбран для новых запусков' : ready ? ' · ещё не выбран' : ''}</p>
    {profile.email ? <p className="local-muted">{profile.email}</p> : null}
    <p className="local-muted">{shared ? 'ADE использует текущий вход официального CLI. Его авторизация сохраняется вне ADE; здесь нельзя выйти из общего аккаунта.' : profile.mode === 'siwc' ? 'Отдельная регистрация ADE в ChatGPT. Запросы используют ваш ChatGPT plan; API-ключ не нужен.' : 'Вход выполняет оригинальный Claude Code. Его настройки и запись входа отделены от других профилей.'}</p>
    {!profile.pending ? <p className="account-reason">{profile.reason}</p> : null}
    <div className="account-actions">
      {ready ? <button className={'button' + (!selected ? ' button-primary' : '')} disabled={busy || selected} onClick={() => void onAction({ method: 'profile.select', params: { profileId: profile.id } })}>{selected ? 'Выбран' : 'Использовать аккаунт'}</button> : null}
      {!shared && !profile.pending ? <button className={'button' + (!ready ? ' button-primary' : '')} data-oai-siwc-button={profile.mode === 'siwc' ? '' : undefined} disabled={busy || !profile.enabled} onClick={() => onSignIn(profile.id)}>{profile.mode === 'siwc' ? 'Continue with ChatGPT' : ready ? 'Повторить вход Claude CLI' : 'Войти через Claude CLI'}</button> : null}
      {profile.pending ? <button className="button" disabled={busy} onClick={() => void onAction({ method: 'profile.cancel', params: { profileId: profile.id } })}>Отменить вход</button> : <button className="button" disabled={busy || !profile.enabled} onClick={() => void onAction({ method: 'profile.check', params: { profileId: profile.id } })}>Проверить аккаунт</button>}
      {!shared && profile.state !== 'signed_out' ? <button className="button" disabled={active} onClick={() => void onAction({ method: 'profile.logout', params: { profileId: profile.id } })}>Выйти из аккаунта</button> : null}
    </div>
    {profile.pending ? <p className="local-muted" role="status">{profile.mode === 'siwc' ? 'Завершите вход в системном браузере и вернитесь в ADE.' : profile.needsCode ? 'Вставьте одноразовый код, который показал браузер.' : 'Завершите вход Claude в системном браузере.'}</p> : null}
    {profile.pending && profile.needsCode ? <form className="account-code" onSubmit={async event => { event.preventDefault(); if (!code.trim()) return; if (await onAction({ method: 'profile.code', params: { profileId: profile.id, code: code.trim() } })) setCode(''); }}><label>Код из браузера<input type="password" autoComplete="one-time-code" aria-label="Код входа Claude" value={code} maxLength={8192} disabled={busy} onChange={event => setCode(event.target.value)} /></label><button className="button" disabled={busy || !code.trim()}>Передать код официальному CLI</button></form> : null}
    {profile.mode === 'siwc' ? <div className="account-usage"><strong>{profile.state === 'connected' ? 'Using ChatGPT plan' : 'Использование ChatGPT plan'}</strong><p className="local-muted">Лимиты приложения, общий расход плана и разрешение на credits управляются в ChatGPT. Квота пока неизвестна; повторные входы не создают новый лимит.</p><button className="button" onClick={() => void window.ade.openExternal('https://chatgpt.com/settings/usage')}>Manage usage</button></div> : null}
    {!shared ? <><form className="account-rename" onSubmit={event => { event.preventDefault(); if (name.trim()) void onAction({ method: 'profile.rename', params: { profileId: profile.id, name: name.trim() } }); }}><label>Название профиля<input value={name} maxLength={40} disabled={busy} onChange={event => setName(event.target.value)} /></label><button className="button" disabled={busy || !name.trim() || name.trim() === profile.name}>Сохранить название</button></form><label className="account-enable"><input type="checkbox" checked={enabled} disabled={active} onChange={async event => { const next = event.target.checked; setEnabled(next); const result = await onAction({ method: 'profile.enable', params: { profileId: profile.id, enabled: next } }); setEnabled(result?.profiles.find(item => item.id === profile.id)?.enabled ?? profile.enabled); }} />Использовать профиль</label></> : null}
  </section>;
}

export function ChatGPTWelcome({ profileId, busy, onDismiss }: { profileId: string | null; busy: boolean; onDismiss(id: string): void }) {
  const dialog = useRef<HTMLDialogElement>(null), previous = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!profileId) return;
    previous.current = document.activeElement as HTMLElement; dialog.current?.showModal();
    return () => { dialog.current?.close(); previous.current?.focus(); };
  }, [profileId]);
  return <dialog ref={dialog} className="account-welcome" aria-labelledby="plan-welcome-title" onCancel={event => { event.preventDefault(); if (!busy && profileId) onDismiss(profileId); }}><h2 id="plan-welcome-title">Вы используете ChatGPT plan</h2><p>Запросы ADE через этот аккаунт используют ваш ChatGPT plan. Лимиты приложения и разрешение на credits задаются в настройках ChatGPT.</p><div className="account-actions"><button className="button button-primary" autoFocus disabled={busy} onClick={() => profileId && onDismiss(profileId)}>Понятно</button><button className="button" onClick={() => void window.ade.openExternal('https://chatgpt.com/settings/usage')}>Manage usage</button></div></dialog>;
}
