import { useEffect, useRef, useState } from 'react';
import { ACTIVE_RUNS, ROLES, ROLE_LABELS, STATUS_LABELS, hasPassingChecks, type Project, type Provider, type ProviderStatus, type RoleStep, type TaskDetail, type Verification } from '../../../packages/contracts/src/index.js';
import { Icon } from './ui.js';
import { ECONOMY } from '../../../packages/contracts/src/handoff.js';
import type { AccountProfiles } from '../../../packages/contracts/src/accounts.js';
import { profileLabel } from './profile-label.js';

const workflowLabels = { pending: 'Подготавливается', running: 'Выполняется', waiting: 'Приостановлена', stopped: 'Остановлена', interrupted: 'Прервана', ready: 'Готова к приёмке' };
const checkLabels: Record<Verification['status'], string> = { running: 'Выполняется', stopping: 'Останавливается', passed: 'Пройдена', failed: 'Не пройдена', stopped: 'Остановлена', interrupted: 'Прервана' };
export function taskActive(detail: TaskDetail) { return !!detail.group && ['active', 'switching'].includes(detail.group.status) || detail.runs.some(run => ACTIVE_RUNS.includes(run.status)) || detail.checks.some(check => ['running', 'stopping'].includes(check.status)); }

export function WorkflowControls({ detail, project, providers, accounts, busy, onSave, onStart, onStop }: {
  detail: TaskDetail; project: Project; providers: ProviderStatus[]; accounts: AccountProfiles | null; busy: boolean;
  onSave(steps: RoleStep[], options: { parallel: boolean; economy: boolean }): void; onStart(steps: RoleStep[], options: { parallel: boolean; economy: boolean }): void; onStop(groupId: string): void;
}) {
  const [steps, setSteps] = useState<RoleStep[]>(() => detail.task.rolePlan || ROLES.map(role => ({ role, provider: role === 'researcher' || role === 'reviewer' ? 'claude' : 'codex', model: role === 'researcher' || role === 'reviewer' ? 'haiku' : '' })));
  const [parallel, setParallel] = useState(() => detail.task.rolePlan ? detail.task.parallel : true), [economy, setEconomy] = useState(() => detail.task.rolePlan ? detail.task.economy : true);
  const workflow = detail.workflow, active = taskActive(detail) || detail.task.archived, running = workflow && ['pending', 'running'].includes(workflow.status);
  const participants = detail.runs.filter(run => run.groupId === workflow?.groupId && ACTIVE_RUNS.includes(run.status));
  const stopping = !!workflow && participants.length > 0;
  const unavailable = steps.some(step => { const profile = accounts?.profiles.find(profile => profile.id === (step.profileId || accounts.selected[step.provider])); return profile ? !profile.enabled || profile.pending || profile.state !== 'connected' : !providers.some(status => status.provider === step.provider && status.authenticated); });
  const dirty = JSON.stringify(steps) !== JSON.stringify(detail.task.rolePlan) || parallel !== detail.task.parallel || economy !== detail.task.economy;
  return <section className="local-workflow" aria-label="Цепочка ролей">
    <div className="workbench-heading"><h2>Команда</h2>{running || stopping ? <button className="button" onClick={() => onStop(workflow!.groupId)} disabled={busy}>Остановить цепочку</button> : <button className={'button' + (!workflow || workflow.status !== 'ready' ? ' button-primary' : '')} onClick={() => { const normalized = steps.map(step => ({ ...step, model: step.model.trim() })); setSteps(normalized); onStart(normalized, { parallel, economy }); }} disabled={busy || active || !project.trusted || project.missing || unavailable}>{workflow ? 'Повторить цепочку' : 'Запустить цепочку'}</button>}</div>
    {participants.length > 1 ? <p className="parallel-live" role="status">Параллельно · {participants.length} участника</p> : null}
    <ol className="role-progress">{(workflow?.steps || steps).map((step, index) => {
      const run = detail.runs.filter(run => run.groupId === workflow?.groupId && run.role === step.role && (index < 2 || run.iteration === workflow?.iteration)).at(-1);
      const label = run ? STATUS_LABELS[run.status] : workflow && index < workflow.stepIndex ? 'Шаг завершён' : workflow && index === workflow.stepIndex && workflow.status === 'pending' ? 'Подготавливается' : 'Ожидает';
      const current = !!running && (!!run && ACTIVE_RUNS.includes(run.status) || !run && (workflow!.parallel && index < 2 && workflow!.stepIndex < 2 || index === workflow!.stepIndex)), done = run?.status === 'completed';
      const accountId = run?.profileId || step.profileId || (detail.group?.id === workflow?.groupId ? detail.group?.profiles?.[step.provider] : undefined) || accounts?.selected[step.provider];
      return <li key={step.role} data-current={current} data-state={done ? 'done' : current ? 'current' : 'pending'}><span className="role-mark" aria-hidden="true">{done ? <Icon name="check" /> : index + 1}</span><div><strong>{ROLE_LABELS[step.role]}</strong><span>{(run?.provider || step.provider) === 'codex' ? 'Codex' : 'Claude'}{(run?.model || step.model) ? ' · ' + (run?.model || step.model) : ''}</span><span className="role-profile">{profileLabel(accounts, accountId, run?.provider || step.provider)}</span><small className="role-state">{done ? 'Готово' : label}</small></div></li>;
    })}</ol>
    {workflow ? <p className="local-muted workflow-state" role="status">{detail.task.status === 'accepted' ? 'Результат принят' : workflowLabels[workflow.status]}{workflow.iteration ? ' · исправление 1 из 1' : ''}{workflow.status === 'ready' && detail.task.status !== 'accepted' ? '. Проверьте и примите результат ниже.' : ''}</p> : null}
    <p className="local-muted role-handoff-note">{(workflow?.parallel ?? parallel) ? 'Планирование и исследование идут одновременно, затем разработка и ревью.' : 'Роли идут по очереди и передают общий контекст.'} Файлы меняет разработчик.</p>
    {unavailable ? <p className="local-muted">{providers.length ? 'Проверьте подключения выбранных исполнителей или измените назначения.' : 'Проверяю подключения исполнителей…'}</p> : null}
    <details className="role-assignments"><summary>Назначения ролей{dirty ? ' · не сохранены' : ''}</summary>
      <div className="workflow-options"><label><input type="checkbox" checked={parallel} disabled={busy || active} onChange={event => setParallel(event.target.checked)} />Параллельная подготовка</label><label><input type="checkbox" checked={economy} disabled={busy || active} onChange={event => setEconomy(event.target.checked)} />Экономить контекст</label><p className="local-muted">Короткие передачи вместо повторения всего чата. Обычный проход: 4 запуска, максимум 6 с резервами и исправлением. Старые ответы без сводки передаются полностью.</p></div>
      {steps.map((step, index) => <div className="role-assignment" key={step.role}><span>{ROLE_LABELS[step.role]}<small>{step.role === 'developer' ? 'Запись в проект' : 'Только чтение'}</small></span><label>Исполнитель<select aria-label={'Исполнитель: ' + ROLE_LABELS[step.role]} value={step.provider} disabled={busy || active} onChange={event => setSteps(previous => previous.map((value, i) => i === index ? { role: value.role, provider: event.target.value as Provider, model: '' } : value))}><option value="codex">Codex</option><option value="claude">Claude</option></select></label><label>Модель<input aria-label={'Модель: ' + ROLE_LABELS[step.role]} value={step.model} maxLength={100} placeholder="По умолчанию CLI" disabled={busy || active} onChange={event => setSteps(previous => previous.map((value, i) => i === index ? { ...value, model: event.target.value } : value))} /></label><label className="role-account">Аккаунт<select aria-label={'Аккаунт: ' + ROLE_LABELS[step.role]} value={step.profileId || ''} disabled={busy || active} onChange={event => setSteps(previous => previous.map((value, i) => { if (i !== index) return value; const { profileId, ...defaults } = value; return event.target.value ? { ...value, profileId: event.target.value } : defaults; }))}><option value="">Выбранный в «Профили AI»</option>{accounts?.profiles.filter(profile => profile.provider === step.provider).map(profile => <option key={profile.id} value={profile.id}>{profile.name}{!profile.enabled ? ' · отключён' : profile.state !== 'connected' ? ' · нужен вход' : ''}</option>)}</select></label></div>)}
      <button className="button" disabled={busy || active || !dirty} onClick={() => { const normalized = steps.map(step => ({ ...step, model: step.model.trim() })); setSteps(normalized); onSave(normalized, { parallel, economy }); }}>Сохранить назначения</button>
      <p className="local-muted">До 15 минут на запуск, до 2 часов на цепочку. После замечаний ревью доступен один автоматический проход исправлений. Дальше цепочка ждёт решения пользователя.</p>
    </details>
    <WorkflowExchange detail={detail} />
  </section>;
}

