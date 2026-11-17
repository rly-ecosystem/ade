import { useEffect, useRef, useState, type ReactNode } from 'react';
import { STATUS_LABELS, type TaskDetail } from '../../../packages/contracts/src/index.js';
import { Icon } from './ui.js';

export function TaskView({ detail, actions, inspector, children }: { detail: TaskDetail; actions: ReactNode; inspector: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(() => matchMedia('(min-width:1100px)').matches);
  const toggle = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const media = matchMedia('(min-width:1100px)');
    const adapt = () => { if (!media.matches) { if (document.getElementById('ade-task-inspector')?.contains(document.activeElement)) toggle.current?.focus(); setOpen(false); } };
    media.addEventListener('change', adapt);
    return () => media.removeEventListener('change', adapt);
  }, []);
  function close() { setOpen(false); toggle.current?.focus(); }
  const phase = (detail.task.archived ? 'В архиве · ' : '') + STATUS_LABELS[detail.task.status];
  return <section className="local-task" aria-label="Задача" onKeyDown={event => { if (event.key === 'Escape' && open && !event.defaultPrevented) { event.preventDefault(); close(); } }}>
    <div className="local-task-head">
      <div className="task-heading"><h1 title={detail.task.title}>{detail.task.title}</h1><p key={phase} className="local-muted local-task-phase">{phase}</p></div>
      <div className="task-head-actions">{actions}<button ref={toggle} className="button task-inspector-toggle" aria-label="Ход задачи" aria-controls="ade-task-inspector" aria-expanded={open} onClick={() => setOpen(value => !value)}><Icon name="panel" /><span>Ход задачи</span>{detail.approvals.length ? <span className="task-attention-count">{detail.approvals.length}</span> : null}</button></div>
    </div>
    <div className="task-layout" data-inspector-open={open}>
      <div className="task-chat">{children}</div>
      <aside id="ade-task-inspector" className="task-inspector" aria-label="Ход задачи" hidden={!open}>
        <div className="task-inspector-head"><h2>Ход задачи</h2><button className="icon-btn" aria-label="Скрыть ход задачи" title="Вернуться в чат" onClick={close}><Icon name="close" /></button></div>
        {inspector}
      </aside>
    </div>
  </section>;
}
