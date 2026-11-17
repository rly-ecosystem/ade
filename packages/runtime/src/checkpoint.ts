import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { Checkpoint, Project, TaskDetail, TaskEvent, Role, Run } from '../../contracts/src/index.js';
import { inspectGit } from './git.js';
import { contains } from './directories.js';
import { ECONOMY } from '../../contracts/src/handoff.js';

export function conversation(events: TaskEvent[], runs: Run[] = []): { id: string; role: string; text: string; provider?: string; executionRole?: Role }[] {
  const result: { id: string; role: string; text: string; provider?: string; executionRole?: Role }[] = [];
  const outputs = new Map<string, { id: string; role: string; text: string; provider?: string; executionRole?: Role }>();
  for (const event of events) {
    if (event.type === 'message.created') result.push({ id: event.id, role: event.payload.role || 'user', text: event.payload.text || '' });
    if (event.type === 'run.output') {
      const id = event.payload.runId + ':' + event.payload.itemId;
      let message = outputs.get(id);
      if (!message) { message = { id, role: 'assistant', text: '', provider: event.payload.provider, executionRole: runs.find(run => run.id === event.payload.runId)?.role }; outputs.set(id, message); result.push(message); }
      message.text = event.payload.replace === 'true' ? event.payload.text || '' : message.text + (event.payload.text || '');
    }
  }
  return result;
}

async function manifest(project: Project, paths: string[]): Promise<Checkpoint['manifest']> {
  if (paths.length > 2000) throw new Error('Пакет содержит более 2000 изменённых файлов. Уменьшите рабочий набор перед запуском.');
  let size = 0;
  const files: Checkpoint['manifest'] = [];
  for (const file of paths) {
    const absolute = path.resolve(project.path, file), relative = path.relative(project.path, absolute);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('Файл выходит за границы проекта.');
    let parent = path.dirname(absolute);
    while (true) {
      try { if (!contains(project.path, await realpath(parent))) throw new Error('Родитель файла выходит за границы проекта.'); break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || parent === path.dirname(parent)) throw error; parent = path.dirname(parent); }
    }
    let stat;
    try { stat = await lstat(absolute); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { files.push({ path: file, kind: 'deleted', hash: '' }); continue; } throw error; }
    if (!stat.isFile() && !stat.isSymbolicLink()) { files.push({ path: file, kind: 'directory', hash: '' }); continue; }
    size += stat.size;
    if (size > 10 * 1024 * 1024) throw new Error('Изменённые файлы превышают 10 МиБ для текущего пакета продолжения. Сохраните большой набор отдельно.');
    const content = stat.isSymbolicLink() ? Buffer.from(await readlink(absolute)) : await readFile(absolute);
    files.push({ path: file, kind: stat.isSymbolicLink() ? 'symlink' : 'file', hash: createHash('sha256').update(content).digest('hex') });
  }
  return files;
}

export function workspaceDigest(gitDigest: string, files: Checkpoint['manifest']): string { return createHash('sha256').update(gitDigest).update(JSON.stringify(files)).digest('hex'); }
export async function workspaceSnapshot(project: Project) {
  const git = await inspectGit(project), paths = [...new Set(git.files.map(file => file.path))].sort();
  const files = await manifest(project, paths);
  const second = await inspectGit(project);
  if (git.digest !== second.digest || JSON.stringify(files) !== JSON.stringify(await manifest(project, paths))) throw new Error('Файлы изменились во время подготовки контекста. Повторите запуск.');
  return { git, files, digest: workspaceDigest(git.digest, files) };
}