function WorkflowExchange({ detail }: { detail: TaskDetail }) {
  const workflow = detail.workflow;
  if (!workflow) return null;
  const runs = detail.runs.filter(run => run.groupId === workflow.groupId), known = runs.filter(run => run.usage);
  const totals = known.reduce((value, run) => ({ input: value.input + run.usage!.input, output: value.output + run.usage!.output, cache: value.cache + run.usage!.cachedInput }), { input: 0, output: 0, cache: 0 });
  const format = (value: number) => value.toLocaleString('ru-RU');
  return <div className="workflow-exchange">
    <section aria-label="Передачи результатов"><h3>Передачи</h3>{runs.filter(run => run.summary).map(run => {
      const deliveries = detail.handoffs.filter(item => item.fromRunId === run.id), received = deliveries.filter(item => item.recipients.length).length;
      return <details className="handoff-record" key={run.id}><summary><strong>{run.provider === 'codex' ? 'Codex' : 'Claude'} · {ROLE_LABELS[run.role]}</strong><span>{deliveries.length ? `Получено ${received} из ${deliveries.length}` : 'Итог сохранён'}</span></summary><p>{run.summary!.summary}</p>{deliveries.length ? <ul>{deliveries.map(item => { const recipient = detail.runs.find(run => run.id === item.recipients.at(-1)), planned = workflow.steps.find(step => step.role === item.toRole); return <li key={item.id}>{ROLE_LABELS[item.toRole]} · {(recipient?.provider || planned?.provider) === 'codex' ? 'Codex' : 'Claude'} · {item.recipients.length ? 'получено' : 'ожидает'}</li>; })}</ul> : null}{run.summary!.files.length ? <p><code>{run.summary!.files.join(', ')}</code></p> : null}<p>{run.summary!.next}</p>{run.summary!.blockers.map(item => <p key={item}>{item}</p>)}</details>;
    })}{!runs.some(run => run.summary) ? <p className="local-muted">После завершения участника здесь появится его короткая передача.</p> : null}</section>
    <section className="workflow-budget" aria-label="Расход цепочки"><h3>Расход цепочки</h3><p>Запуски: {runs.length}{workflow.economy ? ` из ${ECONOMY.runs}` : ''} · контекст ADE: {(runs.reduce((sum, run) => sum + run.promptBytes, 0) / 1024).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} КиБ</p>{known.length ? <p>Вход: {format(totals.input)} · выход: {format(totals.output)} · из кеша: {format(totals.cache)}</p> : <p>CLI пока не передал расход токенов.</p>}{known.length > 0 && known.length < runs.length ? <p className="local-muted">CLI сообщил расход для {known.length} из {runs.length} запусков.</p> : null}<p className="local-muted">Контекст CLI и вызовы инструментов также расходуют токены. Число токенов не ограничивается размером сводки.</p></section>
  </div>;
}

