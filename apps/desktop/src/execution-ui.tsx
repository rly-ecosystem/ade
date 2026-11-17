import { useEffect, useRef, useState } from 'react';
import { ACTIVE_RUNS, STATUS_LABELS, ROLE_LABELS, type Project, type Provider, type ProviderStatus, type TaskDetail, type TaskEvent } from '../../../packages/contracts/src/index.js';
import { reviewText } from '../../../packages/contracts/src/review.js';
import { handoffText } from '../../../packages/contracts/src/handoff.js';
import { Markdown } from './markdown.js';
import type { AccountProfiles } from '../../../packages/contracts/src/accounts.js';
import { profileLabel } from './profile-label.js';

export function Providers({ values, loading, onRefresh }: { values: ProviderStatus[]; loading: boolean; onRefresh: () => void }) {
  return <section className="local-providers" aria-label="Подключения AI"><div className="local-section-head"><h2>Подключения AI</h2><button className="button" onClick={onRefresh} disabled={loading}>{loading ? 'Проверяю CLI…' : 'Проверить подключения'}</button></div>
    {(['codex', 'claude'] as Provider[]).map(provider => { const status = values.find(item => item.provider === provider); return <div className="local-provider" key={provider}><strong>{provider === 'codex' ? 'Codex' : 'Claude Code'}</strong><span>{status?.version || 'Версия не проверена'}</span><p>{status?.reason || 'Проверяю текущий вход CLI…'}</p></div>; })}
    <p className="local-muted">Текущие подписочные входы официальных CLI. При подтверждённом лимите задача может перейти к другому исполнителю. API-резерв выключен.</p>
  </section>;
}

