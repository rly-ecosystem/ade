import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { realpathSync, existsSync } from 'node:fs';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Provider, ProviderStatus, RunStatus, LimitInfo, ToolAction } from '../../contracts/src/index.js';
import { executable, cliEnvironment, launch, jsonLines, processStamp, terminateGroup, clean } from './processes.js';
import { tokenUsage } from './usage.js';
import type { TokenUsage } from '../../contracts/src/handoff.js';

const exec = promisify(execFile);
function inside(cwd: string, requested: unknown): boolean {
  if (typeof requested !== 'string') return false;
  let target = path.resolve(cwd, requested);
  while (!existsSync(target) && target !== path.dirname(target)) target = path.dirname(target);
  try { const relative = path.relative(realpathSync(cwd), realpathSync(target)); return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); } catch { return false; }
}
export interface Callbacks {
  process(pid: number, stamp: string): void;
  session(id: string): void;
  output(itemId: string, text: string, replace: boolean): void;
  tool(title: string, details: string): void;
  approval(id: string, kind: string, title: string, details: string): void;
  action(action: Omit<ToolAction, 'runId'>): void;
  usage?(usage: TokenUsage): void;
}
export interface Adapter {
  run(prompt: string): Promise<{ status: Extract<RunStatus, 'completed' | 'failed' | 'limited'>; error: string; limit?: LimitInfo }>;
  respond(id: string, allow: boolean): void;
  stop(): Promise<void>;
}

export async function probe(provider: Provider, environment?: NodeJS.ProcessEnv, siwc = false): Promise<ProviderStatus> {
  const status: ProviderStatus = { provider, installed: false, authenticated: false, version: '', reason: '' };
  try {
    const binary = executable(provider); status.installed = true;
    const env = cliEnvironment(binary, environment);
    status.version = clean((await exec(binary, ['--version'], { env, timeout: 10000, maxBuffer: 65536 })).stdout, 100).trim();
    if (provider === 'codex' && siwc) status.authenticated = true;
    else if (provider === 'codex') {
      const result = await exec(binary, ['login', 'status'], { env, timeout: 10000, maxBuffer: 65536 });
      status.authenticated = /logged in using chatgpt/i.test(result.stdout + result.stderr);
    } else {
      const result = JSON.parse((await exec(binary, ['auth', 'status', '--json'], { env, timeout: 10000, maxBuffer: 65536 })).stdout);
      status.authenticated = result.loggedIn === true && result.authMethod === 'claude.ai' && result.apiProvider === 'firstParty';
    }
    status.reason = status.authenticated ? 'Текущий вход CLI · квота неизвестна' : 'Нужен подписочный вход в официальном CLI. API-резерв выключен.';
  } catch (error) { status.reason = status.installed ? 'Не удалось подтвердить подписочный вход CLI. Выполните вход и обновите подключения.' : clean((error as Error).message); }
  return status;
}

