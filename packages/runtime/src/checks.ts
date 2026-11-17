import type { TaskDetail, Verification } from '../../contracts/src/index.js';
import { StringDecoder } from 'node:string_decoder';
import { clean, launch, processStamp, terminateGroup } from './processes.js';
import { workspaceSnapshot } from './checkpoint.js';
import { Store } from './store.js';
import type { RuntimeEvents } from './runner.js';

interface ActiveCheck { stop(): Promise<void>; done: Promise<void>; stopped: boolean; }
export class Checker {
  private active = new Map<string, ActiveCheck>();
  private closing = false;
  constructor(private store: Store, private events: RuntimeEvents) {}
  async recover(): Promise<void> {
    for (const check of this.store.activeChecks()) {
      try {
        if (check.pid) await terminateGroup(check.pid, check.processStamp);
        this.store.finishCheck(check.id, 'interrupted', null, 'Проверка прервана после сбоя. Автоматический повтор команды не выполняется.');
      } catch (error) { this.store.checkStopping(check.id, clean((error as Error).message)); }
    }
  }
  async start(taskId: string, command: string, requestId: string): Promise<TaskDetail> {
    if (this.closing) throw new Error('Приложение завершает работу.');
    if (this.store.replayCheck(requestId, taskId, command)) return this.store.detail(taskId);
    const detail = this.store.detail(taskId), project = this.store.project(detail.task.projectId), sequence = this.store.messageSequence(taskId);
    const before = await workspaceSnapshot(project);
    if (this.closing) throw new Error('Приложение завершает работу.');
    if (this.store.replayCheck(requestId, taskId, command)) return this.store.detail(taskId);
    const check = this.store.beginCheck(taskId, command, requestId, before.digest, sequence);
    let child: ReturnType<typeof launch>;
    try { child = launch('/bin/bash', ['--noprofile', '--norc', '-o', 'pipefail', '-c', command], project.path); }
    catch (error) { this.store.finishCheck(check.id, 'failed', null, clean((error as Error).message)); this.events.changed(taskId); return this.store.detail(taskId); }
    const exited = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    void exited.catch(() => {});
    const pid = child.pid, stamp = pid ? processStamp(pid) : null;
    let output = '', bytes = 0, failure = '', stopPromise: Promise<void> | null = null;
    const current: ActiveCheck = {
      stopped: false, done: Promise.resolve(),
      stop: () => {
        if (!stopPromise) stopPromise = (async () => { if (pid) await terminateGroup(pid, stamp, true); })().catch(error => { stopPromise = null; throw error; });
        return stopPromise;
      },
    };
    this.active.set(check.id, current);
    if (pid && stamp) { this.store.checkProcess(check.id, pid, stamp); this.events.process(check.id, pid, stamp); }
    else { failure = 'Не удалось зарегистрировать процесс проверки.'; child.kill('SIGKILL'); }
    const flush = () => { this.store.checkOutput(check.id, output); this.events.changed(taskId); };
    const stdout = new StringDecoder('utf8'), stderr = new StringDecoder('utf8');
    const append = (chunk: Buffer, decoder: StringDecoder) => {
      bytes += chunk.length;
      if (bytes > 256 * 1024) { failure = 'Вывод проверки превысил 256 КиБ. Частичный лог сохранён.'; void current.stop().catch(error => { failure = clean(error.message); }); return; }
      output = clean(output + decoder.write(chunk), 256 * 1024);
    };
    child.stdout.on('data', chunk => append(chunk, stdout)); child.stderr.on('data', chunk => append(chunk, stderr));
    current.done = (async () => {
      let code: number | null = null, safe = false;
      const interval = setInterval(flush, 180);
      const deadline = setTimeout(() => { failure = 'Достигнут предел проверки 5 минут.'; void current.stop().catch(error => { failure = clean(error.message); }); }, 5 * 60 * 1000);
      try {
        if (failure) await current.stop();
        code = await exited;
      } catch (error) { failure = clean((error as Error).message); }
      finally {
        clearInterval(interval); clearTimeout(deadline);
        try { await current.stop(); safe = true; } catch (error) { failure = clean((error as Error).message); this.store.checkStopping(check.id, failure); }
        output = clean(output + stdout.end() + stderr.end(), 256 * 1024); flush();
        if (safe) {
          let stale = false;
          if (!current.stopped && code === 0 && !failure) {
            try { stale = (await workspaceSnapshot(project)).digest !== before.digest; if (stale) failure = 'Файлы изменились во время проверки. Повторите её для новой версии.'; }
            catch (error) { failure = clean((error as Error).message); stale = true; }
          }
          if (this.store.messageSequence(taskId) !== sequence) { stale = true; failure = 'Требования изменились во время проверки. Повторите её после обработки уточнения.'; }
          const status: Verification['status'] = current.stopped ? 'stopped' : code === 0 && !failure ? 'passed' : 'failed';
          this.store.finishCheck(check.id, status, code, current.stopped ? 'Проверка остановлена пользователем.' : failure || (code === 0 ? '' : 'Команда завершилась с кодом ' + code + '.'), stale);
          this.events.processGone(check.id); this.active.delete(check.id);
        }
        this.events.changed(taskId);
      }
    })();
    void current.done.catch(() => this.events.changed(taskId));
    this.events.changed(taskId); return this.store.detail(taskId);
  }
  async stop(id: string): Promise<TaskDetail> {
    const check = this.store.check(id), current = this.active.get(id);
    if (['running', 'stopping'].includes(check.status)) {
      this.store.checkStopping(id); this.events.changed(check.taskId);
      if (current) {
        current.stopped = true; await current.stop(); await current.done;
        if (['running', 'stopping'].includes(this.store.check(id).status)) { this.store.finishCheck(id, 'stopped', null, 'Проверка остановлена.'); this.events.processGone(id); this.active.delete(id); }
      }
      else {
        if (check.pid) await terminateGroup(check.pid, check.processStamp);
        this.store.finishCheck(id, 'interrupted', null, 'Проверка остановлена после восстановления.');
      }
    }
    return this.store.detail(check.taskId);
  }
  async verify(taskId: string): Promise<TaskDetail> {
    const detail = this.store.detail(taskId);
    if (this.store.groups().some(group => group.taskId === taskId)) return detail;
    try { return this.store.refreshEvidence(taskId, (await workspaceSnapshot(this.store.project(detail.task.projectId))).digest); }
    catch (error) { this.store.refreshEvidence(taskId, 'unavailable'); throw error; }
  }
  async accept(taskId: string, note: string): Promise<TaskDetail> {
    const detail = this.store.detail(taskId), snapshot = await workspaceSnapshot(this.store.project(detail.task.projectId));
    this.store.refreshEvidence(taskId, snapshot.digest);
    return this.store.accept(taskId, snapshot.digest, note);
  }
  async shutdown(): Promise<void> { this.closing = true; await Promise.all([...this.active.keys()].map(id => this.stop(id))); }
}
