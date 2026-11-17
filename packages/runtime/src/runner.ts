import type { Provider, RunStatus, TaskDetail, LimitInfo, Transfer, Role } from '../../contracts/src/index.js';
import { ACTIVE_RUNS } from '../../contracts/src/index.js';
import { adapter, probe, type Adapter } from './adapters.js';
import { checkpoint, workspaceSnapshot, workspaceDigest, conversation } from './checkpoint.js';
import { terminateGroup, clean } from './processes.js';
import { reviewVerdict } from './review.js';
import { ECONOMY, parseHandoff, type HandoffReport } from '../../contracts/src/handoff.js';
import { Store } from './store.js';
import { overlaps } from './directories.js';
import { Profiles, type ProfileLease } from './profiles.js';
import { SHARED_PROFILES } from '../../contracts/src/accounts.js';

export interface RuntimeEvents {
  changed(taskId: string): void;
  process(runId: string, pid: number, stamp: string): void;
  processGone(runId: string): void;
}
const silent: RuntimeEvents = { changed() {}, process() {}, processGone() {} };
interface Active { driver: Adapter; permissions: Map<string, string>; done: Promise<void>; stopped: boolean; release(): void; }

export class Runner {
  private active = new Map<string, Active>();
  private transferring = new Set<string>();
  private stopping = new Map<string, Promise<void>>();
  private closing = false;
  constructor(private store: Store, private events: RuntimeEvents = silent, private profiles?: Profiles) {}

  async recover(): Promise<void> {
    for (const run of this.store.activeRuns()) {
      try {
        if (run.pid) await terminateGroup(run.pid, run.processStamp);
        this.store.finishRun(run.id, 'interrupted', 'Предыдущий runtime завершился. Прогресс сохранён; проверьте незавершённые действия перед продолжением.');
      } catch (error) { this.store.state(run.id, 'stopping'); this.store.stoppingError(run.id, clean((error as Error).message)); }
    }
    for (const transfer of this.store.pendingTransfers()) void this.advance(transfer);
    for (const workflow of this.store.pendingWorkflows()) void this.advanceWorkflow(workflow.groupId);
    for (const group of this.store.groups()) if (group.status === 'active' && !this.store.activeRuns().some(run => run.groupId === group.id) && !this.store.pendingWorkflows().some(workflow => workflow.groupId === group.id) && !this.store.pendingTransfers().some(transfer => transfer.groupId === group.id)) this.store.endGroup(group.id, false, 'Восстановление: нет активного исполнителя. Продолжите задачу вручную.');
  }

  startWorkflow(taskId: string, requestId: string): TaskDetail {
    if (this.closing) throw new Error('Приложение завершает работу.');
    const detail = this.store.startWorkflow(taskId, requestId, this.profiles?.snapshot());
    if (detail.workflow?.status === 'pending') void this.advanceWorkflow(detail.workflow.groupId);
    this.events.changed(taskId); return detail;
  }
  private async advanceWorkflow(groupId: string): Promise<void> {
    const workflow = this.store.workflow(groupId);
    if (!workflow || !['pending', 'running'].includes(workflow.status) || this.closing) return;
    const key = 'workflow:' + groupId;
    if (this.transferring.has(key)) return;
    this.transferring.add(key);
    try {
      const steps = workflow.parallel && workflow.stepIndex < 2 ? workflow.steps.slice(0, 2) : [workflow.steps[workflow.stepIndex]!];
      const results = await Promise.allSettled(steps.map(async step => {
        const existing = this.store.detail(workflow.taskId).runs.filter(run => run.groupId === groupId && run.role === step.role && run.iteration === workflow.iteration);
        if (existing.length) return;
        await this.execute(workflow.taskId, step.provider, step.model, 'role:' + groupId + ':' + step.role + ':' + workflow.iteration, groupId, step.role);
      }));
      const rejected = results.find(result => result.status === 'rejected');
      if (rejected?.status === 'rejected') throw rejected.reason;
    } catch (error) { await this.abort(groupId, 'Роль ожидает: ' + clean((error as Error).message)); }
    finally {
      this.transferring.delete(key); this.events.changed(workflow.taskId);
      if (!this.closing && this.store.pendingWorkflows().some(item => item.groupId === groupId && item.status === 'pending')) void this.advanceWorkflow(groupId);
    }
  }
  async stopWorkflow(groupId: string): Promise<TaskDetail> {
    const workflow = this.store.workflow(groupId); if (!workflow) throw new Error('Цепочка не найдена.');
    this.store.endGroup(groupId, true, 'Цепочка остановлена пользователем. Контекст сохранён.');
    await this.stopMembers(groupId);
    this.events.changed(workflow.taskId); return this.store.detail(workflow.taskId);
  }