export function VerificationControls({ detail, project, busy, onStart, onStop, onVerify, onAccept, onReview }: {
  detail: TaskDetail; project: Project; busy: boolean;
  onStart(command: string): void; onStop(id: string): void; onVerify(quiet?: boolean): Promise<void>; onAccept(note: string): void;
  onReview(): void;
}) {
  const [command, setCommand] = useState(() => localStorage.getItem('ade:check:' + detail.task.id) || '');
  const [note, setNote] = useState('');
  const [expanded, setExpanded] = useState(() => ['review', 'accepted', 'checking'].includes(detail.task.status));
  useEffect(() => { if (['review', 'accepted', 'checking'].includes(detail.task.status)) setExpanded(true); }, [detail.task.status]);
  const executing = taskActive(detail), active = executing || detail.task.archived, run = detail.runs.at(-1), hasEvidence = !!detail.checks.length || !!detail.acceptance;
  const refresh = useRef(onVerify); refresh.current = onVerify;
  useEffect(() => { localStorage.setItem('ade:check:' + detail.task.id, command); }, [detail.task.id, command]);
  useEffect(() => {
    if (!hasEvidence || executing) return;
    let pending = false;
    const verify = async () => { if (pending) return; pending = true; try { await refresh.current(true); } finally { pending = false; } };
    void verify(); const interval = setInterval(() => void verify(), 3000);
    const focus = () => void verify(); window.addEventListener('focus', focus);
    return () => { clearInterval(interval); window.removeEventListener('focus', focus); };
  }, [detail.task.id, hasEvidence, executing]);
  const accepted = detail.acceptance && !detail.acceptance.stale && detail.task.status === 'accepted';
  const passed = hasPassingChecks(detail);
  const workflowBlocked = !!detail.workflow && detail.workflow.groupId === run?.groupId && detail.workflow.status !== 'ready';
  return <details className="local-verification" open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}><summary>Проверки и приёмка{accepted ? ' · результат принят' : detail.checks.length ? ' · ' + detail.checks.length : ''}</summary>
    <p className="local-muted">Запустите команду в проекте и проверьте результат. До 5 минут, лог до 256 КиБ.</p>
    <label className="verification-command">Команда проверки<textarea aria-label="Команда проверки" value={command} onChange={event => setCommand(event.target.value)} maxLength={4000} placeholder="Например: npm test" disabled={busy || active} /></label>
    <div className="workbench-actions"><button className="button" disabled={busy || active || !command.trim() || !project.trusted || project.missing} onClick={() => onStart(command.trim())}>Запустить проверку</button><button className="button" disabled={busy || active || !hasEvidence} onClick={() => void onVerify()}>Сверить с файлами</button></div>
    <div className="verification-history">{detail.checks.map(check => <details key={check.id} className="verification-record"><summary><strong>{check.stale ? 'Устарела' : checkLabels[check.status]}</strong><code>{check.command}</code></summary><p className="local-muted">{checkLabels[check.status]}{check.exitCode !== null ? ' · код ' + check.exitCode : ''} · {new Date(check.startedAt).toLocaleTimeString('ru-RU')}<span title={check.workspaceDigest}> · версия {check.workspaceDigest.slice(0, 8)}</span></p>{check.error ? <p className="local-run-error">{check.error}</p> : null}<pre>{check.output || 'Вывода пока нет.'}</pre>{['running', 'stopping'].includes(check.status) ? <button className="button" disabled={busy} onClick={() => onStop(check.id)}>{check.status === 'stopping' ? 'Повторить остановку проверки' : 'Остановить проверку'}</button> : null}</details>)}</div>
    <div className="acceptance-controls"><h3>Приёмка результата</h3>{detail.acceptance ? <p className="local-muted" role="status">{detail.acceptance.stale ? 'Файлы или требования изменились. Прежняя приёмка неактуальна.' : 'Принято ' + (detail.acceptance.mode === 'checked' ? 'с проверкой' : 'вручную') + ' · ' + new Date(detail.acceptance.createdAt).toLocaleString('ru-RU')}{detail.acceptance.note ? ' · ' + detail.acceptance.note : ''}</p> : null}
      {workflowBlocked ? <p className="local-muted">Цепочка не завершена. Разберите замечания и повторите ревью текущих файлов.</p> : null}
      <button className="button" disabled={busy || active || !project.trusted || project.missing} onClick={onReview}>Ревью текущих файлов</button>
      {!passed ? <label className="verification-command">Причина ручной приёмки<input aria-label="Причина ручной приёмки" value={note} maxLength={2000} onChange={event => setNote(event.target.value)} disabled={busy || active || !!accepted} placeholder="Если командная проверка не требуется" /></label> : <p className="local-muted">Есть успешная проверка для последнего запуска. При приёмке ADE ещё раз сверит файлы и требования.</p>}
      <button className="button button-primary" disabled={busy || active || !!accepted || workflowBlocked || run?.status !== 'completed' || !passed && !note.trim()} onClick={() => onAccept(note)}>{accepted ? <Icon name="check" /> : null}Принять результат</button>
    </div>
  </details>;
}
