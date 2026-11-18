import { validProfileId } from './accounts.js';
export interface Project {
  id: string;
  name: string;
  path: string;
  createdAt: string;
  trusted: boolean;
  parentId: string | null;
  kind: 'repository' | 'directory';
  hasChildren: boolean;
  childrenLoaded: boolean;
  missing: boolean;
  scanError: string | null;
}

export type Provider = 'codex' | 'claude';
export type RunStatus = 'starting' | 'running' | 'awaiting_approval' | 'stopping' | 'completed' | 'failed' | 'stopped' | 'interrupted' | 'limited';
export type TaskStatus = 'draft' | 'waiting' | 'switching' | 'checking' | 'review' | 'accepted' | RunStatus;
export const ROLES = ['orchestrator', 'researcher', 'developer', 'reviewer'] as const;
export type Role = typeof ROLES[number];
export const ROLE_LABELS: Record<Role, string> = { orchestrator: 'Планирование', researcher: 'Исследование', developer: 'Разработка', reviewer: 'Ревью' };
export interface RoleStep { role: Role; provider: Provider; model: string; profileId?: string; }
export interface Workflow { groupId: string; taskId: string; steps: RoleStep[]; stepIndex: number; iteration: number; status: 'pending' | 'running' | 'waiting' | 'stopped' | 'interrupted' | 'ready'; parallel: boolean; economy: boolean; baseDigest: string | null; inputSequence: number; }
export interface Handoff { id: string; groupId: string; fromRunId: string; toRole: Role; iteration: number; createdAt: string; recipients: string[]; }
export interface Verification { id: string; taskId: string; groupId: string; runId: string | null; command: string; status: 'running' | 'stopping' | 'passed' | 'failed' | 'stopped' | 'interrupted'; output: string; exitCode: number | null; startedAt: string; endedAt: string | null; pid: number | null; processStamp: string | null; workspaceDigest: string; messageSequence: number; stale: boolean; error: string; }
export interface Acceptance { taskId: string; runId: string; workspaceDigest: string; messageSequence: number; note: string; mode: 'checked' | 'manual'; createdAt: string; stale: boolean; }
export interface LimitInfo { source: 'codex.usageLimitExceeded' | 'claude.rate_limit_event' | 'claude.rate_limit'; resetAt?: string; }
export interface ExecutionGroup { id: string; taskId: string; projectId: string; scopeRoot: string; status: 'active' | 'switching' | 'completed' | 'waiting' | 'stopped' | 'interrupted'; startedAt: string; deadlineAt: string; reason: string; profiles?: import('./accounts.js').ProfileBindings; }
export interface Transfer { id: string; groupId: string; fromRunId: string; toProvider: Provider; status: 'pending' | 'started' | 'blocked' | 'cancelled'; toRunId: string | null; reason: string; }
export interface ToolAction { runId: string; itemId: string; kind: 'command' | 'file' | 'read'; status: 'started' | 'awaiting_approval' | 'finished' | 'denied'; description: string; }
export const ACTIVE_RUNS: RunStatus[] = ['starting', 'running', 'awaiting_approval', 'stopping'];
export interface ProviderStatus { provider: Provider; installed: boolean; authenticated: boolean; version: string; reason: string; profileId?: string; profileName?: string; }
export interface Run {
  id: string; taskId: string; projectId: string; provider: Provider; model: string; effectiveModel: string | null; status: RunStatus;
  generation: number; requestId: string; checkpointId: string; startedAt: string; endedAt: string | null;
  pid: number | null; processStamp: string | null; sessionId: string | null; error: string | null;
  groupId: string | null; limit: LimitInfo | null; profileId?: string | null;
  role: Role; artifactDigest: string | null;
  iteration: number; reviewVerdict: 'ready' | 'changes_required' | 'blocked' | null;
  compact: boolean; promptBytes: number; summary: import('./handoff.js').HandoffReport | null; usage: import('./handoff.js').TokenUsage | null;
}
export interface Approval { id: string; runId: string; kind: string; title: string; details: string; status: 'pending' | 'allow' | 'deny' | 'stale'; }
export interface Checkpoint {
  id: string; taskId: string; eventSequence: number; head: string | null; gitDigest: string;
  manifest: { path: string; hash: string; kind: string }[]; prompt: string; digest: string; createdAt: string;
}
export const STATUS_LABELS: Record<TaskStatus, string> = {
  draft: 'Черновик', waiting: 'Ожидает продолжения', starting: 'Запускается', running: 'Выполняется',
  awaiting_approval: 'Нужно разрешение', stopping: 'Останавливается', completed: 'Шаг завершён',
  failed: 'Ошибка выполнения', stopped: 'Остановлена', interrupted: 'Прервана после сбоя', limited: 'Лимит провайдера',
  switching: 'Передача резервному исполнителю',
  checking: 'Выполняется проверка', review: 'Ожидает приёмки', accepted: 'Результат принят',
};

