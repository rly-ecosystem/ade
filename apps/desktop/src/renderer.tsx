import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ACTIVE_RUNS, STATUS_LABELS, type Bootstrap, type DesktopAPI, type Project, type Task, type TaskDetail, type Result, type GitSnapshot, type Provider, type ProviderStatus, type RoleStep } from '../../../packages/contracts/src/index.js';
import { Aquarium, Composer, GitView, Icon, TaskList } from './ui.js';
import { Conversation, Execution, Providers } from './execution-ui.js';
import { ProjectTree, projectTrail } from './projects.js';
import { WorkflowControls, VerificationControls } from './workbench.js';
import { TaskActions, TasksPage } from './task-tools.js';
import { TaskView } from './task-view.js';
import { mutationId, confirmMutation } from './mutations.js';
import { AccountsPage, ChatGPTWelcome, type ProfileRequest } from './accounts.js';
import type { AccountProfiles } from '../../../packages/contracts/src/accounts.js';
import { InsightsPage } from './insights.js';
import './styles.css';
import './task-view.css';
import './accounts.css';

declare global { interface Window { ade: DesktopAPI } }
type Page = 'home' | 'tasks' | 'task' | 'git' | 'settings' | 'accounts' | 'insights';
const preference = (key: string, fallback: string) => { try { return localStorage.getItem('ade:' + key) || fallback; } catch { return fallback; } };

function unwrap<T>(result: Result<T>): T { if (!result.ok) throw new Error(result.error); return result.value; }

