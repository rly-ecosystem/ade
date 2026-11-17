import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Task, GitSnapshot } from '../../../packages/contracts/src/index.js';
import { STATUS_LABELS } from '../../../packages/contracts/src/index.js';

export function Icon({ name }: { name: 'plus' | 'home' | 'tasks' | 'git' | 'settings' | 'send' | 'menu' | 'refresh' | 'folder' | 'chevron' | 'more' | 'panel' | 'close' | 'check' | 'profiles' | 'chart' }) {
  const paths = {
    plus: 'M12 5v14M5 12h14', home: 'm3 10 9-7 9 7v10H3V10Zm6 10v-7h6v7',
    tasks: 'M9 5h11v16H4V5h2m3-2h6v4H9V3Zm-2 9h10M7 16h10',
    git: 'M6 6v12m0-8c0 2 12 0 12 5v3M4 4h4v4H4V4Zm0 14h4v4H4v-4Zm12 0h4v4h-4v-4Z',
    settings: 'M4 7h16M4 17h16M9 4v6m6 4v6', send: 'm5 12 7-7 7 7m-7-7v14',
    menu: 'M4 5h16v14H4V5Zm5 0v14', refresh: 'M20 7v5h-5M4 17v-5h5m10-3a7 7 0 0 0-12-3L4 9m16 6-3 3A7 7 0 0 1 5 15',
    more: 'M5 12h.01M12 12h.01M19 12h.01',
    chart: 'M4 4v16h16M8 16v-4m5 4V6m5 10V9',
    profiles: 'M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM4 21v-2a8 8 0 0 1 16 0v2',
    panel: 'M4 5h16v14H4V5Zm11 0v14', close: 'm6 6 12 12M18 6 6 18', check: 'm5 12 4 4L19 6',
    folder: 'M3 7V5h6l2 2h10v13H3V7Z', chevron: 'm9 5 7 7-7 7',
  };
  return <svg className="lucide" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}

export function TaskList({ tasks, onOpen }: { tasks: Task[]; onOpen: (task: Task) => void }) {
  return <div className="local-task-list">{tasks.length ? tasks.map(task => <button key={task.id} className="recent-task" onClick={() => onOpen(task)}>
    <Icon name="tasks" /><span>{task.title}</span><small>{STATUS_LABELS[task.status]}</small>
  </button>) : <p className="local-muted">Задач пока нет. Сохраните первую на главной.</p>}</div>;
}

export function Composer({ label, fieldLabel, placeholder, value, onChange, onSubmit, busy, children }: {
  label: string; fieldLabel: string; placeholder: string; value: string; onChange: (value: string) => void;
  onSubmit: () => void; busy: boolean; children?: React.ReactNode;
}) {
  function submit(event: FormEvent) { event.preventDefault(); if (value.trim() && !busy) onSubmit(); }
  return <form className="home-composer" onSubmit={submit}>
    <label className="local-field-label" htmlFor="local-composer">{fieldLabel}</label>
    <textarea id="local-composer" value={value} onChange={event => onChange(event.target.value)} placeholder={placeholder} maxLength={32000} disabled={busy}
      onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); if (value.trim() && !busy) onSubmit(); } }} />
    <div className="home-controls">{children}<span className="spacer" /><button className="home-send" type="submit" aria-label={label} title={label} disabled={busy || !value.trim()}><Icon name="send" /></button></div>
  </form>;
}