  private async advance(transfer: Transfer): Promise<void> {
    if (this.closing || this.transferring.has(transfer.id)) return;
    this.transferring.add(transfer.id);
    const group = this.store.group(transfer.groupId);
    try {
      const task = this.store.detail(group.taskId).task;
      await this.execute(group.taskId, transfer.toProvider, transfer.toProvider === 'codex' ? task.codexModel : task.claudeModel, 'transfer:' + transfer.id, group.id, this.store.run(transfer.fromRunId).role);
    } catch (error) { await this.abort(group.id, 'Продолжение ожидает: ' + clean((error as Error).message)); }
    finally { this.transferring.delete(transfer.id); this.events.changed(group.taskId); }
  }

  async execute(taskId: string, provider: Provider, model: string, requestId: string, groupId?: string, requestedRole: Role = 'developer'): Promise<TaskDetail> {
    if (this.closing) throw new Error('Приложение завершает работу.');
    const workflow = groupId ? this.store.workflow(groupId) : null, role = workflow?.parallel && workflow.stepIndex < 2 ? requestedRole : workflow?.steps[workflow.stepIndex]?.role || requestedRole;
    if (this.store.replayRun(requestId, taskId, provider, model, role)) return this.store.detail(taskId);
    const detail = this.store.detail(taskId), project = this.store.project(detail.task.projectId);
    const compact = workflow?.economy ?? detail.task.economy;
    this.store.requireEditable(taskId);
    if (!project.trusted) throw new Error('Подтвердите доверие проекту перед запуском.');
    if (this.profiles && overlaps(project.path, this.profiles.root)) throw new Error('Выберите рабочую папку отдельно от каталога аккаунтов ADE.');
    const bindings = groupId ? this.store.group(groupId).profiles || SHARED_PROFILES : this.profiles?.snapshot() || SHARED_PROFILES;
    const assigned = (workflow?.steps || (requestedRole === 'reviewer' ? detail.task.rolePlan : null))?.find(step => step.role === role && step.provider === provider)?.profileId;
    const profileId = assigned || bindings[provider] || SHARED_PROFILES[provider];
    let lease: ProfileLease | undefined;
    if (this.profiles) lease = await this.profiles.acquire(profileId, provider);
    else { const status = await probe(provider); if (!status.authenticated) throw new Error(status.reason); }
    try {
    const packet = await checkpoint(project, detail, role, workflow?.iteration || 0, { compact, parallel: !!workflow?.parallel });
    const replay = this.store.replayRun(requestId, taskId, provider, model, role);
    if (replay) { lease?.release(); return this.store.detail(taskId); }
    if (this.closing) throw new Error('Приложение завершает работу.');
    const run = this.store.beginRun(taskId, provider, model, requestId, packet, groupId, role, profileId, bindings);
    const permissions = new Map<string, string>();
    const buffers = new Map<string, string>();
    let outputBytes = 0;
    const sizes = new Map<string, number>();
    const flush = () => { for (const [itemId, text] of buffers) this.store.appendRun(run.id, 'run.output', { itemId, text, replace: 'false' }); buffers.clear(); this.events.changed(taskId); };
    let driver: Adapter;
    try { driver = adapter(provider, project.path, model, {
      process: (pid, stamp) => { this.store.process(run.id, pid, stamp); this.events.process(run.id, pid, stamp); },
      session: id => { this.store.session(run.id, id); this.store.state(run.id, 'running'); this.events.changed(taskId); },
      output: (itemId, text, replace) => {
        const before = sizes.get(itemId) || 0, after = (replace ? 0 : before) + Buffer.byteLength(text); sizes.set(itemId, after); outputBytes += after - before;
        if (outputBytes > (compact ? ECONOMY.outputBytes : 2 * 1024 * 1024)) throw new Error(compact ? 'Достигнут предел ответа 64 КиБ экономного режима. Прогресс сохранён.' : 'Превышен предел сохраняемого ответа 2 МиБ.');
        if (replace) { buffers.delete(itemId); this.store.appendRun(run.id, 'run.output', { itemId, text, replace: 'true' }); this.events.changed(taskId); }
        else buffers.set(itemId, (buffers.get(itemId) || '') + text);
      },
      tool: (text, details) => { this.store.appendRun(run.id, 'run.tool', { text, details }); this.events.changed(taskId); },
      action: action => this.store.action({ ...action, runId: run.id }),
      usage: usage => { this.store.usage(run.id, usage); this.events.changed(taskId); },
      approval: (wireId, kind, title, details) => {
        if (this.active.get(run.id)?.stopped) { driver.respond(wireId, false); return; }
        flush();
        const request = this.store.approval(run.id, kind, title, details); permissions.set(request.id, wireId); this.events.changed(taskId);
      },
    }, role !== 'developer', compact, lease); } catch (error) { this.store.finishRun(run.id, 'failed', clean((error as Error).message)); this.events.changed(taskId); throw error; }
    const current: Active = { driver, permissions, done: Promise.resolve(), stopped: false, release: lease?.release || (() => {}) };
    this.active.set(run.id, current);
    current.done = Promise.resolve().then(async () => {
      let final: RunStatus = 'failed', reason = '', stoppedSafely = false, limit: LimitInfo | null = null;
      const interval = setInterval(() => { if (buffers.size) flush(); }, 180);
      let deadline: ReturnType<typeof setTimeout>;
      try {
        const duration = Math.min(15 * 60 * 1000, Date.parse(this.store.group(run.groupId!).deadlineAt) - Date.now(), lease?.expiresAt ? lease.expiresAt - Date.now() - 10000 : Infinity);
        const result = await Promise.race([driver.run(packet.prompt), new Promise<never>((_resolve, reject) => { deadline = setTimeout(() => reject(new Error('Достигнут предел времени запуска. Прогресс сохранён.')), Math.max(1, duration)); })]);
        final = result.status; reason = result.error; limit = result.limit || null;
      } catch (error) { reason = clean((error as Error).message); }
      finally {
        clearInterval(interval); clearTimeout(deadline!);
        try { await driver.stop(); stoppedSafely = true; }
        catch (error) { reason = clean((error as Error).message); this.store.state(run.id, 'stopping'); }
        flush();
        if (stoppedSafely) {
          lease?.release();
          let artifactDigest: string | null = null;
          let summary: HandoffReport | null = null;
          if (!current.stopped && final === 'completed') {
            try {
              artifactDigest = (await workspaceSnapshot(project)).digest;
              if (role !== 'developer' && artifactDigest !== workspaceDigest(packet.gitDigest, packet.manifest)) throw new Error('Файлы изменились во время роли на чтение. Требуется повторное ревью текущей версии.');
            } catch (error) { final = 'failed'; reason = clean((error as Error).message); artifactDigest = null; }
          }
          flush();
          const answer = conversation(this.store.detail(taskId).events).filter(message => message.id.startsWith(run.id + ':')).map(message => message.text).join('\n');
          const verdict = role === 'reviewer' ? reviewVerdict(answer) : null;
          if (!current.stopped && final === 'completed' && (compact || workflow?.parallel)) {
            summary = parseHandoff(answer, role === 'reviewer');
            if (!summary) { final = 'failed'; reason = 'Исполнитель не вернул корректную короткую передачу. Автоматическое исправление формата не запускается.'; }
            else if (summary.blockers.length && (role !== 'reviewer' || verdict === 'ready')) { final = 'failed'; reason = 'Требуется решение пользователя: ' + summary.blockers.join('; '); }
          }
          this.store.finishRun(run.id, current.stopped ? 'stopped' : final, current.stopped ? 'Остановлено пользователем. Проверьте незавершённые действия перед продолжением.' : reason, current.stopped ? null : limit, artifactDigest, verdict, summary);
          this.events.processGone(run.id); this.active.delete(run.id);
        } else this.store.stoppingError(run.id, reason);
        this.events.changed(taskId);
        if (stoppedSafely && !['active', 'switching'].includes(this.store.group(run.groupId!).status)) await this.stopMembers(run.groupId!);
        if (stoppedSafely && !current.stopped) {
          const transfer = this.store.pendingTransfers().find(item => item.fromRunId === run.id);
          if (transfer) void this.advance(transfer);
          else if (this.store.pendingWorkflows().some(item => item.groupId === run.groupId)) void this.advanceWorkflow(run.groupId!);
        }
      }
    });
    void current.done.catch(() => { this.events.changed(taskId); });
    this.events.changed(taskId);
    return this.store.detail(taskId);
    } catch (error) { lease?.release(); throw error; }
  }