export interface Task {
  id: string;
  projectId: string;
  title: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  autoSwitch: boolean;
  codexModel: string;
  claudeModel: string;
  rolePlan: RoleStep[] | null;
  archived: boolean;
  parallel: boolean;
  economy: boolean;
}

export interface TaskEvent {
  id: string;
  taskId: string;
  sequence: number;
  type: 'task.created' | 'message.created' | 'execution.blocked' | 'run.started' | 'run.output' | 'run.tool' | 'run.status' | 'run.finished' | 'approval.requested' | 'approval.resolved' | 'checkpoint.created' | 'route.switching' | 'route.waiting' | 'route.cancelled' | 'action.updated' | 'workflow.status' | 'check.status' | 'acceptance.updated' | 'handoff.created' | 'handoff.received' | 'run.usage';
  payload: Record<string, string>;
  createdAt: string;
}

export interface TaskDetail {
  task: Task;
  events: TaskEvent[];
  runs: Run[];
  approvals: Approval[];
  group: ExecutionGroup | null;
  transfers: Transfer[];
  actions: ToolAction[];
  workflow: Workflow | null;
  checks: Verification[];
  acceptance: Acceptance | null;
  handoffs: Handoff[];
}

export function hasPassingChecks(detail: TaskDetail): boolean {
  const run = detail.runs.at(-1);
  if (run?.role === 'reviewer' && run.reviewVerdict !== 'ready') return false;
  const runId = detail.runs.at(-1)?.id, latest = new Map<string, Verification>();
  for (const check of detail.checks) if (check.runId === runId && !check.stale) latest.set(check.command, check);
  return latest.size > 0 && [...latest.values()].every(check => check.status === 'passed');
}

export interface Bootstrap {
  schemaVersion: 7;
  projects: Project[];
  tasks: Task[];
  execution: { available: boolean; reason: string };
}

export interface GitSnapshot {
  projectId: string;
  head: string | null;
  branch: string;
  files: { path: string; status: string; previousPath?: string }[];
  staged: string;
  unstaged: string;
  digest: string;
  capturedAt: string;
  kind: 'git' | 'directory';
  repositoryRoot: string | null;
}

