import { useState } from 'react';
import type { Project, Task } from '../../../packages/contracts/src/index.js';
import { Icon } from './ui.js';

export function projectTrail(project: Project, projects: Project[]): Project[] {
  const trail = [project], seen = new Set([project.id]);
  let parent = projects.find(item => item.id === project.parentId);
  while (parent && !seen.has(parent.id)) { trail.unshift(parent); seen.add(parent.id); parent = projects.find(item => item.id === parent!.parentId); }
  return trail;
}

export function ProjectTree({ projects, tasks, selected, query, onSelect, onLoad }: {
  projects: Project[]; tasks: Task[]; selected: string; query: string;
  onSelect(project: Project): void; onLoad(project: Project): Promise<void>;
}) {
  const [expanded, setExpanded] = useState<string[]>(() => {
    try { const value: unknown = JSON.parse(localStorage.getItem('ade:expanded') || '[]'); return Array.isArray(value) ? value.filter(id => typeof id === 'string').slice(0, 4000) : []; } catch { return []; }
  });
  const [pending, setPending] = useState<string[]>([]);
  const term = query.trim().toLocaleLowerCase(), visible = new Set<string>();
  const byId = new Map(projects.map(project => [project.id, project])), children = new Map<string | null, Project[]>(), counts = new Map<string, number>();
  for (const project of projects) {
    const siblings = children.get(project.parentId) || []; siblings.push(project); children.set(project.parentId, siblings);
    if (!term) visible.add(project.id);
    else if ((project.name + ' ' + project.path).toLocaleLowerCase().includes(term)) {
      let ancestor: Project | undefined = project;
      while (ancestor && !visible.has(ancestor.id)) { visible.add(ancestor.id); ancestor = ancestor.parentId ? byId.get(ancestor.parentId) : undefined; }
    }
  }
  for (const [parentId, siblings] of children) if (parentId) siblings.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
  for (const task of tasks) counts.set(task.projectId, (counts.get(task.projectId) || 0) + 1);
  async function toggle(project: Project) {
    if (expanded.includes(project.id)) {
      const next = expanded.filter(id => id !== project.id); setExpanded(next); localStorage.setItem('ade:expanded', JSON.stringify(next)); return;
    }
    const next = [...expanded, project.id]; setExpanded(next); localStorage.setItem('ade:expanded', JSON.stringify(next));
    setPending(previous => [...previous, project.id]);
    try { await onLoad(project); } finally { setPending(previous => previous.filter(id => id !== project.id)); }
  }
  function branch(parentId: string | null): React.ReactNode {
    return <ul>{(children.get(parentId) || []).filter(item => visible.has(item.id)).map(project => {
      const hasChildren = project.hasChildren || children.has(project.id);
      const open = !!term || expanded.includes(project.id), count = counts.get(project.id) || 0;
      return <li key={project.id}>
        <div className="tree-row" data-selected={selected === project.id} data-missing={project.missing}>
          {hasChildren ? <button className="project-toggle" aria-label={(open ? 'Свернуть ' : 'Развернуть ') + project.name} aria-expanded={open} disabled={pending.includes(project.id)} onClick={() => void toggle(project)}><Icon name="chevron" /></button> : <span className="project-toggle-spacer" />}
          <button className="node-button" title={project.path + (project.missing ? ' · папка недоступна' : '')} aria-current={selected === project.id ? 'page' : undefined} onClick={() => onSelect(project)}><span className="node-mark project"><Icon name={project.kind === 'repository' ? 'git' : 'folder'} /></span><span className="node-name">{project.name}</span>{count ? <small className="project-count">{count}</small> : null}{project.missing || project.scanError ? <span title={project.scanError || 'Папка недоступна'} className="project-warning">!</span> : null}</button>
        </div>
        {open && hasChildren ? <div className="project-children">{pending.includes(project.id) ? <p className="tree-empty" role="status">Читаю папки…</p> : branch(project.id)}</div> : null}
      </li>;
    })}</ul>;
  }
  return <nav className="tree" aria-label="Проекты">{branch(null)}{!projects.length ? <p className="tree-empty">Подключите папку проекта. Git необязателен.</p> : term && !visible.size ? <p className="tree-empty">Проект не найден.</p> : null}</nav>;
}
