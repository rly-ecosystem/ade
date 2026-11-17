import { useEffect, useRef, useState } from 'react';
import type { Project, Task, TaskDetail } from '../../../packages/contracts/src/index.js';
import { ACTIVE_RUNS } from '../../../packages/contracts/src/index.js';
import { Icon, TaskList } from './ui.js';
import { taskActive } from './workbench.js';

export function TaskActions({ detail, busy, onRename, onArchive }: { detail: TaskDetail; busy: boolean; onRename(title: string): void; onArchive(archived: boolean): void }) {
  const [title, setTitle] = useState(detail.task.title), [open, setOpen] = useState(false);
  const menu = useRef<HTMLDetailsElement>(null), active = taskActive(detail);
  useEffect(() => setTitle(detail.task.title), [detail.task.title]);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node) && menu.current) menu.current.open = false; };
    document.addEventListener('pointerdown', close); return () => document.removeEventListener('pointerdown', close);
  }, [open]);
  function close() { if (menu.current) menu.current.open = false; menu.current?.querySelector('summary')?.focus(); }
  return <details ref={menu} className="task-actions" onToggle={event => setOpen(event.currentTarget.open)} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); close(); } }}>
    <summary role="button" aria-label="Действия с задачей" title="Действия с задачей"><Icon name="more" /></summary>
    <div className="task-action-panel"><label>Название задачи<input aria-label="Название задачи" value={title} onChange={event => setTitle(event.target.value)} maxLength={120} disabled={busy || active || detail.task.archived} onKeyDown={event => { if (event.key === 'Enter' && title.trim()) { event.preventDefault(); onRename(title.trim()); close(); } }} /></label><button className="button" disabled={busy || active || detail.task.archived || !title.trim() || title.trim() === detail.task.title} onClick={() => { onRename(title.trim()); close(); }}>Сохранить название</button><button className="button" disabled={busy || active} onClick={() => { onArchive(!detail.task.archived); close(); }}>{detail.task.archived ? 'Восстановить из архива' : 'В архив'}</button>{active ? <p className="local-muted">Сначала остановите запуск или проверку.</p> : <p className="local-muted">Архив сохраняет сообщения, проверки и результаты.</p>}</div>
  </details>;
}

export function TasksPage({ project, projects, tasks, busy, onRefresh, onProject, onNew, onOpen }: {
  project?: Project; projects: Project[]; tasks: Task[]; busy: boolean;
  onRefresh(): void; onProject(project: Project): void; onNew(): void; onOpen(task: Task): void;
}) {
  const [query, setQuery] = useState(''), [filter, setFilter] = useState('all');
  const visible = tasks.filter(task => {
    if (task.archived !== (filter === 'archive')) return false;
    if (!task.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) return false;
    if (filter === 'active') return task.status === 'checking' || task.status === 'switching' || ACTIVE_RUNS.includes(task.status as typeof ACTIVE_RUNS[number]);
    if (filter === 'attention') return ['awaiting_approval', 'review', 'failed', 'waiting', 'limited', 'interrupted'].includes(task.status);
    if (filter === 'accepted') return task.status === 'accepted';
    return true;
  });
  return <section className="local-page"><div className="local-section-head"><h1>Задачи{project ? ' · ' + project.name : ''}</h1><span className="spacer" />{project ? <button className="button" onClick={onRefresh} disabled={busy}><Icon name="refresh" />Обновить папки</button> : null}<button className="button" onClick={onNew}><Icon name="plus" />Новая задача</button></div>
    {project?.scanError ? <p className="local-error" role="alert">{project.scanError}</p> : null}
    <div className="local-subprojects">{projects.filter(item => item.parentId === project?.id).sort((a, b) => a.name.localeCompare(b.name)).map(item => <button className="recent-task" key={item.id} title={item.path} onClick={() => onProject(item)}><Icon name="folder" /><span>{item.name}</span><small>{item.missing ? 'Папка недоступна' : 'Подпроект'}</small></button>)}</div>
    <div className="task-filters"><label>Найти задачу<input type="search" aria-label="Найти задачу" placeholder="Название задачи…" value={query} onChange={event => setQuery(event.target.value)} /></label><label>Показать<select aria-label="Фильтр задач" value={filter} onChange={event => setFilter(event.target.value)}><option value="all">Все задачи</option><option value="active">В работе</option><option value="attention">Нужно внимание</option><option value="accepted">Принятые</option><option value="archive">Архив</option></select></label><span className="local-muted" role="status">Найдено: {visible.length}</span></div>
    {visible.length ? <TaskList tasks={visible} onOpen={onOpen} /> : <p className="local-muted">{!tasks.length ? 'Задач пока нет. Сохраните первую на главной.' : filter === 'archive' && !query ? 'В архиве пока нет задач.' : 'Ничего не найдено. Измените запрос или фильтр.'}</p>}
  </section>;
}