export interface RequestMap {
  'usage.sources': { params: Record<string, never>; result: import('./device-usage.js').UsageSource[] };
  'usage.device': { params: { period: import('./insights.js').InsightPeriod }; result: import('./device-usage.js').DeviceUsage };
  'usage.quota': { params: { profileId: string }; result: import('./device-usage.js').PlanQuota };
  'usage.insights': { params: { period: import('./insights.js').InsightPeriod; projectId: string | null }; result: import('./insights.js').UsageInsights };
  bootstrap: { params: Record<string, never>; result: Bootstrap };
  'task.create': { params: { projectId: string; text: string; requestId: string }; result: TaskDetail };
  'task.get': { params: { taskId: string }; result: TaskDetail };
  'task.message': { params: { taskId: string; text: string; requestId: string }; result: TaskDetail };
  'task.execute': { params: { taskId: string; requestId: string; provider: Provider; model: string }; result: TaskDetail };
  'providers.status': { params: Record<string, never>; result: ProviderStatus[] };
  'profiles.list': { params: Record<string, never>; result: import('./accounts.js').AccountProfiles };
  'profile.create': { params: { provider: Provider; name: string; requestId: string }; result: import('./accounts.js').AccountProfiles };
  'profile.rename': { params: { profileId: string; name: string }; result: import('./accounts.js').AccountProfiles };
  'profile.select': { params: { profileId: string }; result: import('./accounts.js').AccountProfiles };
  'profile.enable': { params: { profileId: string; enabled: boolean }; result: import('./accounts.js').AccountProfiles };
  'profile.check': { params: { profileId: string }; result: import('./accounts.js').AccountProfiles };
  'profile.logout': { params: { profileId: string }; result: import('./accounts.js').AccountProfiles };
  'profile.cancel': { params: { profileId: string }; result: import('./accounts.js').AccountProfiles };
  'profile.code': { params: { profileId: string; code: string }; result: import('./accounts.js').AccountProfiles };
  'profile.welcome': { params: { profileId: string }; result: import('./accounts.js').AccountProfiles };
  'runtime.health': { params: Record<string, never>; result: { pid: number } };
  'project.trust': { params: { projectId: string; trusted: boolean }; result: Project };
  'project.children': { params: { projectId: string }; result: Project[] };
  'task.route': { params: { taskId: string; enabled: boolean; codexModel: string; claudeModel: string }; result: TaskDetail };
  'task.roles': { params: { taskId: string; steps: RoleStep[] }; result: TaskDetail };
  'task.workflow': { params: { taskId: string; parallel: boolean; economy: boolean }; result: TaskDetail };
  'workflow.start': { params: { taskId: string; requestId: string }; result: TaskDetail };
  'workflow.stop': { params: { groupId: string }; result: TaskDetail };
  'check.start': { params: { taskId: string; command: string; requestId: string }; result: TaskDetail };
  'check.stop': { params: { checkId: string }; result: TaskDetail };
  'task.verify': { params: { taskId: string }; result: TaskDetail };
  'task.accept': { params: { taskId: string; note: string }; result: TaskDetail };
  'task.review': { params: { taskId: string; requestId: string }; result: TaskDetail };
  'task.rename': { params: { taskId: string; title: string }; result: TaskDetail };
  'task.archive': { params: { taskId: string; archived: boolean }; result: TaskDetail };
  'run.stop': { params: { runId: string; requestId: string }; result: TaskDetail };
  'run.respond': { params: { runId: string; approvalId: string; decision: 'allow' | 'deny'; requestId: string }; result: TaskDetail };
  'git.inspect': { params: { projectId: string }; result: GitSnapshot };
}

export type Method = keyof RequestMap;
export type RuntimeRequest = { [K in Method]: { method: K; params: RequestMap[K]['params'] } }[Method];
export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export interface DesktopAPI {
  call<K extends Method>(method: K, params: RequestMap[K]['params']): Promise<Result<RequestMap[K]['result']>>;
  pickProject(): Promise<Result<Project | null>>;
  copyText(text: string): Promise<Result<void>>;
  openExternal(url: string): Promise<Result<void>>;
  signInProfile(profileId: string): Promise<Result<void>>;
  onChange(listener: (taskId: string) => void): () => void;
}

export const EXECUTION_UNAVAILABLE = 'Резерв между Codex и Claude используется только при подтверждённом лимите. Платный API выключен.';

const fields: Record<Method, string[]> = {
  'usage.sources': [],
  'usage.device': ['period'],
  'usage.quota': ['profileId'],
  'usage.insights': ['period', 'projectId'],
  bootstrap: [],
  'task.create': ['projectId', 'text', 'requestId'],
  'task.get': ['taskId'],
  'task.message': ['taskId', 'text', 'requestId'],
  'task.execute': ['taskId', 'requestId', 'provider', 'model'],
  'providers.status': [],
  'profiles.list': [],
  'profile.create': ['provider', 'name', 'requestId'],
  'profile.rename': ['profileId', 'name'],
  'profile.select': ['profileId'],
  'profile.enable': ['profileId', 'enabled'],
  'profile.check': ['profileId'],
  'profile.logout': ['profileId'],
  'profile.cancel': ['profileId'],
  'profile.code': ['profileId', 'code'],
  'profile.welcome': ['profileId'],
  'runtime.health': [],
  'project.trust': ['projectId', 'trusted'],
  'project.children': ['projectId'],
  'task.route': ['taskId', 'enabled', 'codexModel', 'claudeModel'],
  'task.roles': ['taskId', 'steps'],
  'task.workflow': ['taskId', 'parallel', 'economy'],
  'workflow.start': ['taskId', 'requestId'],
  'workflow.stop': ['groupId'],
  'check.start': ['taskId', 'command', 'requestId'],
  'check.stop': ['checkId'],
  'task.verify': ['taskId'],
  'task.accept': ['taskId', 'note'],
  'task.review': ['taskId', 'requestId'],
  'task.rename': ['taskId', 'title'],
  'task.archive': ['taskId', 'archived'],
  'run.stop': ['runId', 'requestId'],
  'run.respond': ['runId', 'approvalId', 'decision', 'requestId'],
  'git.inspect': ['projectId'],
};