  async stop(runId: string): Promise<TaskDetail> {
    const original = this.store.run(runId);
    if (original.groupId) this.store.endGroup(original.groupId, true, 'Автопереход отменён пользователем.');
    if (original.groupId) await this.stopMembers(original.groupId);
    else await this.stopMember(original.id);
    this.events.changed(original.taskId); return this.store.detail(original.taskId);
  }
  private async stopMembers(groupId: string): Promise<void> {
    const results = await Promise.allSettled(this.store.activeRuns().filter(run => run.groupId === groupId).map(run => this.stopMember(run.id)));
    const failed = results.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  }
  private async abort(groupId: string, reason: string): Promise<void> {
    this.store.endGroup(groupId, false, reason);
    try { await this.stopMembers(groupId); }
    catch (error) { for (const run of this.store.activeRuns().filter(run => run.groupId === groupId)) this.store.stoppingError(run.id, clean((error as Error).message)); }
  }
  private stopMember(runId: string): Promise<void> {
    const pending = this.stopping.get(runId); if (pending) return pending;
    const stopping = this.stopMemberNow(runId).finally(() => this.stopping.delete(runId));
    this.stopping.set(runId, stopping); return stopping;
  }
  private async stopMemberNow(runId: string): Promise<void> {
    const run = this.store.run(runId);
    const current = this.active.get(runId);
    if (!ACTIVE_RUNS.includes(run.status)) return;
    this.store.state(runId, 'stopping'); this.events.changed(run.taskId);
    try { if (current) {
      current.stopped = true; await current.driver.stop(); await current.done;
      if (ACTIVE_RUNS.includes(this.store.run(runId).status)) { this.store.finishRun(runId, 'stopped', 'Процесс остановлен.'); this.events.processGone(runId); this.active.delete(runId); current.release(); }
    }
    else {
      if (run.pid) await terminateGroup(run.pid, run.processStamp);
      this.store.finishRun(runId, 'interrupted', 'Процесс остановлен после восстановления.');
    } } catch (error) { if (ACTIVE_RUNS.includes(this.store.run(runId).status)) this.store.stoppingError(runId, clean((error as Error).message)); throw error; }
    finally { this.events.changed(run.taskId); }
  }

  respond(runId: string, approvalId: string, decision: 'allow' | 'deny'): TaskDetail {
    const run = this.store.run(runId), saved = this.store.approvalById(approvalId);
    if (saved.runId !== runId) throw new Error('Разрешение относится к другому запуску.');
    if (saved.status === decision) return this.store.detail(run.taskId);
    const current = this.active.get(runId), wire = current?.permissions.get(approvalId);
    if (!current || current.stopped || !wire || saved.status !== 'pending') throw new Error('Этот запрос уже неактуален.');
    this.store.resolveApproval(runId, approvalId, decision);
    current.driver.respond(wire, decision === 'allow'); current.permissions.delete(approvalId);
    this.events.changed(run.taskId); return this.store.detail(run.taskId);
  }

  async shutdown(): Promise<void> {
    this.closing = true;
    for (const group of this.store.groups()) this.store.endGroup(group.id, true, 'Приложение закрыто. Контекст сохранён.');
    await Promise.all([...this.active.keys()].map(id => this.stop(id)));
    while (this.transferring.size) await new Promise(resolve => setTimeout(resolve, 20));
  }
}
