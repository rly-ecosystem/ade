import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname, basename } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { ACTIVE_RUNS, EXECUTION_UNAVAILABLE, type Project, type Task, type TaskDetail, type TaskEvent, type Bootstrap, type Provider, type Run, type RunStatus, type Approval, type Checkpoint, type ExecutionGroup, type Transfer, type ToolAction, type LimitInfo } from '../../contracts/src/index.js';
import { contains, overlaps, type DirectoryInfo } from './directories.js';
import { ECONOMY, type HandoffReport, type TokenUsage } from '../../contracts/src/handoff.js';
import { workspaceDigest } from './checkpoint.js';
import type { Role, RoleStep, Workflow, Verification, Acceptance } from '../../contracts/src/index.js';
import { hasPassingChecks } from '../../contracts/src/index.js';
import type { ProfileBindings } from '../../contracts/src/accounts.js';

import { usageInsights } from './insights.js';
import type { InsightPeriod } from '../../contracts/src/insights.js';

export class Store {
  private db: DatabaseSync;

  constructor(filename: string) {
    mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    try {
      chmodSync(filename, 0o600);
      const version = Number((this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
      if (version > 6) throw new Error('База создана более новой версией ADE. Требуется совместимая версия приложения.');
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
      if (version === 0) this.db.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE, createdAt TEXT NOT NULL);
        CREATE TABLE tasks (id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id), title TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('draft','waiting')), createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
        CREATE TABLE events (id TEXT PRIMARY KEY, taskId TEXT NOT NULL REFERENCES tasks(id), sequence INTEGER NOT NULL,
          type TEXT NOT NULL, payload TEXT NOT NULL, createdAt TEXT NOT NULL, UNIQUE(taskId,sequence));
        CREATE TABLE requests (id TEXT PRIMARY KEY, digest TEXT NOT NULL, result TEXT NOT NULL);
        CREATE INDEX tasks_project ON tasks(projectId);
        PRAGMA user_version=1;
        COMMIT;
      `);
      if (version < 2) {
        this.db.exec(`PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE;
          CREATE TABLE tasks_next (id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id), title TEXT NOT NULL,
            status TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
          INSERT INTO tasks_next SELECT * FROM tasks;
          DROP TABLE tasks; ALTER TABLE tasks_next RENAME TO tasks;
          CREATE INDEX tasks_project ON tasks(projectId);
          ALTER TABLE projects ADD COLUMN trusted INTEGER NOT NULL DEFAULT 0;
          CREATE TABLE checkpoints (id TEXT PRIMARY KEY, taskId TEXT NOT NULL REFERENCES tasks(id), data TEXT NOT NULL);
          CREATE TABLE runs (id TEXT PRIMARY KEY, taskId TEXT NOT NULL REFERENCES tasks(id), projectId TEXT NOT NULL REFERENCES projects(id),
            provider TEXT NOT NULL, model TEXT NOT NULL, status TEXT NOT NULL, generation INTEGER NOT NULL, requestId TEXT NOT NULL UNIQUE,
            checkpointId TEXT NOT NULL REFERENCES checkpoints(id), startedAt TEXT NOT NULL, endedAt TEXT, pid INTEGER, processStamp TEXT, sessionId TEXT, error TEXT);
          CREATE UNIQUE INDEX run_task_generation ON runs(taskId,generation);
          CREATE UNIQUE INDEX run_project_owner ON runs(projectId) WHERE status IN ('starting','running','awaiting_approval','stopping');
          CREATE TABLE approvals (id TEXT PRIMARY KEY, runId TEXT NOT NULL REFERENCES runs(id), kind TEXT NOT NULL, title TEXT NOT NULL, details TEXT NOT NULL, status TEXT NOT NULL);
          PRAGMA user_version=2; COMMIT; PRAGMA foreign_keys=ON;`);
        if (this.db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Нарушены связи локальной базы.');
      }
      if (version < 3) this.db.exec(`BEGIN IMMEDIATE;
        ALTER TABLE projects ADD COLUMN parentId TEXT REFERENCES projects(id);
        ALTER TABLE projects ADD COLUMN kind TEXT NOT NULL DEFAULT 'repository';
        ALTER TABLE projects ADD COLUMN hasChildren INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE projects ADD COLUMN childrenLoaded INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE projects ADD COLUMN missing INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE projects ADD COLUMN scanError TEXT;
        ALTER TABLE tasks ADD COLUMN autoSwitch INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE tasks ADD COLUMN codexModel TEXT NOT NULL DEFAULT '';
        ALTER TABLE tasks ADD COLUMN claudeModel TEXT NOT NULL DEFAULT '';
        CREATE TABLE execution_groups (id TEXT PRIMARY KEY,taskId TEXT NOT NULL REFERENCES tasks(id),projectId TEXT NOT NULL REFERENCES projects(id),scopeRoot TEXT NOT NULL,status TEXT NOT NULL,startedAt TEXT NOT NULL,deadlineAt TEXT NOT NULL,reason TEXT NOT NULL DEFAULT '');
        ALTER TABLE runs ADD COLUMN groupId TEXT REFERENCES execution_groups(id);
        ALTER TABLE runs ADD COLUMN limitData TEXT;
        CREATE TABLE transfers (id TEXT PRIMARY KEY,groupId TEXT NOT NULL REFERENCES execution_groups(id),fromRunId TEXT NOT NULL UNIQUE REFERENCES runs(id),toProvider TEXT NOT NULL,status TEXT NOT NULL,toRunId TEXT,reason TEXT NOT NULL);
        CREATE TABLE tool_actions (runId TEXT NOT NULL REFERENCES runs(id),itemId TEXT NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL,description TEXT NOT NULL,PRIMARY KEY(runId,itemId));
        CREATE UNIQUE INDEX group_scope_owner ON execution_groups(scopeRoot) WHERE status IN ('active','switching');
        PRAGMA user_version=3; COMMIT;`);
      if (version < 4) this.db.exec(`BEGIN IMMEDIATE;
        ALTER TABLE tasks ADD COLUMN rolePlanData TEXT;
        ALTER TABLE tasks ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE runs ADD COLUMN role TEXT NOT NULL DEFAULT 'developer';
        ALTER TABLE runs ADD COLUMN artifactDigest TEXT;
        ALTER TABLE runs ADD COLUMN iteration INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE runs ADD COLUMN reviewVerdict TEXT;
        CREATE TABLE workflows (groupId TEXT PRIMARY KEY REFERENCES execution_groups(id),taskId TEXT NOT NULL REFERENCES tasks(id),stepsData TEXT NOT NULL,stepIndex INTEGER NOT NULL,iteration INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL);
        CREATE TABLE verifications (id TEXT PRIMARY KEY,taskId TEXT NOT NULL REFERENCES tasks(id),groupId TEXT NOT NULL REFERENCES execution_groups(id),runId TEXT REFERENCES runs(id),command TEXT NOT NULL,status TEXT NOT NULL,output TEXT NOT NULL DEFAULT '',exitCode INTEGER,startedAt TEXT NOT NULL,endedAt TEXT,pid INTEGER,processStamp TEXT,workspaceDigest TEXT NOT NULL,messageSequence INTEGER NOT NULL,stale INTEGER NOT NULL DEFAULT 0,error TEXT NOT NULL DEFAULT '',requestId TEXT NOT NULL UNIQUE);
        CREATE TABLE acceptances (taskId TEXT PRIMARY KEY REFERENCES tasks(id),runId TEXT NOT NULL REFERENCES runs(id),workspaceDigest TEXT NOT NULL,messageSequence INTEGER NOT NULL,note TEXT NOT NULL,mode TEXT NOT NULL,createdAt TEXT NOT NULL,stale INTEGER NOT NULL DEFAULT 0);
        PRAGMA user_version=4; COMMIT;`);
      if (version < 5) this.db.exec(`BEGIN IMMEDIATE;
        ALTER TABLE tasks ADD COLUMN parallel INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE tasks ADD COLUMN economy INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE workflows ADD COLUMN parallel INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE workflows ADD COLUMN economy INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE workflows ADD COLUMN baseDigest TEXT;
        ALTER TABLE workflows ADD COLUMN inputSequence INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE runs ADD COLUMN compact INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE runs ADD COLUMN promptBytes INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE runs ADD COLUMN summaryData TEXT;
        ALTER TABLE runs ADD COLUMN usageData TEXT;
        UPDATE runs SET promptBytes=COALESCE(length(CAST((SELECT json_extract(data,'$.prompt') FROM checkpoints WHERE id=runs.checkpointId) AS BLOB)),0);
        DROP INDEX run_project_owner;
        CREATE UNIQUE INDEX run_project_writer ON runs(projectId) WHERE role='developer' AND status IN ('starting','running','awaiting_approval','stopping');
        CREATE UNIQUE INDEX run_role_owner ON runs(groupId,role,iteration) WHERE status IN ('starting','running','awaiting_approval','stopping');
        CREATE TABLE handoffs (id TEXT PRIMARY KEY,groupId TEXT NOT NULL REFERENCES workflows(groupId),fromRunId TEXT NOT NULL REFERENCES runs(id),toRole TEXT NOT NULL,iteration INTEGER NOT NULL,createdAt TEXT NOT NULL,UNIQUE(fromRunId,toRole,iteration));
        CREATE TABLE handoff_receipts (handoffId TEXT NOT NULL REFERENCES handoffs(id),runId TEXT NOT NULL REFERENCES runs(id),createdAt TEXT NOT NULL,PRIMARY KEY(handoffId,runId));
        PRAGMA user_version=5; COMMIT;`);
      if (version < 6) this.db.exec(`BEGIN IMMEDIATE;
        ALTER TABLE execution_groups ADD COLUMN profileBindings TEXT NOT NULL DEFAULT '{}';
        ALTER TABLE runs ADD COLUMN profileId TEXT;
        PRAGMA user_version=6; COMMIT;`);
      this.db.exec('CREATE INDEX IF NOT EXISTS runs_started ON runs(startedAt)');
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  insights(period: InsightPeriod, projectId: string | null) {
    return usageInsights(this.db, period, projectId);
  }

  close(): void { this.db.close(); }

  bootstrap(): Bootstrap {
    return {
      schemaVersion: 6,
      projects: this.db.prepare('SELECT * FROM projects ORDER BY createdAt, id').all().map(row => this.decodeProject(row)),
      tasks: this.db.prepare('SELECT * FROM tasks ORDER BY updatedAt DESC, id').all().map(row => this.decodeTask(row)),
      execution: { available: true, reason: EXECUTION_UNAVAILABLE },
    };
  }

  private decodeProject(row: Record<string, unknown>): Project {
    return { ...row, trusted: row.trusted === 1, hasChildren: row.hasChildren === 1, childrenLoaded: row.childrenLoaded === 1, missing: row.missing === 1 } as unknown as Project;
  }
  private decodeGroup(row: Record<string, unknown>): ExecutionGroup { const { profileBindings, ...group } = row; return { ...group, profiles: JSON.parse(profileBindings as string || '{}') } as unknown as ExecutionGroup; }
  private decodeRun(row: Record<string, unknown>): Run {
    const { limitData, summaryData, usageData, ...run } = row;
    return { ...run, compact: run.compact === 1, limit: limitData ? JSON.parse(limitData as string) : null, summary: summaryData ? JSON.parse(summaryData as string) : null, usage: usageData ? JSON.parse(usageData as string) : null } as unknown as Run;
  }
  private decodeTask(row: Record<string, unknown>): Task {
    const { rolePlanData, ...task } = row;
    return { ...task, parallel: task.parallel === 1, economy: task.economy === 1, archived: task.archived === 1, autoSwitch: task.autoSwitch === 1, rolePlan: rolePlanData ? JSON.parse(rolePlanData as string) : null } as unknown as Task;
  }

  project(id: string): Project {
    const project = this.db.prepare('SELECT * FROM projects WHERE id=?').get(id) as unknown as Project | undefined;
    if (!project) throw new Error('Проект не найден.');
    return this.decodeProject(project as unknown as Record<string, unknown>);
  }

  addProject(path: string): Project {
    const existing = this.db.prepare('SELECT * FROM projects WHERE path=?').get(path) as unknown as Project | undefined;
    if (existing) return this.decodeProject(existing as unknown as Record<string, unknown>);
    const project: Project = { id: randomUUID(), name: basename(path), path, createdAt: new Date().toISOString(), trusted: false, parentId: null, kind: 'directory', hasChildren: true, childrenLoaded: false, missing: false, scanError: null };
    this.db.prepare('INSERT INTO projects (id,name,path,createdAt) VALUES (?, ?, ?, ?)').run(project.id, project.name, project.path, project.createdAt);
    return project;
  }

  syncDirectory(id: string, info: DirectoryInfo, children: DirectoryInfo[]): Project[] {
    const parent = this.project(id);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE projects SET kind=?,hasChildren=?,childrenLoaded=1,missing=0,scanError=NULL WHERE id=?').run(info.kind, Number(children.length > 0), id);
      const paths = new Set(children.map(child => child.path));
      for (const child of this.bootstrap().projects.filter(item => item.parentId === id)) if (!paths.has(child.path)) this.db.prepare('UPDATE projects SET missing=1 WHERE id=?').run(child.id);
      const result: Project[] = [];
      for (const child of children) {
        if (!contains(parent.path, child.path) || child.path === parent.path) throw new Error('Подпроект выходит за границы родителя.');
        const existing = this.addProject(child.path);
        this.db.prepare('UPDATE projects SET parentId=?,kind=?,hasChildren=?,missing=0 WHERE id=?').run(id, child.kind, Number(child.hasChildren), existing.id);
        result.push(this.project(existing.id));
      }
      this.db.exec('COMMIT'); return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  scanFailed(id: string, reason: string): void { this.db.prepare('UPDATE projects SET scanError=? WHERE id=?').run(reason, id); }
  scopeRoot(id: string): string {
    let project = this.project(id); const seen = new Set<string>();
    while (project.parentId) {
      if (seen.has(project.id)) throw new Error('Нарушена структура проектов.'); seen.add(project.id);
      const parent = this.project(project.parentId); if (!contains(parent.path, project.path)) throw new Error('Изменилась граница проекта.'); project = parent;
    }
    return project.path;
  }

  detail(id: string): TaskDetail {
    const task = this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id) as unknown as Task | undefined;
    if (!task) throw new Error('Задача не найдена.');
    const rows = this.db.prepare('SELECT * FROM events WHERE taskId=? ORDER BY sequence').all(id);
    const events = rows.map(row => ({ ...row, payload: JSON.parse(row.payload as string) })) as unknown as TaskEvent[];
    const group = this.db.prepare('SELECT * FROM execution_groups WHERE taskId=? ORDER BY startedAt DESC,rowid DESC LIMIT 1').get(id);
    const workflow = this.db.prepare('SELECT * FROM workflows WHERE taskId=? ORDER BY rowid DESC LIMIT 1').get(id);
    const acceptance = this.db.prepare('SELECT * FROM acceptances WHERE taskId=?').get(id);
    return { task: this.decodeTask(task as unknown as Record<string, unknown>), events,
      runs: this.db.prepare('SELECT * FROM runs WHERE taskId=? ORDER BY generation').all(id).map(row => this.decodeRun(row)),
      approvals: this.db.prepare("SELECT approvals.* FROM approvals JOIN runs ON runs.id=approvals.runId WHERE runs.taskId=? AND approvals.status='pending'").all(id).map(row => ({ ...row })) as unknown as Approval[],
      group: group ? this.decodeGroup(group) : null,
      transfers: this.db.prepare('SELECT transfers.* FROM transfers JOIN execution_groups ON execution_groups.id=transfers.groupId WHERE execution_groups.taskId=? ORDER BY transfers.rowid').all(id).map(row => ({ ...row })) as unknown as Transfer[],
      actions: this.db.prepare('SELECT tool_actions.* FROM tool_actions JOIN runs ON runs.id=tool_actions.runId WHERE runs.taskId=?').all(id).map(row => ({ ...row })) as unknown as ToolAction[],
      workflow: workflow ? this.decodeWorkflow(workflow) : null,
      checks: this.db.prepare('SELECT * FROM verifications WHERE taskId=? ORDER BY rowid').all(id).map(row => this.decodeCheck(row)),
      acceptance: acceptance ? { ...acceptance, stale: acceptance.stale === 1 } as unknown as Acceptance : null,
      handoffs: this.db.prepare('SELECT handoffs.* FROM handoffs JOIN workflows ON workflows.groupId=handoffs.groupId WHERE workflows.taskId=? ORDER BY handoffs.rowid').all(id).map(row => ({ ...row, recipients: this.db.prepare('SELECT runId FROM handoff_receipts WHERE handoffId=? ORDER BY rowid').all(row.id as string).map(item => item.runId as string) })) as TaskDetail['handoffs'],
    };
  }

  assertIdle(projectId: string, groupId?: string, parallelRole?: Role): void {
    const scope = this.scopeRoot(projectId);
    if (this.activeRuns().some(run => overlaps(scope, this.scopeRoot(run.projectId)) && !(parallelRole && run.groupId === groupId && ['orchestrator', 'researcher'].includes(run.role))) || this.activeChecks().some(check => overlaps(scope, this.group(check.groupId).scopeRoot)) || this.groups().some(group => group.id !== groupId && overlaps(scope, group.scopeRoot))) throw new Error('В этом проекте уже есть активный исполнитель. Сначала остановите его.');
  }
  private decodeWorkflow(row: Record<string, unknown>): Workflow { const { stepsData, ...value } = row; return { ...value, parallel: value.parallel === 1, economy: value.economy === 1, steps: JSON.parse(stepsData as string) } as unknown as Workflow; }
  workflow(groupId: string): Workflow | null { const row = this.db.prepare('SELECT * FROM workflows WHERE groupId=?').get(groupId); return row ? this.decodeWorkflow(row) : null; }
  pendingWorkflows(): Workflow[] { return this.db.prepare("SELECT workflows.* FROM workflows JOIN execution_groups ON execution_groups.id=workflows.groupId WHERE execution_groups.status IN ('active','switching') AND (workflows.status='pending' OR workflows.parallel=1 AND workflows.stepIndex<2 AND workflows.status='running')").all().map(row => this.decodeWorkflow(row)); }
  configureWorkflow(taskId: string, parallel: boolean, economy: boolean): TaskDetail {
    const detail = this.detail(taskId); this.requireEditable(taskId); this.assertIdle(detail.task.projectId);
    this.db.prepare('UPDATE tasks SET parallel=?,economy=? WHERE id=?').run(Number(parallel), Number(economy), taskId); return this.detail(taskId);
  }
  configureRoles(taskId: string, steps: RoleStep[]): TaskDetail {
    const detail = this.detail(taskId); this.assertIdle(detail.task.projectId);
    this.requireEditable(taskId);
    this.db.prepare('UPDATE tasks SET rolePlanData=? WHERE id=?').run(JSON.stringify(steps), taskId); return this.detail(taskId);
  }
  startWorkflow(taskId: string, requestId: string, profiles: Partial<ProfileBindings> = {}): TaskDetail {
    return this.mutate(requestId, ['workflow.start', taskId], () => {
      const task = this.detail(taskId).task, project = this.project(task.projectId); this.assertIdle(project.id);
      this.requireEditable(taskId);
      if (!project.trusted) throw new Error('Подтвердите доверие проекту перед запуском.');
      if (!task.rolePlan) throw new Error('Сначала сохраните назначения четырёх ролей.');
      const id = randomUUID(), now = new Date().toISOString();
      this.db.prepare("INSERT INTO execution_groups (id,taskId,projectId,scopeRoot,status,startedAt,deadlineAt,reason,profileBindings) VALUES (?,?,?,?, 'switching',?,?, '',?)").run(id, taskId, project.id, this.scopeRoot(project.id), now, new Date(Date.now() + 120 * 60 * 1000).toISOString(), JSON.stringify(profiles));
      this.db.prepare("INSERT INTO workflows (groupId,taskId,stepsData,stepIndex,iteration,status,parallel,economy,inputSequence) VALUES (?,?,?,0,0,'pending',?,?,?)").run(id, taskId, JSON.stringify(task.rolePlan), Number(task.parallel), Number(task.economy), this.messageSequence(taskId));
      this.db.prepare("UPDATE tasks SET status='switching' WHERE id=?").run(taskId);
      this.event(taskId, 'workflow.status', { text: task.parallel ? 'Планирование и исследование запускаются параллельно; затем разработка и ревью.' : 'Начинается цепочка: планирование, исследование, разработка, ревью.' }); return this.detail(taskId);
    });
  }

  private decodeCheck(row: Record<string, unknown>): Verification { const { requestId: _, ...value } = row; return { ...value, stale: value.stale === 1 } as unknown as Verification; }
  check(id: string): Verification { const row = this.db.prepare('SELECT * FROM verifications WHERE id=?').get(id); if (!row) throw new Error('Проверка не найдена.'); return this.decodeCheck(row); }
  activeChecks(): Verification[] { return this.db.prepare("SELECT * FROM verifications WHERE status IN ('running','stopping')").all().map(row => this.decodeCheck(row)); }
  messageSequence(taskId: string): number { return Number(this.db.prepare("SELECT COALESCE(MAX(sequence),0) AS sequence FROM events WHERE taskId=? AND type='message.created'").get(taskId)!.sequence); }
  replayCheck(requestId: string, taskId: string, command: string): Verification | null {
    const row = this.db.prepare('SELECT * FROM verifications WHERE requestId=?').get(requestId); if (!row) return null;
    if (row.taskId !== taskId || row.command !== command) throw new Error('Ключ проверки уже использован с другими данными.'); return this.decodeCheck(row);
  }
  beginCheck(taskId: string, command: string, requestId: string, workspaceDigest: string, sequence: number): Verification {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const detail = this.detail(taskId), project = this.project(detail.task.projectId); this.assertIdle(project.id);
      this.requireEditable(taskId);
      if (!project.trusted) throw new Error('Подтвердите доверие проекту перед запуском.');
      if (sequence !== this.messageSequence(taskId)) throw new Error('Требования изменились. Повторите проверку.');
      const id = randomUUID(), groupId = randomUUID(), now = new Date().toISOString();
      this.db.prepare("INSERT INTO execution_groups (id,taskId,projectId,scopeRoot,status,startedAt,deadlineAt,reason) VALUES (?,?,?,?, 'active',?,?, '')").run(groupId, taskId, project.id, this.scopeRoot(project.id), now, new Date(Date.now() + 5 * 60 * 1000).toISOString());
      this.db.prepare("INSERT INTO verifications(id,taskId,groupId,runId,command,status,startedAt,workspaceDigest,messageSequence,requestId) VALUES (?,?,?,?,?,'running',?,?,?,?)").run(id, taskId, groupId, detail.runs.at(-1)?.id || null, command, now, workspaceDigest, sequence, requestId);
      this.db.prepare("UPDATE tasks SET status='checking' WHERE id=?").run(taskId);
      this.event(taskId, 'check.status', { checkId: id, text: 'Запущена проверка: ' + command });
      this.db.exec('COMMIT'); return this.check(id);
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  checkProcess(id: string, pid: number, stamp: string): void { this.db.prepare('UPDATE verifications SET pid=?,processStamp=? WHERE id=?').run(pid, stamp, id); }
  checkOutput(id: string, output: string): void { this.db.prepare("UPDATE verifications SET output=? WHERE id=? AND status IN ('running','stopping')").run(output, id); }
  checkStopping(id: string, error = ''): void { this.db.prepare("UPDATE verifications SET status='stopping',error=? WHERE id=? AND status IN ('running','stopping')").run(error, id); }
  finishCheck(id: string, status: Verification['status'], exitCode: number | null, error: string, stale = false): void {
    const check = this.check(id); if (!['running', 'stopping'].includes(check.status)) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE verifications SET status=?,exitCode=?,endedAt=?,error=?,stale=? WHERE id=?').run(status, exitCode, new Date().toISOString(), error, Number(stale), id);
      this.db.prepare('UPDATE execution_groups SET status=?,reason=? WHERE id=?').run(status === 'passed' ? 'completed' : status === 'stopped' ? 'stopped' : 'waiting', error, check.groupId);
      this.db.prepare('UPDATE tasks SET status=? WHERE id=?').run(status === 'stopped' ? 'stopped' : status === 'interrupted' ? 'interrupted' : 'review', check.taskId);
      this.event(check.taskId, 'check.status', { checkId: id, status, text: error || (status === 'passed' ? 'Команда проверки завершилась успешно.' : 'Проверка завершилась с ошибкой.') });
      this.db.exec('COMMIT');
    } catch (failure) { this.db.exec('ROLLBACK'); throw failure; }
  }
  refreshEvidence(taskId: string, digest: string): TaskDetail {
    const detail = this.detail(taskId), sequence = this.messageSequence(taskId), run = detail.runs.at(-1);
    let changed = false;
    for (const check of detail.checks.filter(item => !['running', 'stopping'].includes(item.status))) {
      const stale = check.workspaceDigest !== digest || check.messageSequence !== sequence || check.runId !== (run?.id || null) || !!run && run.status !== 'completed';
      if (stale !== check.stale) { this.db.prepare('UPDATE verifications SET stale=? WHERE id=?').run(Number(stale), check.id); changed = true; }
    }
    if (detail.acceptance) {
      const stale = detail.acceptance.workspaceDigest !== digest || detail.acceptance.messageSequence !== sequence || detail.acceptance.runId !== run?.id || run?.status !== 'completed';
      if (stale !== detail.acceptance.stale) {
        this.db.prepare('UPDATE acceptances SET stale=? WHERE taskId=?').run(Number(stale), taskId); changed = true;
        if (detail.task.status === 'accepted' && stale) this.db.prepare("UPDATE tasks SET status='review' WHERE id=?").run(taskId);
      }
    }
    if (changed) this.event(taskId, 'acceptance.updated', { text: 'Актуальность проверок сверена с файлами и требованиями.' });
    return this.detail(taskId);
  }
  accept(taskId: string, digest: string, note: string): TaskDetail {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const detail = this.detail(taskId), run = detail.runs.at(-1); this.assertIdle(detail.task.projectId);
      this.requireEditable(taskId);
      if (!run || run.status !== 'completed' || run.artifactDigest !== digest) throw new Error('Нужен завершённый запуск для текущего состояния файлов. Повторите разработку или ревью.');
      const checkpoint = JSON.parse(this.db.prepare('SELECT data FROM checkpoints WHERE id=?').get(run.checkpointId)!.data as string) as Checkpoint;
      const sequence = this.messageSequence(taskId);
      if (sequence > checkpoint.eventSequence) throw new Error('Новые требования ещё не обработаны исполнителем. Продолжите задачу.');
      const workflow = run.groupId ? this.workflow(run.groupId) : null;
      if (workflow && workflow.status !== 'ready') throw new Error('Цепочка ролей ещё не завершена.');
      const passed = hasPassingChecks({ ...detail, checks: detail.checks.filter(check => check.workspaceDigest === digest && check.messageSequence === sequence) });
      if (!passed && !note.trim()) throw new Error('Запустите команду проверки или укажите причину ручной приёмки.');
      this.db.prepare('INSERT INTO acceptances VALUES (?,?,?,?,?,?,?,0) ON CONFLICT(taskId) DO UPDATE SET runId=excluded.runId,workspaceDigest=excluded.workspaceDigest,messageSequence=excluded.messageSequence,note=excluded.note,mode=excluded.mode,createdAt=excluded.createdAt,stale=0').run(taskId, run.id, digest, sequence, note.trim(), passed ? 'checked' : 'manual', new Date().toISOString());
      this.db.prepare("UPDATE tasks SET status='accepted' WHERE id=?").run(taskId);
      this.event(taskId, 'acceptance.updated', { text: passed ? 'Результат принят с актуальной проверкой.' : 'Результат принят вручную: ' + note.trim() });
      this.db.exec('COMMIT'); return this.detail(taskId);
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  trust(id: string, trusted: boolean): Project {
    this.project(id);
    if (this.activeRuns().some(run => overlaps(this.scopeRoot(id), this.project(run.projectId).path)) || this.groups().some(group => overlaps(this.scopeRoot(id), group.scopeRoot))) throw new Error('Сначала остановите активного исполнителя проекта.');
    this.db.prepare('UPDATE projects SET trusted=? WHERE id=?').run(Number(trusted), id);
    return this.project(id);
  }

  run(id: string): Run {
    const run = this.db.prepare('SELECT * FROM runs WHERE id=?').get(id);
    if (!run) throw new Error('Запуск не найден.');
    return this.decodeRun(run);
  }

  replayRun(requestId: string, taskId: string, provider: Provider, model: string, role: Role = 'developer'): Run | undefined {
    const row = this.db.prepare('SELECT * FROM runs WHERE requestId=?').get(requestId);
    if (!row) return;
    if (row.taskId !== taskId || row.provider !== provider || row.model !== model || row.role !== role) throw new Error('Ключ запуска уже использован с другими данными.');
    return this.decodeRun(row);
  }

  activeRuns(): Run[] { return this.db.prepare("SELECT * FROM runs WHERE status IN ('starting','running','awaiting_approval','stopping')").all().map(row => this.decodeRun(row)); }
  groups(): ExecutionGroup[] { return this.db.prepare("SELECT * FROM execution_groups WHERE status IN ('active','switching')").all().map(row => this.decodeGroup(row)); }
  group(id: string): ExecutionGroup {
    const row = this.db.prepare('SELECT * FROM execution_groups WHERE id=?').get(id); if (!row) throw new Error('Маршрут не найден.'); return this.decodeGroup(row);
  }
  pendingTransfers(): Transfer[] { return this.db.prepare("SELECT transfers.* FROM transfers JOIN execution_groups ON execution_groups.id=transfers.groupId WHERE transfers.status='pending' AND execution_groups.status IN ('active','switching')").all().map(row => ({ ...row })) as unknown as Transfer[]; }
  configureRoute(id: string, enabled: boolean, codexModel: string, claudeModel: string): TaskDetail {
    this.requireEditable(id);
    if (this.groups().some(group => group.taskId === id) || this.activeRuns().some(run => run.taskId === id)) throw new Error('Настройки маршрута меняются после остановки задачи.');
    this.db.prepare('UPDATE tasks SET autoSwitch=?,codexModel=?,claudeModel=? WHERE id=?').run(Number(enabled), codexModel, claudeModel, id); return this.detail(id);
  }

  beginRun(taskId: string, provider: Provider, model: string, requestId: string, checkpoint: Checkpoint, groupId?: string, requestedRole: Role = 'developer', profileId: string | null = null, profiles: Partial<ProfileBindings> = {}): Run {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const { task } = this.detail(taskId);
      this.requireEditable(taskId);
      const project = this.project(task.projectId);
      if (!project.trusted) throw new Error('Подтвердите доверие выбранному проекту перед запуском.');
      const scope = this.scopeRoot(project.id);
      const workflow = groupId ? this.workflow(groupId) : null;
      const parallel = !!workflow?.parallel && workflow.stepIndex < 2;
      const role: Role = parallel ? requestedRole : workflow?.steps[workflow.stepIndex]?.role || requestedRole;
      if (parallel && !['orchestrator', 'researcher'].includes(role)) throw new Error('Перед записью нужны результаты обеих параллельных ролей.');
      this.assertIdle(project.id, groupId, parallel ? role : undefined);
      if (groupId && ((!parallel && this.group(groupId).status !== 'switching' || parallel && !['active', 'switching'].includes(this.group(groupId).status)) || this.group(groupId).taskId !== taskId || Date.parse(this.group(groupId).deadlineAt) <= Date.now())) throw new Error('Передача отменена или достигнут предел времени.');
      const detail = this.detail(taskId), compact = workflow?.economy ?? task.economy;
      if (detail.events.at(-1)?.sequence !== checkpoint.eventSequence && !(parallel && !detail.events.some(event => event.sequence > checkpoint.eventSequence && event.type === 'message.created'))) throw new Error('Контекст задачи изменился. Повторите запуск.');
      if (parallel && this.messageSequence(taskId) !== workflow!.inputSequence) throw new Error('Требования изменились во время подготовки параллельных ролей. Повторите цепочку.');
      const packetDigest = workspaceDigest(checkpoint.gitDigest, checkpoint.manifest);
      if (parallel && workflow!.baseDigest && workflow!.baseDigest !== packetDigest) throw new Error('Параллельные роли должны читать одну версию файлов.');
      const promptBytes = Buffer.byteLength(checkpoint.prompt), groupRuns = detail.runs.filter(run => run.groupId === groupId);
      if (compact && (promptBytes > ECONOMY.promptBytes || workflow && (groupRuns.length >= ECONOMY.runs || groupRuns.reduce((sum, run) => sum + run.promptBytes, 0) + promptBytes > ECONOMY.chainPromptBytes))) throw new Error('Достигнут бюджет экономного режима. Сократите требования или явно измените режим после остановки.');
      const group = groupId || randomUUID();
      if (!groupId) this.db.prepare("INSERT INTO execution_groups (id,taskId,projectId,scopeRoot,status,startedAt,deadlineAt,reason,profileBindings) VALUES (?, ?, ?, ?, 'active', ?, ?, '',?)").run(group, taskId, project.id, scope, new Date().toISOString(), new Date(Date.now() + 30 * 60 * 1000).toISOString(), JSON.stringify(profiles));
      else this.db.prepare("UPDATE execution_groups SET status='active' WHERE id=? AND status='switching'").run(group);
      const run: Run = { id: randomUUID(), taskId, projectId: project.id, provider, model, status: 'starting', generation: detail.runs.length + 1, requestId, checkpointId: checkpoint.id, startedAt: new Date().toISOString(), endedAt: null, pid: null, processStamp: null, sessionId: null, error: null, groupId: group, limit: null, role, artifactDigest: null, iteration: workflow?.iteration || 0, reviewVerdict: null, compact, promptBytes, summary: null, usage: null };
      this.db.prepare('INSERT INTO checkpoints VALUES (?, ?, ?)').run(checkpoint.id, taskId, JSON.stringify(checkpoint));
      this.db.prepare('INSERT INTO runs (id,taskId,projectId,provider,model,status,generation,requestId,checkpointId,startedAt,groupId) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(run.id, taskId, project.id, provider, model, run.status, run.generation, requestId, checkpoint.id, run.startedAt, group);
      this.db.prepare('UPDATE runs SET role=?,iteration=?,compact=?,promptBytes=?,profileId=? WHERE id=?').run(role, run.iteration, Number(compact), promptBytes, profileId, run.id); run.profileId = profileId;
      this.db.prepare('UPDATE acceptances SET stale=1 WHERE taskId=?').run(taskId);
      this.db.prepare('UPDATE verifications SET stale=1 WHERE taskId=?').run(taskId);
      if (workflow) this.db.prepare("UPDATE workflows SET status='running' WHERE groupId=?").run(group);
      if (parallel && !workflow!.baseDigest) this.db.prepare('UPDATE workflows SET baseDigest=? WHERE groupId=?').run(packetDigest, group);
      this.db.prepare(`UPDATE tasks SET ${provider === 'codex' ? 'codexModel' : 'claudeModel'}=? WHERE id=?`).run(model, taskId);
      if (groupId && requestId.startsWith('transfer:')) this.db.prepare("UPDATE transfers SET status='started',toRunId=? WHERE id=? AND groupId=? AND status='pending' AND toProvider=?").run(run.id, requestId.slice(9), groupId, provider);
      if (workflow) for (const handoff of detail.handoffs.filter(item => item.groupId === group && item.toRole === role && item.iteration === run.iteration)) {
        this.db.prepare('INSERT INTO handoff_receipts VALUES (?,?,?)').run(handoff.id, run.id, new Date().toISOString());
        this.event(taskId, 'handoff.received', { handoffId: handoff.id, runId: run.id, text: 'Получен результат роли ' + this.run(handoff.fromRunId).role + ' → ' + role });
      }
      this.db.prepare("UPDATE tasks SET status='starting' WHERE id=?").run(taskId);
      this.event(taskId, 'checkpoint.created', { checkpointId: checkpoint.id, digest: checkpoint.digest, runId: run.id });
      this.event(taskId, 'run.started', { runId: run.id, provider, generation: String(run.generation), text: 'Запуск ' + provider + '. Контекст сохранён.' });
      this.syncActiveStatus(taskId);
      this.db.exec('COMMIT'); return run;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  process(id: string, pid: number, stamp: string): void { this.db.prepare('UPDATE runs SET pid=?,processStamp=? WHERE id=?').run(pid, stamp, id); }
  session(id: string, sessionId: string): void { this.db.prepare('UPDATE runs SET sessionId=? WHERE id=?').run(sessionId, id); }
  usage(id: string, value: TokenUsage): void {
    const run = this.run(id); if (!ACTIVE_RUNS.includes(run.status)) return;
    if (run.usage && run.usage.input + run.usage.output > value.input + value.output) return;
    this.db.prepare('UPDATE runs SET usageData=? WHERE id=?').run(JSON.stringify(value), id);
  }
  private syncActiveStatus(taskId: string): boolean {
    const active = this.activeRuns().filter(run => run.taskId === taskId);
    const status = (['stopping', 'awaiting_approval', 'running', 'starting'] as const).find(status => active.some(run => run.status === status));
    if (status) this.db.prepare('UPDATE tasks SET status=? WHERE id=?').run(status, taskId);
    return !!status;
  }
  private publish(run: Run, toRole: Role, iteration: number): void {
    const id = randomUUID();
    this.db.prepare('INSERT INTO handoffs VALUES (?,?,?,?,?,?)').run(id, run.groupId, run.id, toRole, iteration, new Date().toISOString());
    this.event(run.taskId, 'handoff.created', { handoffId: id, fromRunId: run.id, toRole, text: run.role + ' → ' + toRole + ': краткий результат сохранён.' });
  }
  stoppingError(id: string, error: string): void { this.db.prepare('UPDATE runs SET error=? WHERE id=?').run(error, id); this.appendRun(id, 'run.status', { text: error }); }

  appendRun(id: string, type: TaskEvent['type'], payload: TaskEvent['payload']): void {
    const run = this.run(id); if (!ACTIVE_RUNS.includes(run.status)) return;
    this.event(run.taskId, type, { ...payload, runId: id, provider: run.provider });
  }

  state(id: string, status: 'running' | 'awaiting_approval' | 'stopping'): void {
    const run = this.run(id); if (!ACTIVE_RUNS.includes(run.status) || run.status === 'stopping' && status !== 'stopping') return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE runs SET status=? WHERE id=?').run(status, id);
      this.db.prepare('UPDATE tasks SET status=? WHERE id=?').run(status, run.taskId);
      this.event(run.taskId, 'run.status', { runId: id, status });
      this.syncActiveStatus(run.taskId);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  approval(runId: string, kind: string, title: string, details: string): Approval {
    const approval: Approval = { id: randomUUID(), runId, kind, title, details, status: 'pending' };
    this.db.prepare('INSERT INTO approvals VALUES (?, ?, ?, ?, ?, ?)').run(approval.id, runId, kind, title, details, approval.status);
    this.appendRun(runId, 'approval.requested', { approvalId: approval.id, text: title, details });
    this.state(runId, 'awaiting_approval'); return approval;
  }

  resolveApproval(runId: string, id: string, decision: 'allow' | 'deny'): void {
    if (!this.detail(this.run(runId).taskId).approvals.some(item => item.id === id && item.runId === runId)) throw new Error('Разрешение уже неактуально.');
    this.db.prepare('UPDATE approvals SET status=? WHERE id=? AND runId=?').run(decision, id, runId);
    this.appendRun(runId, 'approval.resolved', { approvalId: id, decision });
    if (!this.db.prepare("SELECT id FROM approvals WHERE runId=? AND status='pending'").get(runId)) this.state(runId, 'running');
  }

  approvalById(id: string): Approval {
    const row = this.db.prepare('SELECT * FROM approvals WHERE id=?').get(id);
    if (!row) throw new Error('Разрешение не найдено.');
    return { ...row } as unknown as Approval;
  }

  action(action: ToolAction): void {
    if (!ACTIVE_RUNS.includes(this.run(action.runId).status)) return;
    this.db.prepare('INSERT INTO tool_actions VALUES (?,?,?,?,?) ON CONFLICT(runId,itemId) DO UPDATE SET status=excluded.status,description=excluded.description').run(action.runId, action.itemId, action.kind, action.status, action.description);
  }

  finishRun(id: string, status: RunStatus, error = '', limit: LimitInfo | null = null, artifactDigest: string | null = null, reviewVerdict: Run['reviewVerdict'] = null, summary: HandoffReport | null = null): void {
    const run = this.run(id); if (!ACTIVE_RUNS.includes(run.status)) return;
    const previousGroup = run.groupId ? this.group(run.groupId) : null;
    const previousWorkflow = run.groupId ? this.workflow(run.groupId) : null;
    if (status === 'completed' && (run.compact || previousWorkflow?.parallel) && !summary) { status = 'failed'; error = 'Не получена корректная короткая передача. Требуется решение пользователя.'; }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE runs SET status=?,endedAt=?,error=?,limitData=? WHERE id=?').run(status, new Date().toISOString(), error || null, limit ? JSON.stringify(limit) : null, id);
      this.db.prepare('UPDATE runs SET artifactDigest=?,reviewVerdict=? WHERE id=?').run(artifactDigest, reviewVerdict, id);
      this.db.prepare('UPDATE runs SET summaryData=? WHERE id=?').run(summary ? JSON.stringify(summary) : null, id);
      this.db.prepare('UPDATE tasks SET status=? WHERE id=?').run(status, run.taskId);
      this.db.prepare("UPDATE approvals SET status='stale' WHERE runId=? AND status='pending'").run(id);
      this.event(run.taskId, 'run.finished', { runId: id, provider: run.provider, status, text: error || 'Исполнитель завершил шаг.' });
      if (run.groupId && ['active', 'switching'].includes(this.group(run.groupId).status)) {
        const detail = this.detail(run.taskId), toProvider: Provider = run.provider === 'codex' ? 'claude' : 'codex';
        const uncertain = detail.actions.some(action => action.runId === id && action.kind === 'command' && action.status === 'started');
        const workflow = this.workflow(run.groupId);
        if (status === 'completed' && summary && workflow) {
          if (['orchestrator', 'researcher'].includes(run.role)) {
            this.publish(run, 'developer', 0); this.publish(run, 'reviewer', 0);
            if (run.role === 'orchestrator' && !workflow.parallel) this.publish(run, 'researcher', 0);
          } else if (run.role === 'developer') this.publish(run, 'reviewer', run.iteration);
        }
        const attempted = detail.runs.some(item => item.groupId === run.groupId && item.role === run.role && item.iteration === run.iteration && item.provider === toProvider);
        const expired = Date.parse(this.group(run.groupId).deadlineAt) <= Date.now();
        const verifiedRoute = [run.profileId, this.group(run.groupId).profiles?.[toProvider]].every(profile => !profile || profile.startsWith('shared-'));
        if (status === 'limited' && limit && detail.task.autoSwitch && verifiedRoute && !uncertain && !attempted && !expired) {
          this.db.prepare("UPDATE execution_groups SET status='switching',reason=? WHERE id=?").run('Подтверждён лимит ' + run.provider, run.groupId);
          this.db.prepare("INSERT INTO transfers VALUES (?,?,?,?, 'pending',NULL,?)").run(randomUUID(), run.groupId, id, toProvider, 'Подтверждён лимит ' + run.provider);
          this.db.prepare("UPDATE tasks SET status='switching' WHERE id=?").run(run.taskId);
          this.event(run.taskId, 'route.switching', { runId: id, provider: toProvider, text: 'Лимит ' + run.provider + '. Сохраняем контекст и продолжаем через ' + toProvider + '.' });
        } else if (status === 'completed' && workflow?.parallel && workflow.stepIndex < 2 && !uncertain && !expired) {
          const prepared = ['orchestrator', 'researcher'].every(role => detail.runs.some(item => item.groupId === run.groupId && item.role === role && item.status === 'completed'));
          this.db.prepare('UPDATE workflows SET stepIndex=?,status=? WHERE groupId=?').run(prepared ? 2 : 0, prepared ? 'pending' : 'running', run.groupId);
          this.db.prepare('UPDATE execution_groups SET status=?,reason=? WHERE id=?').run(prepared ? 'switching' : 'active', prepared ? 'Оба результата получены. Начинается разработка.' : 'Ожидается второй участник подготовки.', run.groupId);
          this.db.prepare("UPDATE tasks SET status='switching' WHERE id=?").run(run.taskId);
          this.event(run.taskId, 'workflow.status', { text: prepared ? 'План и исследование передаются разработчику.' : 'Результат сохранён. Второй участник продолжает работу.' });
        } else if (status === 'completed' && workflow && !uncertain && !expired) {
          const reviewBlocked = run.role === 'reviewer' && reviewVerdict !== 'ready';
          if (reviewBlocked) {
            const developer = detail.runs.filter(item => item.groupId === run.groupId && item.role === 'developer' && item.iteration === workflow.iteration).at(-1);
            const denied = !!developer && detail.events.some(event => event.type === 'approval.resolved' && event.payload.runId === developer.id && event.payload.decision === 'deny');
            const repair = reviewVerdict === 'changes_required' && workflow.iteration < 1 && !denied;
            if (repair && summary) this.publish(run, 'developer', workflow.iteration + 1);
            const reason = repair ? 'Ревью нашло замечания. Один проход исправлений и повторное ревью.' : denied || reviewVerdict === 'blocked' ? 'Цепочка требует решения пользователя. Отказ в доступе или ограничение не повторяется автоматически.' : reviewVerdict ? 'После исправлений замечания остались. Требуется решение пользователя.' : 'Ревью не вернуло структурированный вывод. Требуется повторное ревью.';
            this.db.prepare('UPDATE workflows SET stepIndex=?,iteration=?,status=? WHERE groupId=?').run(repair ? 2 : workflow.stepIndex, repair ? workflow.iteration + 1 : workflow.iteration, repair ? 'pending' : 'waiting', run.groupId);
            this.db.prepare('UPDATE execution_groups SET status=?,reason=? WHERE id=?').run(repair ? 'switching' : 'waiting', reason, run.groupId);
            this.db.prepare('UPDATE tasks SET status=? WHERE id=?').run(repair ? 'switching' : 'waiting', run.taskId);
            this.event(run.taskId, 'workflow.status', { text: reason });
          } else {
          const next = workflow.stepIndex + 1, ready = next === workflow.steps.length;
          this.db.prepare('UPDATE workflows SET stepIndex=?,status=? WHERE groupId=?').run(ready ? workflow.stepIndex : next, ready ? 'ready' : 'pending', run.groupId);
          this.db.prepare('UPDATE execution_groups SET status=?,reason=? WHERE id=?').run(ready ? 'completed' : 'switching', ready ? 'Роли завершены. Требуется приёмка результата.' : 'Переход к следующей роли.', run.groupId);
          this.db.prepare('UPDATE tasks SET status=? WHERE id=?').run(ready ? 'review' : 'switching', run.taskId);
          this.event(run.taskId, 'workflow.status', { text: ready ? 'Ревью завершено. Проверьте результат и примите работу.' : 'Контекст передаётся следующей роли: ' + workflow.steps[next]!.role });
          }
        } else {
          const reason = status === 'limited' ? uncertain ? 'Команда не подтвердила завершение. Проверьте её результат перед продолжением.' : !verifiedRoute ? 'Лимит сохранён. Допуск автоперехода изолированных аккаунтов ещё не подтверждён; выберите продолжение вручную.' : attempted ? 'Оба исполнителя исчерпали доступную квоту. Автопереход остановлен.' : expired ? 'Достигнут общий предел 30 минут.' : 'Автопереход выключен.' : error;
          this.db.prepare('UPDATE execution_groups SET status=?,reason=? WHERE id=?').run(status === 'completed' ? 'completed' : status === 'stopped' ? 'stopped' : status === 'interrupted' ? 'interrupted' : 'waiting', reason, run.groupId);
          if (workflow) {
            this.db.prepare('UPDATE workflows SET status=? WHERE groupId=?').run(status === 'stopped' ? 'stopped' : status === 'interrupted' ? 'interrupted' : 'waiting', run.groupId);
            if (status === 'completed') {
              this.db.prepare("UPDATE execution_groups SET status='waiting',reason=? WHERE id=?").run(uncertain ? 'Команда не подтвердила завершение.' : 'Достигнут предел времени цепочки.', run.groupId);
              this.db.prepare("UPDATE tasks SET status='waiting' WHERE id=?").run(run.taskId);
            }
          }
          if (status === 'limited') this.event(run.taskId, 'route.waiting', { text: reason });
          if (!workflow && status === 'completed' && run.role === 'reviewer') this.db.prepare("UPDATE tasks SET status='review' WHERE id=?").run(run.taskId);
        }
      }
      if (previousGroup && !['active', 'switching'].includes(previousGroup.status)) this.db.prepare('UPDATE tasks SET status=? WHERE id=?').run(previousGroup.status === 'stopped' ? 'stopped' : previousGroup.status === 'interrupted' ? 'interrupted' : 'waiting', run.taskId);
      this.syncActiveStatus(run.taskId);
      this.db.exec('COMMIT');
    } catch (failure) { this.db.exec('ROLLBACK'); throw failure; }
  }

  endGroup(id: string, stopped: boolean, reason: string): void {
    const group = this.group(id);
    if (!['active', 'switching'].includes(group.status)) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE execution_groups SET status=?,reason=? WHERE id=?').run(stopped ? 'stopped' : 'waiting', reason, id);
      this.db.prepare("UPDATE transfers SET status=?,reason=? WHERE groupId=? AND status='pending'").run(stopped ? 'cancelled' : 'blocked', reason, id);
      this.db.prepare('UPDATE workflows SET status=? WHERE groupId=?').run(stopped ? 'stopped' : 'waiting', id);
      if (!this.activeRuns().some(run => run.groupId === id)) this.db.prepare('UPDATE tasks SET status=? WHERE id=?').run(stopped ? 'stopped' : 'waiting', group.taskId);
      this.event(group.taskId, stopped ? 'route.cancelled' : 'route.waiting', { text: reason });
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  private event(taskId: string, type: TaskEvent['type'], payload: TaskEvent['payload']): void {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO events (id,taskId,sequence,type,payload,createdAt)
      VALUES (?, ?, (SELECT COALESCE(MAX(sequence),0)+1 FROM events WHERE taskId=?), ?, ?, ?)`).run(randomUUID(), taskId, taskId, type, JSON.stringify(payload), now);
    this.db.prepare('UPDATE tasks SET updatedAt=? WHERE id=?').run(now, taskId);
  }