export function Execution({ detail, project, providers, accounts, busy, onTrust, onStart, onStop, onRespond, onRoute, children }: {
  detail: TaskDetail; project: Project; providers: ProviderStatus[]; accounts: AccountProfiles | null; busy: boolean;
  onTrust: (trusted: boolean) => void; onStart: (provider: Provider, model: string, backupModel: string) => void; onStop: (runId: string) => void;
  onRoute: (enabled: boolean, codexModel: string, claudeModel: string) => Promise<boolean>;
  children?: React.ReactNode;
  onRespond: (runId: string, id: string, decision: 'allow' | 'deny') => void;
}) {
  const [provider, setProvider] = useState<Provider>(() => localStorage.getItem('ade:provider') === 'claude' ? 'claude' : 'codex');
  const [models, setModels] = useState({ codex: detail.task.codexModel, claude: detail.task.claudeModel });
  const [autoSwitch, setAutoSwitch] = useState(detail.task.autoSwitch);
  useEffect(() => { setAutoSwitch(detail.task.autoSwitch); }, [detail.task.id, detail.task.autoSwitch]);
  useEffect(() => { setModels({ codex: detail.task.codexModel, claude: detail.task.claudeModel }); }, [detail.task.id]);
  const [trustRequested, setTrustRequested] = useState(false);
  useEffect(() => { if (!busy) setTrustRequested(false); }, [busy, project.id]);
  const checking = detail.checks.some(check => ['running', 'stopping'].includes(check.status));
  const run = detail.runs.filter(run => ACTIVE_RUNS.includes(run.status)).at(-1) || detail.runs.at(-1), switching = detail.group?.status === 'switching', active = !!(detail.task.archived || checking || switching || run && ACTIVE_RUNS.includes(run.status));
  useEffect(() => { if (run) { setProvider(run.provider); setModels({ codex: detail.task.codexModel, claude: detail.task.claudeModel }); } }, [run?.id, detail.task.id]);
  const backup: Provider = provider === 'codex' ? 'claude' : 'codex';
  const status = providers.find(item => item.provider === provider);
  const account = accounts?.profiles.find(item => item.id === (run && ACTIVE_RUNS.includes(run.status) ? run.profileId : status?.profileId));
  const running = run && ACTIVE_RUNS.includes(run.status);
  const routeSource = running ? run.profileId : accounts?.selected[provider], routeTarget = running ? detail.group?.profiles?.[backup] : accounts?.selected[backup];
  const routeSupported = [routeSource, routeTarget].every(id => !id || id.startsWith('shared-'));
  return <div className="local-execution" aria-label="Исполнение задачи">
    {!project.trusted ? <label className="local-trust"><input type="checkbox" checked={trustRequested} onChange={event => { setTrustRequested(event.target.checked); onTrust(event.target.checked); }} disabled={busy} /><span>Доверяю проекту и разрешаю агенту работать с его файлами.<small>{project.path}</small></span></label> : null}
    {detail.approvals.length ? <div className="task-approvals"><p className="approval-heading" role="status">Нужно ваше разрешение · {detail.approvals.length}</p>{detail.approvals.map(request => <section className="local-approval" key={request.id} aria-label="Запрос разрешения"><h3>{request.title}</h3><pre>{request.details}</pre><p className="local-muted">Только для этого действия.</p><div><button className="button button-primary" disabled={busy || run?.status === 'stopping'} onClick={() => onRespond(request.runId, request.id, 'allow')}>Разрешить один раз</button><button className="button" disabled={busy || run?.status === 'stopping'} onClick={() => onRespond(request.runId, request.id, 'deny')}>Отклонить</button></div></section>)}</div> : null}
    {switching ? <p className="local-route-status" role="status">Лимит {run?.provider}. Подготавливаю контекст для {detail.transfers.at(-1)?.toProvider}…</p> : detail.group?.status === 'waiting' ? <p className="local-run-error" role="status">{detail.group.reason}</p> : run?.error && !active ? <p className="local-run-error" role="status">{run.error}</p> : null}
    {run && ACTIVE_RUNS.includes(run.status) && account?.mode === 'siwc' ? <p className="task-account">Using ChatGPT plan · {account.name} <button className="small-action" onClick={() => void window.ade.openExternal('https://chatgpt.com/settings/usage')}>Manage usage</button></p> : null}
    {children}
    <details className="local-direct-run" open={!detail.workflow || !!run && run.groupId !== detail.workflow.groupId}><summary>Отдельный запуск</summary>
    <p className="task-account">Аккаунт: {account?.name || status?.profileName || 'Проверяется'}{account?.mode === 'siwc' && account.state === 'connected' ? <> · Using ChatGPT plan <button className="small-action" onClick={() => void window.ade.openExternal('https://chatgpt.com/settings/usage')}>Manage usage</button></> : null}</p>
    <div className="local-execution-row"><label>Исполнитель<select aria-label="Исполнитель" value={provider} disabled={active || busy} onChange={event => { const value = event.target.value as Provider; setProvider(value); localStorage.setItem('ade:provider', value); }}><option value="codex">Codex</option><option value="claude">Claude Code</option></select></label>
      <label>Модель<input aria-label="Модель" placeholder="По умолчанию CLI" value={models[provider]} maxLength={100} disabled={active || busy} onChange={event => setModels(previous => ({ ...previous, [provider]: event.target.value }))} /></label>
      {detail.task.archived ? <span className="local-muted">Задача в архиве</span> : checking ? <span className="local-muted">Выполняется команда проверки</span> : active && run ? <button className="button" onClick={() => onStop(run.id)} disabled={busy || run.status === 'stopping' && !run.error}>{run.status === 'stopping' ? run.error ? 'Повторить остановку' : 'Останавливаю…' : 'Остановить'}</button> : <button className="button local-run-button" disabled={active || busy || project.missing || !project.trusted || !status?.authenticated || !!account && (account.pending || !account.enabled || account.state !== 'connected')} onClick={() => onStart(provider, models[provider].trim(), models[backup].trim())}>{detail.runs.length ? 'Продолжить' : 'Запустить'} {provider === 'codex' ? 'Codex' : 'Claude'}</button>}
    </div>
    <details className="local-route"><summary>{routeSupported ? 'Резерв при лимите · ' + (autoSwitch ? (provider === 'codex' ? 'Claude' : 'Codex') : 'выключен') : 'Автопереход недоступен для этого маршрута'}</summary><div className="local-route-settings"><label className="local-route-toggle"><input type="checkbox" aria-label="Автопереход при лимите" checked={autoSwitch && routeSupported} disabled={active || busy || !routeSupported} onChange={event => { setAutoSwitch(event.target.checked); void onRoute(event.target.checked, models.codex.trim(), models.claude.trim()).then(setAutoSwitch); }} /><span>Продолжать другим исполнителем при лимите</span></label><label>Резервная модель {backup === 'codex' ? 'Codex' : 'Claude'}<input aria-label="Резервная модель" value={models[backup]} placeholder="По умолчанию CLI" maxLength={100} disabled={active || busy || !autoSwitch || !routeSupported} onChange={event => setModels(previous => ({ ...previous, [backup]: event.target.value }))} /></label><p className="local-muted">{routeSupported ? 'Одна передача за запуск. Ответы, требования и состояние файлов сохраняются. Разрешения на команды запрашиваются заново.' : 'Источник или резерв использует изолированный аккаунт. Допуск такого автоперехода ещё не подтверждён; продолжение выбирается вручную.'}</p></div></details>
    <p className="local-muted">Рабочая папка: {project.name}. Разрешения действуют на один запрос. До 15 минут на запуск. Аккаунт выбирается в «Профили AI».</p>
    {!routeSupported ? <p className="local-muted">Источник или резерв использует изолированный аккаунт. Автопереход при лимите недоступен; можно продолжить вручную.</p> : null}
    {!active && !status?.authenticated ? <p className="local-muted">{status?.reason || 'Проверяю подключение…'}</p> : null}
    {run ? <p className="local-muted">{STATUS_LABELS[run.status]} · {run.provider === 'codex' ? 'Codex' : 'Claude'}{run.model ? ' · ' + run.model : ''}</p> : null}
    </details>
    {detail.transfers.filter(transfer => transfer.status === 'started').map(transfer => <p key={transfer.id} className="local-transfer-note">Автопереход → {transfer.toProvider} · контекст сохранён</p>)}
    {detail.runs.length ? <details className="local-run-history"><summary>История запусков · {detail.runs.length}</summary><ol>{detail.runs.map(item => <li key={item.id}><strong>{ROLE_LABELS[item.role]} · {item.provider === 'codex' ? 'Codex' : 'Claude'}</strong><span>{STATUS_LABELS[item.status]}</span><time dateTime={item.startedAt}>{new Date(item.startedAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</time><small>Аккаунт: {profileLabel(accounts, item.profileId, item.provider)}</small><small title={item.checkpointId}>Контекст {item.checkpointId.slice(0, 8)}</small></li>)}</ol></details> : null}
  </div>;
}

function messages(events: TaskEvent[]) {
  const result: { id: string; role: string; text: string; at: string; runId?: string; tool?: boolean; complete?: boolean }[] = [];
  const parts = new Map<string, typeof result[number]>();
  for (const event of events) {
    if (event.type === 'message.created') result.push({ id: event.id, role: 'Вы', text: event.payload.text || '', at: event.createdAt });
    if (event.type === 'run.output') {
      const id = event.payload.runId + ':' + event.payload.itemId;
      let message = parts.get(id);
      if (!message) { message = { id, role: event.payload.provider === 'codex' ? 'Codex' : 'Claude', text: '', at: event.createdAt, runId: event.payload.runId }; parts.set(id, message); result.push(message); }
      message.text = event.payload.replace === 'true' ? event.payload.text || '' : message.text + (event.payload.text || '');
      message.complete = event.payload.replace === 'true';
    }
    if (event.type === 'run.tool') result.push({ id: event.id, role: event.payload.text || 'Инструмент', text: event.payload.details || '', at: event.createdAt, tool: true });
    if (event.type.startsWith('route.')) result.push({ id: event.id, role: 'ADE · маршрут', text: event.payload.text || '', at: event.createdAt });
  }
  return result;
}

export function Conversation({ detail, accounts }: { detail: TaskDetail; accounts: AccountProfiles | null }) {
  const element = useRef<HTMLDivElement>(null), follow = useRef(true);
  useEffect(() => { if (follow.current && element.current) element.current.scrollTop = element.current.scrollHeight; }, [detail.events.length]);
  const streaming = new Set(detail.runs.filter(run => ACTIVE_RUNS.includes(run.status)).map(run => run.id));
  return <div ref={element} className="local-messages" aria-label="Сообщения задачи" onScroll={event => { const target = event.currentTarget; follow.current = target.scrollHeight - target.scrollTop - target.clientHeight < 80; }}>{messages(detail.events).map(message => {
    if (message.tool) return <details key={message.id} className="local-tool-event"><summary>{message.role}</summary><pre>{message.text}</pre></details>;
    const run = detail.runs.find(run => run.id === message.runId);
    return <article key={message.id} className="local-message" data-run-id={message.runId}><div className="local-message-meta"><strong>{message.role}{run && detail.workflow ? ' · ' + ROLE_LABELS[run.role] : ''}</strong>{run ? <span className="message-profile">{profileLabel(accounts, run.profileId, run.provider)}</span> : null}<time dateTime={message.at}>{new Date(message.at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</time>{message.runId && streaming.has(message.runId) && !message.complete ? <span className="local-stream-label">Поток ответа</span> : null}</div>{message.runId ? <Markdown value={assistantText(detail, message.runId, message.text)} /> : <p>{message.text}</p>}</article>;
  })}</div>;
}

function assistantText(detail: TaskDetail, runId: string, text: string): string {
  const reviewer = detail.runs.find(run => run.id === runId)?.role === 'reviewer';
  const result = handoffText(text, reviewer);
  return reviewer ? reviewText(result) : result;
}