export function adapter(provider: Provider, cwd: string, model: string, cb: Callbacks, readOnly = false, economy = false, auth?: { accountsRoot?: string; environment?: NodeJS.ProcessEnv; accessToken?: string }): Adapter {
  const redact = (value: string) => auth?.accessToken ? value.split(auth.accessToken).join('[credential]') : value;
  if (auth?.accessToken) {
    const sink = cb;
    cb = { ...sink, output: (id, text, replace) => sink.output(id, redact(text), replace), tool: (text, details) => sink.tool(redact(text), redact(details)), approval: (id, kind, title, details) => sink.approval(id, kind, redact(title), redact(details)), action: value => sink.action({ ...value, description: redact(value.description) }) };
  }
  const binary = executable(provider);
  let child: ChildProcessWithoutNullStreams | null = null, stamp: string | null = null, stopping = false, stopPromise: Promise<void> | null = null;
  const responses = new Map<string, (allow: boolean) => void>();
  let rejectRun: (error: Error) => void = () => {};
  let diagnostic = '';
  const start = (args: string[]) => {
    if (stopping) throw new Error('Запуск остановлен до старта CLI.');
    child = launch(binary, args, cwd, auth?.accessToken ? { ...auth.environment, ACCESS_TOKEN: auth.accessToken } : auth?.environment);
    if (!child.pid) throw new Error('Не удалось запустить CLI.');
    stamp = processStamp(child.pid);
    if (!stamp) { child.kill('SIGKILL'); throw new Error('Не удалось зарегистрировать процесс исполнителя.'); }
    cb.process(child.pid, stamp);
    child.stderr.on('data', chunk => { diagnostic = clean(diagnostic + chunk.toString(), 4000); });
    child.on('error', error => rejectRun(error));
    return child;
  };
  const write = (value: unknown) => { if (!child?.stdin.writable) throw new Error('Канал CLI закрыт.'); child.stdin.write(JSON.stringify(value) + '\n'); };
  const response = (id: string, kind: string, title: string, details: string, reply: (allow: boolean) => void) => {
    if (details.length > 16000 || details.includes('[Вывод сокращён по пределу размера.]')) { reply(false); cb.tool('Слишком большой запрос отклонён', 'Запрос нельзя показать целиком в пределах 16000 символов.'); return; }
    responses.set(id, reply); cb.approval(id, kind, title, clean(details));
  };

  return {
    respond(id, allow) { const reply = responses.get(id); if (!reply) throw new Error('Запрос разрешения уже неактуален.'); responses.delete(id); reply(allow); },
    stop() {
      if (!stopPromise) stopPromise = (async () => {
        stopping = true;
        for (const reply of responses.values()) { try { reply(false); } catch {} } responses.clear();
        if (child?.pid) await terminateGroup(child.pid, stamp, true);
      })().catch(error => { stopPromise = null; throw error; });
      return stopPromise;
    },
    async run(prompt) {
      type Result = { status: 'completed' | 'failed' | 'limited'; error: string; limit?: LimitInfo };
      let settle: (result: Result) => void;
      const completed = new Promise<Result>((resolve, reject) => { settle = resolve; rejectRun = reject; });
      void completed.catch(() => {});
      const fail = (error: Error) => rejectRun(error);
      if (provider === 'codex') {
        const plan = auth?.accessToken ? ['-c', 'model_provider="openai_chatgpt_plan"', '-c', 'model_providers.openai_chatgpt_plan.name="ChatGPT plan"', '-c', 'model_providers.openai_chatgpt_plan.base_url="https://api.openai.com/v1"', '-c', 'model_providers.openai_chatgpt_plan.env_key="ACCESS_TOKEN"', '-c', 'model_providers.openai_chatgpt_plan.wire_api="responses"', '-c', 'model_providers.openai_chatgpt_plan.requires_openai_auth=false', '-c', 'model_providers.openai_chatgpt_plan.supports_websockets=false', '-c', 'shell_environment_policy.exclude=["ACCESS_TOKEN"]'] : [];
        const parentProfile = readOnly ? ':read-only' : ':workspace';
        const permissionId = 'ade_' + randomUUID().replaceAll('-', '');
        const permissions = auth?.accountsRoot ? ['-c', 'default_permissions=' + JSON.stringify(permissionId), '-c',
          'permissions.' + permissionId + '={extends=' + JSON.stringify(parentProfile) + ',filesystem={' + JSON.stringify(auth.accountsRoot) + '="deny"}}'] : [];
        const p = start(['app-server', '--disable', 'hooks', '--disable', 'plugins', '--disable', 'apps', '--disable', 'multi_agent', ...plan, ...permissions]);
        let sequence = 0, terminal = false;
        const fileChanges = new Map<string, string>();
        const pending = new Map<number, { resolve: (result: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
        const call = (method: string, params: unknown): Promise<any> => new Promise((resolve, reject) => {
          const id = ++sequence;
          const timer = setTimeout(() => { pending.delete(id); reject(new Error('CLI не подтвердил ' + method)); }, 30000);
          pending.set(id, { resolve, reject, timer }); write({ id, method, params });
        });
        p.once('close', () => {
          for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('Codex завершился до подтверждения операции.')); } pending.clear();
          if (!terminal) fail(new Error(stopping ? 'Запуск остановлен.' : 'Codex завершился без turn/completed. ' + diagnostic));
        });
        jsonLines(p, message => {
          if (message.id != null && !message.method) {
            const item = pending.get(message.id); if (!item) return;
            clearTimeout(item.timer); pending.delete(message.id);
            message.error ? item.reject(new Error(clean(message.error.message))) : item.resolve(message.result); return;
          }
          const params = message.params || {};
          if (message.method === 'thread/tokenUsage/updated') { const usage = tokenUsage('codex', params.tokenUsage?.total); if (usage) cb.usage?.(usage); }
          if (message.id != null) {
            if (message.method === 'item/commandExecution/requestApproval' || message.method === 'item/fileChange/requestApproval') {
              if (readOnly) { write({ id: message.id, result: { decision: 'decline' } }); cb.tool('Роль работает только на чтение', 'Запрос изменения или расширения доступа отклонён.'); return; }
              const file = message.method.includes('fileChange');
              const bounded = (!params.grantRoot || inside(cwd, params.grantRoot)) && (!params.cwd || inside(cwd, params.cwd)) && !params.additionalPermissions;
              const details = file ? (fileChanges.get(params.itemId) || params.reason || params.grantRoot || 'CLI не передал diff. Разрешение будет отклонено.') : [params.command, params.cwd, params.reason].filter(Boolean).join('\n');
              if (!bounded) { write({ id: message.id, result: { decision: 'decline' } }); cb.tool('Отклонён доступ вне проекта', clean(details)); return; }
              const itemId = String(params.itemId || message.id), kind = file ? 'file' : 'command';
              cb.action({ itemId, kind, status: 'awaiting_approval', description: clean(details, 300) });
              response(String(message.id), kind, file ? 'Изменение файлов' : 'Команда Codex', details, allow => {
                const accepted = allow && (!file || fileChanges.has(params.itemId));
                cb.action({ itemId, kind, status: accepted ? 'started' : 'denied', description: clean(details, 300) });
                write({ id: message.id, result: { decision: accepted ? 'accept' : 'decline' } });
              });
            } else { write({ id: message.id, error: { code: -32601, message: 'ADE does not support this request. Ask the user in a normal message.' } }); cb.tool('Неподдержанный запрос Codex', clean(message.method)); }
            return;
          }
          if (message.method === 'item/agentMessage/delta') cb.output(String(params.itemId), clean(params.delta, 64000), false);
          if (message.method === 'item/started' && params.item?.type === 'fileChange') fileChanges.set(params.item.id, clean(JSON.stringify(params.item.changes)));
          if (message.method === 'item/started' && ['commandExecution', 'fileChange'].includes(params.item?.type)) cb.action({ itemId: String(params.item.id), kind: params.item.type === 'commandExecution' ? 'command' : 'file', status: 'started', description: clean(params.item.command || 'Изменение файлов', 300) });
          if (message.method === 'item/completed') {
            const item = params.item || {};
            if (['commandExecution', 'fileChange'].includes(item.type)) cb.action({ itemId: String(item.id), kind: item.type === 'commandExecution' ? 'command' : 'file', status: 'finished', description: clean(item.command || 'Изменение файлов', 300) });
            if (item.type === 'agentMessage') cb.output(String(item.id), clean(item.text, 128000), true);
            else if (item.type === 'commandExecution') cb.tool(clean(item.command, 200), clean('Состояние: ' + item.status + ' · код ' + item.exitCode + '\n' + (item.aggregatedOutput || '')));
            else if (item.type === 'fileChange') cb.tool('Изменения файлов', clean('Состояние: ' + item.status + '\n' + JSON.stringify(item.changes)));
          }
          if (message.method === 'turn/completed') {
            terminal = true; const turn = params.turn || {};
            const limited = turn.status !== 'completed' && turn.error?.codexErrorInfo === 'usageLimitExceeded';
            settle!({ status: turn.status === 'completed' ? 'completed' : limited ? 'limited' : 'failed', error: clean(turn.error?.message || (turn.status === 'completed' ? '' : turn.status)), ...(limited ? { limit: { source: 'codex.usageLimitExceeded' as const } } : {}) });
          }
        }, fail);
        try {
          await call('initialize', { clientInfo: { name: auth?.accessToken ? 'RLY ADE' : 'rly_ade', title: 'RLY ADE', version: '0.6.1' }, capabilities: { experimentalApi: !!auth?.accountsRoot, requestAttestation: false } });
          write({ method: 'initialized' });
          if (!auth?.accessToken) { const account = await call('account/read', { refreshToken: false }); if (account.account?.type !== 'chatgpt') throw new Error('Подписочный вход Codex недоступен. Платный API выключен.'); }
          const config = await call('config/read', { includeLayers: false, cwd });
          const overrides: Record<string, unknown> = {};
          for (const name of Object.keys(config.config?.mcp_servers || {})) overrides['mcp_servers.' + name + '.enabled'] = false;
          const thread = await call('thread/start', { cwd, approvalPolicy: readOnly ? 'never' : 'untrusted', ...(auth?.accountsRoot ? { permissions: permissionId } : { sandbox: readOnly ? 'read-only' : 'workspace-write' }), ephemeral: true, config: overrides, ...(model ? { model } : {}) });
          if (auth?.accountsRoot && (thread.activePermissionProfile?.id !== permissionId || thread.activePermissionProfile?.extends !== parentProfile)) throw new Error('Codex не подтвердил защиту каталога аккаунтов. Обновите Codex CLI.');
          cb.session(thread.thread.id);
          await call('turn/start', { threadId: thread.thread.id, input: [{ type: 'text', text: prompt, text_elements: [] }], ...(economy ? { effort: 'low' } : {}) });
        } catch (error) { fail(error as Error); }
      } else {
        const settings = JSON.stringify({ sandbox: { enabled: true, autoAllowBashIfSandboxed: false, allowUnsandboxedCommands: false, failIfUnavailable: true, excludedCommands: [], filesystem: { denyRead: ['~/.ssh', '~/.aws', '~/.codex/auth.json', '~/.claude/.credentials.json', ...(auth?.accountsRoot ? [auth.accountsRoot] : [])] } } });
        const p = start(['-p', '--safe-mode', '--settings', settings, '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-mode', 'manual', '--permission-prompt-tool', 'stdio', '--tools', readOnly ? 'Read,Glob,Grep' : 'Read,Glob,Grep,Edit,Write,Bash', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--no-chrome', ...(model ? ['--model=' + model] : [])]);
        let terminal = false, messageId = 'assistant', initialized = false, fatal = false;
        let limit: LimitInfo | undefined;
        p.once('close', () => { if (!terminal) fail(new Error(stopping ? 'Запуск остановлен.' : 'Claude завершился без итогового result. ' + diagnostic)); });
        jsonLines(p, message => {
          if (message.type === 'control_response' && message.response?.request_id === 'ade-init') {
            if (message.response.subtype !== 'success') { fail(new Error(clean(message.response.error))); return; }
            if (!initialized) { initialized = true; write({ type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null, session_id: '' }); }
          } else if (message.type === 'control_request') {
            const request = message.request || {};
            if (request.subtype !== 'can_use_tool') { write({ type: 'control_response', response: { subtype: 'error', request_id: message.request_id, error: 'Unsupported control request' } }); return; }
            if (readOnly && !['Read', 'Glob', 'Grep'].includes(request.tool_name)) {
              write({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: { behavior: 'deny', message: 'This ADE role is read-only. Only Read, Glob and Grep are allowed.' } } }); cb.tool('Роль работает только на чтение', clean(request.tool_name)); return;
            }
            const requestedPath = request.input?.file_path ?? request.input?.path;
            if (requestedPath && !inside(cwd, requestedPath)) {
              write({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: { behavior: 'deny', message: 'ADE project boundary: access outside selected repository is not allowed.' } } });
              cb.tool('Отклонён доступ вне проекта', clean(requestedPath)); return;
            }
            const itemId = String(request.tool_use_id || message.request_id), kind = request.tool_name === 'Bash' ? 'command' : ['Edit', 'Write'].includes(request.tool_name) ? 'file' : 'read';
            cb.action({ itemId, kind, status: 'awaiting_approval', description: clean(request.tool_name, 100) });
            response(message.request_id, 'tool', clean(request.tool_name, 100), clean(JSON.stringify(request.input)), allow => {
              cb.action({ itemId, kind, status: allow ? 'started' : 'denied', description: clean(request.tool_name, 100) });
              write({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: allow ? { behavior: 'allow', updatedInput: request.input } : { behavior: 'deny', message: 'Пользователь ADE отклонил действие.' } } });
            });
          } else if (message.type === 'system' && message.subtype === 'init') cb.session(clean(message.session_id, 128));
          else if (message.type === 'stream_event') {
            const event = message.event || {};
            if (event.type === 'message_start') messageId = event.message?.id || messageId;
            if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') cb.output(messageId, clean(event.delta.text, 64000), false);
          } else if (message.type === 'assistant') {
            if (message.error === 'rate_limit') limit = { source: 'claude.rate_limit' };
            else if (message.error) { fatal = true; limit = undefined; }
            const value = message.message || {};
            const text = (value.content || []).filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n');
            if (text) cb.output(value.id || messageId, clean(text, 128000), true);
            for (const part of value.content || []) if (part.type === 'tool_use') {
              cb.action({ itemId: part.id, kind: part.name === 'Bash' ? 'command' : ['Edit', 'Write'].includes(part.name) ? 'file' : 'read', status: 'started', description: clean(part.name, 100) });
              cb.tool('Запрошен ' + clean(part.name, 100), clean(JSON.stringify(part.input)));
            }
          } else if (message.type === 'user') {
            for (const part of message.message?.content || []) if (part.type === 'tool_result') {
              cb.action({ itemId: part.tool_use_id, kind: 'read', status: 'finished', description: 'Результат инструмента' });
              cb.tool(part.is_error ? 'Ошибка инструмента' : 'Результат инструмента', clean(typeof part.content === 'string' ? part.content : JSON.stringify(part.content)));
            }
          } else if (message.type === 'system' && message.subtype === 'api_retry') {
            cb.tool('Claude повторяет запрос', clean(JSON.stringify({ attempt: message.attempt, retryDelayMs: message.retry_delay_ms, status: message.error_status, error: message.error })));
          } else if (message.type === 'rate_limit_event') {
            cb.tool('Сведения об ограничении Claude', clean(JSON.stringify(message.rate_limit_info || {})));
            const info = message.rate_limit_info;
            if (!fatal && info?.status === 'rejected') {
              const reset = typeof info.resetsAt === 'number' && Number.isFinite(info.resetsAt) && info.resetsAt > 0 && info.resetsAt < 8640000000000 ? new Date(info.resetsAt * 1000).toISOString() : undefined;
              limit = { source: 'claude.rate_limit_event', ...(reset ? { resetAt: reset } : {}) };
              terminal = true; settle!({ status: 'limited', error: 'Подтверждён лимит Claude.', limit });
            }
          } else if (message.type === 'result') {
            const usage = tokenUsage('claude', message.usage); if (usage) cb.usage?.(usage);
            terminal = true;
            const success = message.subtype === 'success' && message.is_error !== true;
            const error = clean((message.errors || []).join('\n') || message.result || message.subtype);
            settle!({ status: success ? 'completed' : limit && !fatal ? 'limited' : 'failed', error: success ? '' : error, ...(limit && !fatal && !success ? { limit } : {}) });
          }
        }, fail);
        write({ type: 'control_request', request_id: 'ade-init', request: { subtype: 'initialize', hooks: null } });
      }
      try { const result = await completed; return { ...result, error: redact(result.error) }; }
      catch (error) { throw new Error(redact((error as Error).message)); }
    },
  };
}