export function GitView({ snapshot, loading, error, onRefresh }: { snapshot: GitSnapshot | null; loading: boolean; error: string; onRefresh: () => void }) {
  return <section className="local-git" aria-label="Изменения Git" aria-busy={loading}>
    <div className="local-section-head"><h2>Изменения Git</h2><button className="button" onClick={onRefresh} disabled={loading}><Icon name="refresh" />{loading ? 'Читаю Git…' : 'Обновить изменения'}</button></div>
    {error ? <p role="alert" className="local-error">{error}</p> : null}
    {snapshot ? <>
      <p className="local-muted">{snapshot.kind === 'directory' ? 'Папка без Git' : snapshot.branch + ' · ' + (snapshot.head?.slice(0, 8) || 'Первый коммит ещё не создан')} · снимок {new Date(snapshot.capturedAt).toLocaleTimeString('ru-RU')}</p>
      <p className="local-muted">{snapshot.kind === 'directory' ? 'Файлы рабочего набора. Контекст сверяется по SHA-256; diff доступен в Git-проектах.' : 'Только чтение. Новые файлы перечислены отдельно и не входят в diff Git.'}</p>
      {!snapshot.files.length ? <p className="local-empty">Рабочий каталог чист. После изменений здесь появятся файлы и diff.</p> : <ul className="local-files">{snapshot.files.map(file => <li key={file.path}><code>{file.status}</code><span>{file.previousPath ? file.previousPath + ' → ' : ''}{file.path}</span></li>)}</ul>}
      {snapshot.staged ? <><h3>В индексе</h3><pre className="local-diff"><code>{snapshot.staged}</code></pre></> : null}
      {snapshot.unstaged ? <><h3>В рабочем каталоге</h3><pre className="local-diff"><code>{snapshot.unstaged}</code></pre></> : null}
      {snapshot.kind === 'git' && snapshot.files.length > 0 && !snapshot.staged && !snapshot.unstaged ? <p className="local-muted">Текстовых изменений отслеживаемых файлов нет.</p> : null}
    </> : !loading && !error ? <p className="local-muted">Обновите изменения, чтобы прочитать состояние репозитория.</p> : null}
  </section>;
}

interface KoiScene {
  setAppearance(value: { theme: string; accent: string }): void;
  setActive(active: boolean): void;
  setPaused(paused: boolean): void;
  resize(): void;
  feed(x: number, y: number): void;
  destroy(): void;
}

declare global {
  interface Window { RLYKoi?: { create(options: { canvas: HTMLCanvasElement; reducedMotion: MediaQueryList }): KoiScene } }
}

export function Aquarium({ theme }: { theme: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const scene = useRef<KoiScene | null>(null);
  const [enabled, setEnabled] = useState(() => localStorage.getItem('ade:koi') !== 'off');
  const [paused, setPaused] = useState(false);
  const [reduced, setReduced] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    if (!canvas.current || !window.RLYKoi) return;
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    const koi = window.RLYKoi.create({ canvas: canvas.current, reducedMotion: motion });
    scene.current = koi;
    const observer = new ResizeObserver(() => koi.resize());
    observer.observe(canvas.current);
    const visibility = () => koi.setActive(!document.hidden);
    const change = () => setReduced(motion.matches);
    document.addEventListener('visibilitychange', visibility);
    motion.addEventListener('change', change);
    visibility(); koi.resize();
    return () => { observer.disconnect(); koi.destroy(); scene.current = null; document.removeEventListener('visibilitychange', visibility); motion.removeEventListener('change', change); };
  }, []);
  useEffect(() => { scene.current?.setAppearance({ theme, accent: 'ice' }); }, [theme]);
  useEffect(() => { scene.current?.setPaused(paused || reduced || !enabled); localStorage.setItem('ade:koi', enabled ? 'on' : 'off'); }, [paused, reduced, enabled]);
  return <div className="aquarium-wrap" aria-label="ASCII аквариум">
    <button className="aquarium" aria-label="Покормить ASCII-рыбок" hidden={!enabled} onClick={event => {
      if (paused || reduced) return;
      const rect = event.currentTarget.getBoundingClientRect();
      scene.current?.feed(event.detail ? event.clientX - rect.left : rect.width / 2, event.detail ? event.clientY - rect.top : rect.height / 2);
    }}><canvas ref={canvas} className="koi-canvas" aria-hidden="true" /></button>
    <div className="aquarium-controls"><label><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />Кои</label><button className="small-action" disabled={!enabled || reduced} aria-pressed={paused || reduced} onClick={() => setPaused(value => !value)}>{reduced ? 'Без движения' : paused ? 'Пустить' : 'Пауза'}</button></div>
  </div>;
}