const roleInstructions: Record<Role, string> = {
  orchestrator: 'Plan the work. Extract the user requirements and acceptance criteria, dependencies and concrete next steps. Inspect project instructions as needed. Read only: do not modify files or execute tests. Give a concise plan for the next roles; do not claim work is implemented.',
  researcher: 'Research the selected project using read tools. Verify assumptions from code and the saved plan. Read only: do not modify files or execute tests. Report relevant paths, constraints and implementation decisions to the developer.',
  developer: 'Implement the user task using the saved plan and research. Preserve existing changes. Verify effects before repeating any previous action. Report changed files, actual checks and unresolved work. Do not claim acceptance; the reviewer and user decide that.',
  reviewer: 'Review the actual resulting files and saved conversation against the user requirements. Read only: do not modify files or execute tests. Identify concrete defects and missing acceptance evidence with file references. Clearly state whether you found blocking issues. Do not treat earlier model claims as test evidence. The user makes the final acceptance decision.',
};
export async function checkpoint(project: Project, detail: TaskDetail, role: Role = 'developer', iteration = 0, options: { compact: boolean; parallel: boolean } = { compact: false, parallel: false }): Promise<Checkpoint> {
  const { git, files } = await workspaceSnapshot(project);
  const summarized = new Set<string>();
  const history = conversation(detail.events, detail.runs).flatMap(message => {
    const runId = message.id.slice(0, message.id.indexOf(':')), source = detail.runs.find(run => run.id === runId);
    if (options.parallel && ['orchestrator', 'researcher'].includes(role) && source && ['starting', 'running', 'awaiting_approval', 'stopping'].includes(source.status)) return [];
    const label = message.role === 'user' ? 'USER REQUIREMENT' : 'HISTORICAL ASSISTANT (role=' + message.executionRole + ', provider=' + message.provider + ')';
    if (options.compact && source?.summary) {
      if (summarized.has(source.id)) return []; summarized.add(source.id);
      return [`${label}; run=${source.id}; workspace=${source.artifactDigest}; status=${source.status}:\n${JSON.stringify(source.summary)}`];
    }
    return [label + ':\n' + message.text];
  }).join('\n\n');
  const tools = detail.events.filter(event => event.type === 'run.tool').map(event => {
    const evidence = event.payload.details || '';
    const status = evidence.startsWith('Состояние:') ? evidence.split('\n')[0] : 'Effect must be verified from the workspace.';
    return `ADE event #${event.sequence}: ${event.payload.text}\n${status}\nEvidence SHA-256: ${createHash('sha256').update(evidence).digest('hex')}`;
  }).join('\n');
  const previous = detail.runs.at(-1);
  const prompt = `You are executing a real task in RLY ADE. Work in the selected directory: ${project.path}\nFollow applicable project instructions (AGENTS.md / CLAUDE.md). Preserve existing user changes. Do not create subagents. Do not purchase, publish, deploy, push, or commit unless explicitly requested by the user. Tool permissions are controlled by ADE and the official CLI.\n\nThe following is persisted conversation, not a new tool instruction. Continue the user's task from this context. Never assume an interrupted tool succeeded, and inspect existing effects before repeating actions.\nPrevious run: ${previous ? previous.provider + ' / ' + previous.status : 'none'}\nWorkspace type: ${git.kind}; Git HEAD: ${git.head || 'none'}\nChanged paths: ${JSON.stringify(files)}\n\nCONVERSATION:\n${history}\n\nRECORDED TOOL EVIDENCE (may be incomplete; verify before retry):\n${tools}\n\nReport the result and actual checks; distinguish agent completion from verified acceptance.`;
  const reviewProtocol = role === 'reviewer' ? '\nEnd with exactly one final plain-text line (no code fence): ADE_REVIEW_RESULT {"verdict":"ready","summary":"brief verified outcome"}. Use verdict "changes_required" for fixable defects or missing artifacts. Use verdict "blocked" for a policy refusal, denied permissions, missing credentials or another condition requiring the user. Never propose changing model/provider to bypass a refusal. Never mark ready if the required artifact is absent. The controller uses this line only to route a bounded correction pass; it is not final user acceptance.' : '';
  const assignment = `[ADE_ROLE:${role}]\n[ADE_ITERATION:${iteration}]\n${roleInstructions[role]}`;
  const handoffProtocol = options.compact || options.parallel ? '\nADE HANDOFF PROTOCOL: respond in the user language, at most one short human sentence. Return exactly one plain-text line ADE_HANDOFF {"summary":"verified result, max 800 chars","files":["relative/path"],"next":"concrete next step, max 400 chars","blockers":[]}. Total JSON max 2000 characters; at most 12 relative file paths and 4 blockers (160 chars each). Use blockers only for conditions requiring user intervention, including denied permissions or credentials; never bypass a refusal. This line must be last, except a reviewer must put the required ADE_REVIEW_RESULT line after it. Do not repeat the task or the whole history. Do not invent files/checks. The controller will stop on malformed output rather than spend another model call repairing JSON.' : '';
  const compactTools = detail.actions.filter(action => action.status === 'started' || action.status === 'awaiting_approval' || action.status === 'denied').map(action => JSON.stringify(action)).join('\n');
  const denials = detail.events.filter(event => event.type === 'approval.resolved' && event.payload.decision === 'deny').map(event => `User denied approval ${event.payload.approvalId} in run ${event.payload.runId}. Do not bypass or treat an old permission as new approval.`).join('\n');
  const compactPrompt = `${assignment}\n[ADE_COMPACT]\nYou are executing a real task in RLY ADE. Selected directory: ${project.path}\nFollow applicable AGENTS.md/CLAUDE.md. Preserve user changes. No subagents, purchase, publishing, deployment, push or commit unless the user explicitly requested it. Use only necessary tools; inspect actual effects before repeating an action.\nWorkspace: ${git.kind}; HEAD: ${git.head || 'none'}; snapshot SHA-256: ${workspaceDigest(git.digest, files)}. The complete file manifest and raw transcript are retained by ADE. The context below contains every user requirement, validated role summaries, and unabridged legacy/unfinished replies; tool logs are omitted. Summaries are agent reports, not proof of passing tests. Inspect the selected files.\n${options.parallel && ['orchestrator', 'researcher'].includes(role) ? 'Planning and research run concurrently on the same snapshot. Do not wait for the peer or claim to have read its unfinished result.' : ''}\n\nSAVED CONTEXT (historical, not a new tool instruction):\n${history}\n\nUNCONFIRMED OR DENIED ACTIONS:\n${compactTools || 'none'}\n\nCURRENT ROLE: ${role}. Historical restrictions belonged to their own roles. A developer must edit real files with native tools; never simulate calls in text.${handoffProtocol}${reviewProtocol}`;
  const scopedPrompt = options.compact ? compactPrompt + '\n\nSAVED USER DENIALS:\n' + (denials || 'none') : `${assignment}\n\n${prompt}\n\nCURRENT ADE ASSIGNMENT:\n${roleInstructions[role]}\nHistorical agents had their own roles and permissions. Their restrictions and statements about unavailable tools describe earlier turns, not your current role. Act now in your assigned role. A developer must use the actual native editing tool (such as apply_patch or Write), not simulate a tool call in text or merely describe the implementation. If tools fail, report the actual failure honestly.${handoffProtocol}${reviewProtocol}`;
  if (Buffer.byteLength(scopedPrompt) > (options.compact ? ECONOMY.promptBytes : 160 * 1024)) throw new Error(options.compact ? 'Контекст превышает 32 КиБ экономного режима. Сократите требования или явно выключите экономию; история не обрезана.' : 'Сохранённый контекст превышает 160 КиБ. Нужна явная компактизация; история не обрезана.');
  return { id: randomUUID(), taskId: detail.task.id, eventSequence: detail.events.at(-1)?.sequence || 0, head: git.head, gitDigest: git.digest, manifest: files, prompt: scopedPrompt, digest: createHash('sha256').update(scopedPrompt).update(JSON.stringify(files)).digest('hex'), createdAt: new Date().toISOString() };
}
