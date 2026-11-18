import { parseRequest, type RuntimeRequest } from '../../contracts/src/index.js';
import { DeviceHistory } from './device-history.js';
import { Store } from './store.js';
import { inspectGit } from './git.js';
import { canonicalDirectory, childDirectories, describeDirectory } from './directories.js';
import { Runner, type RuntimeEvents } from './runner.js';
import { probe } from './adapters.js';
import { Checker } from './checks.js';
import path from 'node:path';
import { Profiles } from './profiles.js';
import type { SIWCOptions } from './siwc.js';

export class Runtime {
  readonly store: Store;
  private history = new DeviceHistory();
  readonly runner: Runner;
  readonly checker: Checker;
  readonly profiles: Profiles;
  private shutdownPromise: Promise<void> | null = null;
  constructor(filename: string, events?: RuntimeEvents, options: { siwc?: SIWCOptions } = {}) {
    this.store = new Store(filename);
    const callbacks = events || { changed() {}, process() {}, processGone() {} };
    this.profiles = new Profiles(path.dirname(filename), callbacks, options.siwc);
    this.runner = new Runner(this.store, callbacks, this.profiles); this.checker = new Checker(this.store, callbacks);
  }
  async initialize(): Promise<void> {
    for (const project of this.store.bootstrap().projects.filter(item => !item.parentId)) {
      try { await this.children(project.id); } catch { /* Scan errors are saved on the project for retry. */ }
    }
    await this.checker.recover(); await this.runner.recover();
  }
  shutdown(): Promise<void> {
    if (!this.shutdownPromise) this.shutdownPromise = this.runner.shutdown().then(() => this.checker.shutdown()).then(() => this.profiles.close()).then(() => { this.store.close(); });
    return this.shutdownPromise;
  }
  close(): void { this.store.close(); }
  async addProject(directory: string) {
    const project = this.store.addProject(await canonicalDirectory(directory));
    await this.children(project.id); return this.store.project(project.id);
  }
  private async children(id: string) {
    const project = this.store.project(id);
    try { return this.store.syncDirectory(id, await describeDirectory(project.path), await childDirectories(project.path)); }
    catch (error) { this.store.scanFailed(id, (error as Error).message); throw error; }
  }
  async call(input: unknown) {
    const request: RuntimeRequest = parseRequest(input);
    switch (request.method) {
      case 'usage.sources': return (await this.profiles.externalHomes()).map(({ profileId: id, name, provider }) => ({ id, name, provider }));
      case 'usage.quota': return this.profiles.quota(request.params.profileId);
      case 'usage.device': {
        const now = new Date();
        const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - request.params.period + 1);
        return this.history.read(await this.profiles.historyRoots(), request.params.period, this.store.measuredRuns(start), now);
      }
      case 'usage.insights': return this.store.insights(request.params.period, request.params.projectId);
      case 'bootstrap': return this.store.bootstrap();
      case 'task.create': return this.store.createTask(request.params.projectId, request.params.text, request.params.requestId);
      case 'task.get': return this.store.detail(request.params.taskId);
      case 'task.message': return this.store.message(request.params.taskId, request.params.text, request.params.requestId);
      case 'task.execute': return this.runner.execute(request.params.taskId, request.params.provider, request.params.model, request.params.requestId);
      case 'providers.status': return this.profiles.selectedStatus();
      case 'profiles.list': return this.profiles.list();
      case 'profile.create': return this.profiles.create(request.params.provider, request.params.name, request.params.requestId);
      case 'profile.rename': return this.profiles.rename(request.params.profileId, request.params.name);
      case 'profile.select': return this.profiles.select(request.params.profileId);
      case 'profile.enable': return this.profiles.enable(request.params.profileId, request.params.enabled);
      case 'profile.check': return this.profiles.check(request.params.profileId);
      case 'profile.logout': return this.profiles.logout(request.params.profileId);
      case 'profile.cancel': return this.profiles.cancel(request.params.profileId);
      case 'profile.code': return this.profiles.code(request.params.profileId, request.params.code);
      case 'profile.welcome': return this.profiles.welcome(request.params.profileId);
      case 'runtime.health': return { pid: process.pid };
      case 'project.trust': return this.store.trust(request.params.projectId, request.params.trusted);
      case 'project.children': return this.children(request.params.projectId);
      case 'task.route': return this.store.configureRoute(request.params.taskId, request.params.enabled, request.params.codexModel, request.params.claudeModel);
      case 'task.roles': for (const step of request.params.steps) if (step.profileId) this.profiles.assertProvider(step.profileId, step.provider); return this.store.configureRoles(request.params.taskId, request.params.steps);
      case 'task.workflow': return this.store.configureWorkflow(request.params.taskId, request.params.parallel, request.params.economy);
      case 'workflow.start': return this.runner.startWorkflow(request.params.taskId, request.params.requestId);
      case 'workflow.stop': return this.runner.stopWorkflow(request.params.groupId);
      case 'check.start': return this.checker.start(request.params.taskId, request.params.command, request.params.requestId);
      case 'check.stop': return this.checker.stop(request.params.checkId);
      case 'task.verify': return this.checker.verify(request.params.taskId);
      case 'task.accept': return this.checker.accept(request.params.taskId, request.params.note);
      case 'task.review': {
        const task = this.store.detail(request.params.taskId).task, step = task.rolePlan?.find(item => item.role === 'reviewer');
        const provider = step?.provider || this.store.detail(task.id).runs.at(-1)?.provider || 'codex';
        const model = step?.model ?? (provider === 'codex' ? task.codexModel : task.claudeModel);
        return this.runner.execute(task.id, provider, model, request.params.requestId, undefined, 'reviewer');
      }
      case 'task.rename': return this.store.renameTask(request.params.taskId, request.params.title);
      case 'task.archive': return this.store.archiveTask(request.params.taskId, request.params.archived);
      case 'run.stop': return this.runner.stop(request.params.runId);
      case 'run.respond': return this.runner.respond(request.params.runId, request.params.approvalId, request.params.decision);
      case 'git.inspect': return inspectGit(this.store.project(request.params.projectId));
    }
  }
}