  private mutate(requestId: string, input: unknown, operation: () => TaskDetail): TaskDetail {
    const digest = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const previous = this.db.prepare('SELECT digest,result FROM requests WHERE id=?').get(requestId);
      if (previous) {
        if (previous.digest !== digest) throw new Error('Идентификатор запроса уже использован с другими данными.');
        const saved = JSON.parse(previous.result as string) as TaskDetail;
        const result = this.detail(saved.task.id);
        this.db.exec('COMMIT');
        return result;
      }
      const result = operation();
      this.db.prepare('INSERT INTO requests VALUES (?, ?, ?)').run(requestId, digest, JSON.stringify(result));
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  createTask(projectId: string, text: string, requestId: string): TaskDetail {
    return this.mutate(requestId, ['task.create', projectId, text], () => {
      this.project(projectId);
      const id = randomUUID(), now = new Date().toISOString();
      const title = text.trim().split('\n')[0]!.slice(0, 120);
      this.db.prepare('INSERT INTO tasks (id,projectId,title,status,createdAt,updatedAt) VALUES (?, ?, ?, ?, ?, ?)').run(id, projectId, title, 'draft', now, now);
      this.event(id, 'task.created', { title });
      this.event(id, 'message.created', { role: 'user', text });
      return this.detail(id);
    });
  }

  message(taskId: string, text: string, requestId: string): TaskDetail {
    return this.mutate(requestId, ['task.message', taskId, text], () => {
      this.requireEditable(taskId);
      this.event(taskId, 'message.created', { role: 'user', text });
      this.db.prepare('UPDATE acceptances SET stale=1 WHERE taskId=?').run(taskId);
      this.db.prepare('UPDATE verifications SET stale=1 WHERE taskId=?').run(taskId);
      if (this.detail(taskId).task.status === 'accepted') this.db.prepare("UPDATE tasks SET status='review' WHERE id=?").run(taskId);
      return this.detail(taskId);
    });
  }

  requireEditable(taskId: string): TaskDetail { const detail = this.detail(taskId); if (detail.task.archived) throw new Error('Задача в архиве. Сначала восстановите её.'); return detail; }
  private taskIdle(taskId: string): void {
    if (this.groups().some(group => group.taskId === taskId) || this.activeRuns().some(run => run.taskId === taskId) || this.activeChecks().some(check => check.taskId === taskId)) throw new Error('Сначала остановите активный запуск или проверку задачи.');
  }
  renameTask(taskId: string, title: string): TaskDetail {
    this.requireEditable(taskId); this.taskIdle(taskId);
    this.db.prepare('UPDATE tasks SET title=?,updatedAt=? WHERE id=?').run(title.trim(), new Date().toISOString(), taskId); return this.detail(taskId);
  }
  archiveTask(taskId: string, archived: boolean): TaskDetail {
    this.detail(taskId); this.taskIdle(taskId);
    this.db.prepare('UPDATE tasks SET archived=?,updatedAt=? WHERE id=?').run(Number(archived), new Date().toISOString(), taskId); return this.detail(taskId);
  }

}