function App() {
  const [data, setData] = useState<Bootstrap | null>(null);
  const [projectId, setProjectId] = useState(() => preference('project', ''));
  const [page, setPage] = useState<Page>('home');
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [draft, setDraft] = useState(() => preference('draft', ''));
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  const [query, setQuery] = useState('');
  const [theme, setTheme] = useState(() => preference('theme', 'dark') === 'light' ? 'light' : 'dark');
  const [sidebar, setSidebar] = useState(false);
  const [compact, setCompact] = useState(() => matchMedia('(max-width:620px)').matches);
  const sidebarElement = useRef<HTMLElement>(null), sidebarToggle = useRef<HTMLButtonElement>(null);
  const [git, setGit] = useState<GitSnapshot | null>(null);
  const [gitLoading, setGitLoading] = useState(false);
  const [gitError, setGitError] = useState('');
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [accounts, setAccounts] = useState<AccountProfiles | null>(null);
  const [providersLoading, setProvidersLoading] = useState(true);
  const providerRefresh = useRef<Promise<void> | null>(null);
  const navigation = useRef(0);
  const selectedTask = useRef<string | null>(null), hasActive = useRef(false);
  selectedTask.current = detail?.task.id || null;
  hasActive.current = !!data?.tasks.some(task => (task.status === 'switching' || task.status === 'checking' || ACTIVE_RUNS.includes(task.status as typeof ACTIVE_RUNS[number])));
  const inFlight = useRef(false);
  const project = data?.projects.find(item => item.id === projectId);
  const projectTasks = data?.tasks.filter(item => !project || item.projectId === project.id) || [];
  const tasks = projectTasks.filter(task => !task.archived);
  const reply = detail ? replyDrafts[detail.task.id] ?? preference('reply:' + detail.task.id, '') : '';
  const modalSidebar = compact && sidebar;

  function setReply(value: string, taskId = selectedTask.current) {
    if (!taskId) return;
    setReplyDrafts(previous => ({ ...previous, [taskId]: value }));
    try {
      if (value) localStorage.setItem('ade:reply:' + taskId, value);
      else localStorage.removeItem('ade:reply:' + taskId);
    } catch { setError('Не удалось сохранить черновик на этом Mac. Текст остаётся в окне; сохраните сообщение перед выходом.'); }
  }

  useEffect(() => {
    const media = matchMedia('(max-width:620px)');
    const adapt = () => { setCompact(media.matches); if (!media.matches) setSidebar(false); };
    media.addEventListener('change', adapt);
    return () => media.removeEventListener('change', adapt);
  }, []);
  useEffect(() => {
    if (!modalSidebar) return;
    sidebarElement.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => { if (sidebarToggle.current?.getClientRects().length) sidebarToggle.current.focus(); };
  }, [modalSidebar]);

  useEffect(() => { document.documentElement.style.colorScheme = theme; localStorage.setItem('ade:theme', theme); }, [theme]);
  useEffect(() => { localStorage.setItem('ade:project', projectId); }, [projectId]);
  useEffect(() => { localStorage.setItem('ade:draft', draft); }, [draft]);
  useEffect(() => {
    const pointer = () => { document.documentElement.dataset.inputModality = 'pointer'; };
    const keyboard = (event: KeyboardEvent) => { if (event.key === 'Tab') document.documentElement.dataset.inputModality = 'keyboard'; if (event.key === 'Escape' && !event.defaultPrevented) setSidebar(false); };
    document.addEventListener('pointerdown', pointer); document.addEventListener('keydown', keyboard);
    return () => { document.removeEventListener('pointerdown', pointer); document.removeEventListener('keydown', keyboard); };
  }, []);

  async function bootstrap() {
    const value = unwrap(await window.ade.call('bootstrap', {}));
    setData(value);
    setProjectId(previous => value.projects.some(item => item.id === previous) ? previous : value.projects[0]?.id || '');
    return value;
  }

  async function load() {
    setLoading(true); setError('');
    try { await bootstrap(); } catch (failure) { setError(String((failure as Error).message)); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);
  async function refreshProviders() {
    if (providerRefresh.current) return providerRefresh.current;
    setProvidersLoading(true);
    const refresh = (async () => {
    try { setProviders(unwrap(await window.ade.call('providers.status', {}))); setAccounts(unwrap(await window.ade.call('profiles.list', {}))); }
    catch (failure) { setError((failure as Error).message); }
    finally { setProvidersLoading(false); providerRefresh.current = null; }
    })();
    providerRefresh.current = refresh; return refresh;
  }
  useEffect(() => { void refreshProviders(); }, []);
  useEffect(() => {
    let alive = true, pending = false, timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      if (pending) return; pending = true;
      try {
        const data = unwrap(await window.ade.call('bootstrap', {})); if (alive) setData(data);
        const accounts = unwrap(await window.ade.call('profiles.list', {})); if (alive) setAccounts(accounts);
        const id = selectedTask.current;
        if (id) {
          const next = unwrap(await window.ade.call('task.get', { taskId: id }));
          if (alive && selectedTask.current === id) setDetail(previous => previous?.task.id === id && (previous.events.at(-1)?.sequence || 0) > (next.events.at(-1)?.sequence || 0) ? previous : next);
        }
      } catch (failure) { if (alive) setError((failure as Error).message); }
      finally { pending = false; }
    };
    const unsubscribe = window.ade.onChange(id => { if (id === 'profiles-auth') void refreshProviders(); if (!timer) timer = setTimeout(() => { timer = undefined; void refresh(); }, 160); });
    const interval = setInterval(() => { if (hasActive.current) void refresh(); }, 2000);
    window.addEventListener('focus', refresh);
    return () => { alive = false; unsubscribe(); clearTimeout(timer); clearInterval(interval); window.removeEventListener('focus', refresh); };
  }, []);

  async function act(operation: () => Promise<void>) {
    if (inFlight.current) return false;
    inFlight.current = true; setBusy(true); setError('');
    try { await operation(); return true; }
    catch (failure) { setError((failure as Error).message); return false; }
    finally { inFlight.current = false; setBusy(false); }
  }

  async function profileAction(request: ProfileRequest): Promise<AccountProfiles | null> {
    let result: AccountProfiles | null = null;
    await act(async () => { result = unwrap(await window.ade.call(request.method, request.params)); setAccounts(result); if (['profile.select', 'profile.enable', 'profile.logout', 'profile.check'].includes(request.method)) await refreshProviders(); });
    return result;
  }
  async function signInProfile(id: string) { await act(async () => { unwrap(await window.ade.signInProfile(id)); setAccounts(unwrap(await window.ade.call('profiles.list', {}))); }); }

  function navigate(next: Page) { navigation.current++; setPage(next); setSidebar(false); setError(''); setGitLoading(false); if (data) setLoading(false); }
  function updateTask(value: TaskDetail) { setDetail(previous => previous?.task.id === value.task.id && (previous.events.at(-1)?.sequence || 0) <= (value.events.at(-1)?.sequence || 0) ? value : previous); }

  async function pickProject() {
    await act(async () => {
      const value: Project | null = unwrap(await window.ade.pickProject());
      if (!value) return;
      await bootstrap(); setProjectId(value.id); setGit(null); navigate('home'); setFeedback('Подключён ' + value.path);
    });
  }

  async function createTask() {
    if (!project || !draft.trim()) return;
    await act(async () => {
      const params = { projectId: project.id, text: draft.trim() };
      const value = unwrap(await window.ade.call('task.create', { ...params, requestId: mutationId(localStorage, 'task.create', params) }));
      confirmMutation(localStorage);
      setProjectId(value.task.projectId); setDetail(value); setDraft(''); navigate('task'); setFeedback('Задача сохранена в локальной базе.');
      await bootstrap();
    });
  }

  async function openTask(task: Task) {
    const version = ++navigation.current;
    setError(''); setLoading(true); setGitLoading(false); setSidebar(false);
    try {
      const value = unwrap(await window.ade.call('task.get', { taskId: task.id }));
      if (version !== navigation.current) return;
      setProjectId(task.projectId); setDetail(value); setPage('task');
    } catch (failure) { if (version === navigation.current) setError((failure as Error).message); }
    finally { if (version === navigation.current) setLoading(false); }
  }

  async function sendReply() {
    if (!detail || !reply.trim()) return;
    await act(async () => {
      const params = { taskId: detail.task.id, text: reply.trim() };
      const value = unwrap(await window.ade.call('task.message', { ...params, requestId: mutationId(localStorage, 'task.message', params) }));
      confirmMutation(localStorage);
      updateTask(value); setReply('', params.taskId);
      setFeedback('Сообщение сохранено.'); await bootstrap();
    });
  }

  async function execute(provider: Provider, model: string, backupModel: string) {
    if (!detail) return;
    await act(async () => {
      unwrap(await window.ade.call('task.route', { taskId: detail.task.id, enabled: detail.task.autoSwitch, codexModel: provider === 'codex' ? model : backupModel, claudeModel: provider === 'claude' ? model : backupModel }));
      const params = { taskId: detail.task.id, provider, model };
      const value = unwrap(await window.ade.call('task.execute', { ...params, requestId: mutationId(localStorage, 'task.execute', params) }));
      confirmMutation(localStorage); updateTask(value); await bootstrap();
    });
  }

  async function trust(trusted: boolean) {
    if (!project) return;
    await act(async () => { unwrap(await window.ade.call('project.trust', { projectId: project.id, trusted })); await bootstrap(); });
  }
  async function stop(runId: string) {
    await act(async () => { updateTask(unwrap(await window.ade.call('run.stop', { runId, requestId: crypto.randomUUID() }))); await bootstrap(); });
  }
  async function respond(runId: string, approvalId: string, decision: 'allow' | 'deny') {
    await act(async () => { updateTask(unwrap(await window.ade.call('run.respond', { runId, approvalId, decision, requestId: crypto.randomUUID() }))); });
  }

  async function loadChildren(item: Project) {
    try { unwrap(await window.ade.call('project.children', { projectId: item.id })); }
    catch (failure) { setError((failure as Error).message); }
    finally { await bootstrap(); }
  }
  async function configureRoute(enabled: boolean, codexModel: string, claudeModel: string) {
    if (!detail) return false;
    let saved = detail.task.autoSwitch;
    await act(async () => { const value = unwrap(await window.ade.call('task.route', { taskId: detail.task.id, enabled, codexModel, claudeModel })); saved = value.task.autoSwitch; setDetail(previous => previous?.task.id === value.task.id && (previous.events.at(-1)?.sequence || 0) <= (value.events.at(-1)?.sequence || 0) ? value : previous); });
    return saved;
  }

  async function saveRoles(steps: RoleStep[], options: { parallel: boolean; economy: boolean }) {
    if (!detail) return;
    await act(async () => { unwrap(await window.ade.call('task.roles', { taskId: detail.task.id, steps })); updateTask(unwrap(await window.ade.call('task.workflow', { taskId: detail.task.id, ...options }))); await bootstrap(); });
  }
  async function startWorkflow(steps: RoleStep[], options: { parallel: boolean; economy: boolean }) {
    if (!detail) return;
    await act(async () => {
      unwrap(await window.ade.call('task.roles', { taskId: detail.task.id, steps }));
      unwrap(await window.ade.call('task.workflow', { taskId: detail.task.id, ...options }));
      const params = { taskId: detail.task.id };
      updateTask(unwrap(await window.ade.call('workflow.start', { ...params, requestId: mutationId(localStorage, 'workflow.start', params) })));
      confirmMutation(localStorage); await bootstrap();
    });
  }
  async function stopWorkflow(groupId: string) { await act(async () => { updateTask(unwrap(await window.ade.call('workflow.stop', { groupId }))); await bootstrap(); }); }
  async function startCheck(command: string) {
    if (!detail) return;
    await act(async () => {
      const params = { taskId: detail.task.id, command };
      updateTask(unwrap(await window.ade.call('check.start', { ...params, requestId: mutationId(localStorage, 'check.start', params) })));
      confirmMutation(localStorage); await bootstrap();
    });
  }
  async function stopCheck(checkId: string) { await act(async () => { updateTask(unwrap(await window.ade.call('check.stop', { checkId }))); await bootstrap(); }); }
  async function verifyTask(quiet = false) {
    if (!detail) return;
    try { updateTask(unwrap(await window.ade.call('task.verify', { taskId: detail.task.id }))); if (!quiet) setError(''); await bootstrap(); }
    catch (failure) {
      try { updateTask(unwrap(await window.ade.call('task.get', { taskId: detail.task.id }))); } catch {}
      setError((failure as Error).message);
    }
  }
  async function reviewTask() {
    if (!detail) return;
    await act(async () => {
      const params = { taskId: detail.task.id };
      updateTask(unwrap(await window.ade.call('task.review', { ...params, requestId: mutationId(localStorage, 'task.review', params) })));
      confirmMutation(localStorage); await bootstrap();
    });
  }
  async function acceptTask(note: string) {
    if (!detail) return;
    await act(async () => { updateTask(unwrap(await window.ade.call('task.accept', { taskId: detail.task.id, note }))); await bootstrap(); });
  }

  async function renameTask(title: string) {
    if (!detail) return;
    await act(async () => { updateTask(unwrap(await window.ade.call('task.rename', { taskId: detail.task.id, title }))); await bootstrap(); });
  }
  async function archiveTask(archived: boolean) {
    if (!detail) return;
    await act(async () => { updateTask(unwrap(await window.ade.call('task.archive', { taskId: detail.task.id, archived }))); await bootstrap(); if (archived) navigate('tasks'); });
  }

  async function inspect() {
    if (!project) return;
    const version = ++navigation.current;
    setPage('git'); setLoading(false); setGit(null); setGitError(''); setGitLoading(true); setSidebar(false);
    try { const value = unwrap(await window.ade.call('git.inspect', { projectId: project.id })); if (version === navigation.current) setGit(value); }
    catch (failure) { if (version === navigation.current) setGitError((failure as Error).message); }
    finally { if (version === navigation.current) setGitLoading(false); }
  }

  return <article className={'app local-app ' + (sidebar ? 'local-sidebar-open ' : '') + (theme === 'light' ? 'light-appearance' : '')} style={{ colorScheme: theme }} aria-label="RLY ADE">
    {modalSidebar ? <button className="local-sidebar-backdrop" aria-label="Закрыть панель проектов" tabIndex={-1} onClick={() => setSidebar(false)} /> : null}
    <aside ref={sidebarElement} className="side" role={modalSidebar ? 'dialog' : undefined} aria-modal={modalSidebar || undefined} aria-label="Навигация" onKeyDown={event => {
      if (!modalSidebar || event.defaultPrevented) return;
      if (event.key === 'Escape') { event.preventDefault(); setSidebar(false); }
      if (event.key === 'Tab') {
        const controls = [...(sidebarElement.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),a[href]') || [])].filter(element => element.getClientRects().length);
        const first = controls[0], last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }}>
      <div className="side-head"><button className="brand-button" onClick={() => navigate('home')} aria-label="RLY ADE, главная"><span className="brand-crop"><img src="assets/rly-logo.png" alt="RLY" width="160" height="160" /></span><span className="brand-ade">| ADE</span></button><button className="icon-btn local-sidebar-close" aria-label="Скрыть проекты" onClick={() => setSidebar(false)}><Icon name="close" /></button></div>
      <nav className="primary-nav" aria-label="Разделы">
        <button className="nav-btn" aria-current={page === 'home' ? 'page' : undefined} onClick={() => navigate('home')}><Icon name="plus" />Новая задача</button>
        <button className="nav-btn" aria-current={page === 'tasks' || page === 'task' ? 'page' : undefined} onClick={() => navigate('tasks')}><Icon name="tasks" />Задачи</button>
        <button className="nav-btn" aria-current={page === 'accounts' ? 'page' : undefined} onClick={() => navigate('accounts')}><Icon name="profiles" />Профили AI</button>
        <button className="nav-btn" aria-current={page === 'git' ? 'page' : undefined} disabled={!project || gitLoading} onClick={() => void inspect()}><Icon name="git" />Изменения Git</button>
        <button className="nav-btn" aria-current={page === 'insights' ? 'page' : undefined} onClick={() => navigate('insights')}><Icon name="chart" />Статистика</button>
      </nav>
      <div className="group-title"><span>Projects</span><button className="icon-btn" aria-label="Подключить папку проекта" onClick={() => void pickProject()} disabled={busy}><Icon name="plus" /></button></div>
      <label className="search"><span className="local-search-label">Найти</span><input type="search" placeholder="Название или путь…" aria-label="Найти проект" value={query} onChange={event => setQuery(event.target.value)} /></label>
      <ProjectTree projects={data?.projects || []} tasks={data?.tasks.filter(task => !task.archived) || []} selected={projectId} query={query} onLoad={loadChildren} onSelect={item => { setProjectId(item.id); setGit(null); navigate('tasks'); }} />
      <div className="side-space" /><div className="side-foot"><button className="nav-btn" aria-current={page === 'settings' ? 'page' : undefined} onClick={() => navigate('settings')}><Icon name="settings" />Настройки</button></div>
    </aside>
    <div className={'content ' + (page === 'home' ? 'home-mode' : '')} inert={modalSidebar}>
      <header className="toolbar"><button ref={sidebarToggle} className="icon-btn local-mobile-toggle" onClick={() => setSidebar(value => !value)} aria-label="Показать проекты" aria-haspopup="dialog" aria-expanded={modalSidebar}><Icon name="menu" /></button><nav className="breadcrumbs" aria-label={page === 'insights' ? 'Текущий раздел' : 'Текущий проект'}><button onClick={() => navigate('home')}>RLY</button><span>/</span>{page === 'insights' ? <span>Статистика</span> : project ? projectTrail(project, data?.projects || []).map(item => <button key={item.id} title={item.path} onClick={() => { setProjectId(item.id); navigate('tasks'); }}>{item.name}</button>) : <span>ADE</span>}</nav><span className="spacer" /><span className="local-build">Локальный preview</span></header>
      {error ? <div role="alert" className="local-error local-error-bar">{error}<button className="small-action" onClick={() => void load()}>Обновить данные</button></div> : null}
      <main className={'main local-main local-page-' + page} aria-busy={loading || busy}>
        {loading ? <p className="local-empty" role="status">Открываю сохранённые данные…</p> : !data ? <div className="local-empty"><h1>Локальное ядро недоступно</h1><p>Проверьте ошибку выше и обновите данные.</p></div> : page === 'home' ? <section className="home" aria-label="Новая задача">
          <h1>Что будем делать?</h1>
          <Composer label="Сохранить задачу" fieldLabel="Задача" placeholder="Опишите задачу и критерии готовности…" value={draft} onChange={setDraft} onSubmit={() => void createTask()} busy={busy || !project}>
            {project ? <label className="home-project">Проект<select aria-label="Проект для задачи" value={projectId} onChange={event => setProjectId(event.target.value)} disabled={busy}>{data.projects.filter(item => !item.missing).sort((a, b) => a.path.localeCompare(b.path)).map(item => <option key={item.id} value={item.id}>{projectTrail(item, data.projects).map(parent => parent.name).join(' / ')}</option>)}</select></label> : <button type="button" className="button" onClick={() => void pickProject()} disabled={busy}><Icon name="plus" />Подключить проект</button>}
            <span className="draft-label">⌘ Enter</span>
          </Composer>
          <p className="local-home-note">{project ? project.path : 'Выберите папку проекта. Git необязателен.'}</p>
          {tasks.length ? <div className="home-recent"><h2>Недавние задачи</h2><TaskList tasks={tasks.slice(0, 4)} onOpen={task => void openTask(task)} /></div> : null}
        </section> : page === 'tasks' ? <TasksPage key={projectId} project={project} projects={data.projects} tasks={projectTasks} busy={busy} onRefresh={() => project && void loadChildren(project)} onProject={item => { setProjectId(item.id); navigate('tasks'); }} onNew={() => navigate('home')} onOpen={task => void openTask(task)} />
          : page === 'task' && detail ? <TaskView key={detail.task.id} detail={detail} actions={<><TaskActions detail={detail} busy={busy} onRename={title => void renameTask(title)} onArchive={archived => void archiveTask(archived)} /><button className="button task-git-button" aria-label="Изменения Git" onClick={() => void inspect()} disabled={gitLoading}><Icon name="git" /><span>Изменения Git</span></button></>} inspector={project ? <Execution detail={detail} project={project} providers={providers} accounts={accounts} busy={busy} onRoute={configureRoute} onTrust={value => void trust(value)} onStart={(provider, model, backupModel) => void execute(provider, model, backupModel)} onStop={id => void stop(id)} onRespond={(run, id, decision) => void respond(run, id, decision)}>
              <div className="workbench-tools">
                <WorkflowControls detail={detail} project={project} providers={providers} accounts={accounts} busy={busy} onSave={(steps, options) => void saveRoles(steps, options)} onStart={(steps, options) => void startWorkflow(steps, options)} onStop={id => void stopWorkflow(id)} />
                <VerificationControls detail={detail} project={project} busy={busy} onStart={command => void startCheck(command)} onStop={id => void stopCheck(id)} onReview={() => void reviewTask()} onVerify={verifyTask} onAccept={note => void acceptTask(note)} />
              </div>
            </Execution> : null}>
            <Conversation detail={detail} accounts={accounts} />
            <div className="local-task-bottom"><Composer label="Сохранить сообщение" fieldLabel="Сообщение" placeholder="Добавьте требования или уточнение…" value={reply} onChange={setReply} onSubmit={() => void sendReply()} busy={busy || detail.task.archived}><span className="draft-label">Добавится в контекст следующего запуска</span></Composer></div>
          </TaskView> : page === 'git' ? <GitView snapshot={git?.projectId === projectId ? git : null} loading={gitLoading} error={gitError} onRefresh={() => void inspect()} />
          : page === 'insights' ? <InsightsPage projects={data.projects} accounts={accounts} onNew={id => { if (id) setProjectId(id); navigate('home'); }} />
          : page === 'accounts' ? <AccountsPage data={accounts} busy={busy} refreshing={providersLoading} onRefresh={() => void refreshProviders()} onAction={profileAction} onSignIn={id => void signInProfile(id)} />
          : page === 'settings' ? <section className="local-page local-settings"><h1>Настройки</h1><label className="local-setting">Тема<select aria-label="Тема" value={theme} onChange={event => setTheme(event.target.value)}><option value="dark">Тёмная</option><option value="light">Светлая</option></select></label><div className="local-setting"><span>Хранение задач</span><span>SQLite · на этом Mac</span></div><div className="local-setting"><span>Ядро</span><span>Отдельный локальный процесс</span></div><Providers values={providers} loading={providersLoading} onRefresh={() => void refreshProviders()} /></section> : null}
      </main>
      {page === 'home' && data && !loading ? <Aquarium theme={theme} /> : null}
      <footer className="local-status" aria-live="polite">{busy ? 'Выполняю действие…' : page === 'task' && detail ? STATUS_LABELS[detail.task.status] : feedback || 'Локальное ядро · официальные CLI'}</footer>
    </div>
    <ChatGPTWelcome profileId={accounts?.welcomeProfileId || null} busy={busy} onDismiss={id => void profileAction({ method: 'profile.welcome', params: { profileId: id } })} />
  </article>;
}

createRoot(document.getElementById('rly-tree')!).render(<App />);