export function parseRequest(input: unknown): RuntimeRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Некорректный запрос.');
  const { method, params } = input as Record<string, unknown>;
  if (typeof method !== 'string' || !Object.hasOwn(fields, method)) throw new Error('Неизвестная операция.');
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('Некорректные параметры.');
  const expected = fields[method as Method];
  const values = params as Record<string, unknown>;
  if (Object.keys(values).length !== expected.length || expected.some(key => !Object.hasOwn(values, key))) throw new Error('Некорректные параметры.');
  for (const key of expected) {
    const value = values[key];
    if (key === 'period') { if (value !== 7 && value !== 30) throw new Error('Выберите период 7 или 30 дней.'); continue; }
    if (method === 'usage.insights' && key === 'projectId' && value === null) continue;
    if (key === 'steps') {
      if (!Array.isArray(value) || value.length !== ROLES.length || value.some((step, i) => !step || typeof step !== 'object' || Object.keys(step).some(key => !['role', 'provider', 'model', 'profileId'].includes(key)) || step.profileId !== undefined && !validProfileId(step.profileId) || step.role !== ROLES[i] || !['codex', 'claude'].includes(step.provider) || typeof step.model !== 'string' || step.model.length > 100 || step.model && !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(step.model))) throw new Error('Нужны четыре роли с исполнителем и моделью.');
      continue;
    }
    if (key === 'profileId') { if (!validProfileId(value) && !(method === 'usage.quota' && typeof value === 'string' && /^cli-[a-f0-9]{24}$/.test(value))) throw new Error('Некорректный профиль.'); continue; }
    if (key === 'name') { if (typeof value !== 'string' || !value.trim() || value.trim().length > 40 || /[\r\n\0]/.test(value)) throw new Error('Укажите название профиля, до 40 символов.'); continue; }
    if (key === 'code') { if (typeof value !== 'string' || !value.trim() || value.length > 8192 || /[\r\n\0]/.test(value)) throw new Error('Некорректный код входа.'); continue; }
    if (key === 'note') { if (typeof value !== 'string' || value.includes('\0') || value.length > 2000) throw new Error('Некорректное пояснение.'); continue; }
    if (key === 'command') { if (typeof value !== 'string' || !value.trim() || value.includes('\0') || value.length > 4000) throw new Error('Укажите команду проверки, до 4000 символов.'); continue; }
    if (key === 'trusted' || key === 'enabled' || key === 'archived' || key === 'parallel' || key === 'economy') { if (typeof value !== 'boolean') throw new Error('Некорректный переключатель.'); continue; }
    if (key === 'title') { if (typeof value !== 'string' || !value.trim() || value.length > 120 || /[\r\n\0]/.test(value)) throw new Error('Название должно содержать от 1 до 120 символов в одной строке.'); continue; }
    if (key === 'model' || key === 'codexModel' || key === 'claudeModel') { if (typeof value !== 'string' || value.length > 100 || (value && !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(value))) throw new Error('Некорректная модель.'); continue; }
    if (typeof value !== 'string' || !value.trim() || value.includes('\0') || value.length > (key === 'text' ? 32000 : 128)) throw new Error('Некорректное поле: ' + key);
    if (key === 'provider' && !['codex', 'claude'].includes(value)) throw new Error('Неизвестный исполнитель.');
    if (key === 'decision' && !['allow', 'deny'].includes(value)) throw new Error('Некорректное решение.');
  }
  return { method, params } as RuntimeRequest;
}
