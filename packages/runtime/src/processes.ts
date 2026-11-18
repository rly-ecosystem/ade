import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { accessSync, constants, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { Provider } from '../../contracts/src/index.js';

function findExecutable(provider: Provider | 'node'): string {
  const folders = (process.env.PATH || '').split(path.delimiter).filter(item => path.isAbsolute(item));
  folders.push('/opt/homebrew/bin', '/usr/local/bin', path.join(homedir(), '.local/bin'));
  const nvm = path.join(homedir(), '.nvm/versions/node');
  try { for (const version of readdirSync(nvm).filter(name => /^v\d+\.\d+\.\d+$/.test(name)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))) folders.push(path.join(nvm, version, 'bin')); } catch {}
  for (const folder of folders) {
    const candidate = path.join(folder, provider);
    try { accessSync(candidate, constants.X_OK); return candidate; } catch {}
  }
  throw new Error('Не найден официальный CLI ' + provider + '. Установите его и обновите подключения.');
}

export function executable(provider: Provider): string { return findExecutable(provider); }
export function nodeExecutable(): string {
  const binary = findExecutable('node');
  const version = execFileSync(binary, ['--version'], { encoding: 'utf8', timeout: 3000 }).trim();
  const [, major, minor] = /^v(\d+)\.(\d+)/.exec(version) || [];
  if (Number(major) < 22 || Number(major) === 22 && Number(minor) < 13 || !major) throw new Error('Для локального ядра нужен Node.js 22.13 или новее.');
  return binary;
}

export function sharedClaudeConfigDir(): string | undefined {
  const first = process.env.CLAUDE_CONFIG_DIR?.split(',').map(dir => dir.trim()).find(Boolean);
  return first ? path.resolve(first) : undefined;
}

export function cliEnvironment(binary: string, isolated?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = ['HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'XDG_CONFIG_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR'];
  const env: NodeJS.ProcessEnv = {};
  for (const key of allowed) if (process.env[key] && !(isolated && ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME'].includes(key))) env[key] = process.env[key];
  if (isolated) Object.assign(env, isolated);
  else if (path.basename(binary) === 'claude' && env.CLAUDE_CONFIG_DIR) {
    const primary = sharedClaudeConfigDir();
    if (primary) env.CLAUDE_CONFIG_DIR = primary;
    else delete env.CLAUDE_CONFIG_DIR;
  }
  env.PATH = [path.dirname(binary), path.dirname(process.execPath), ...(process.env.PATH || '').split(path.delimiter), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].join(path.delimiter);
  env.NO_COLOR = '1';
  return env;
}

export function processStamp(pid: number): string | null {
  try {
    const value = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'pgid='], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return value && Number(value.match(/(\d+)$/)?.[1]) === pid ? value : null;
  } catch { return null; }
}

function groupAlive(pid: number): boolean {
  const output = execFileSync('/bin/ps', ['-axo', 'pgid=,stat='], { encoding: 'utf8', timeout: 2000, maxBuffer: 1024 * 1024 });
  return output.split('\n').some(line => { const [group, state] = line.trim().split(/\s+/); return Number(group) === pid && state && !state.startsWith('Z'); });
}

export async function terminateGroup(pid: number, stamp: string | null, knownGroup = false): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid < 2) throw new Error('Некорректный процесс исполнителя.');
  const current = processStamp(pid);
  if (!current && !groupAlive(pid)) return;
  if (current ? !stamp || current !== stamp : !knownGroup) throw new Error('Нельзя подтвердить принадлежность процесса ADE. Новый запуск заблокирован.');
  const signal = (name: NodeJS.Signals) => { try { process.kill(-pid, name); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; } };
  signal('SIGTERM');
  await new Promise(resolve => setTimeout(resolve, 700));
  signal('SIGKILL');
  for (let attempt = 0; attempt < 12; attempt++) {
    if (!groupAlive(pid)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Не удалось подтвердить остановку дерева процессов. Новый запуск заблокирован.');
}

export function launch(binary: string, args: string[], cwd: string, environment?: NodeJS.ProcessEnv): ChildProcessWithoutNullStreams {
  return spawn(binary, args, { cwd, env: cliEnvironment(binary, environment), detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
}

export function jsonLines(child: ChildProcessWithoutNullStreams, receive: (message: Record<string, any>) => void, fail: (error: Error) => void): void {
  const decoder = new StringDecoder('utf8');
  let buffer = '', bytes = 0, failed = false;
  child.stdout.on('data', (chunk: Buffer) => {
    if (failed) return;
    bytes += chunk.length;
    buffer += decoder.write(chunk);
    if (bytes > 8 * 1024 * 1024 || buffer.length > 1024 * 1024) { failed = true; fail(new Error('Превышен предел вывода исполнителя. Прогресс сохранён.')); return; }
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let value;
      try {
        value = JSON.parse(line);
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid object');
      } catch { failed = true; fail(new Error('Неизвестный формат ответа CLI. Обновите адаптер.')); return; }
      try { receive(value); } catch (error) { failed = true; fail(error instanceof Error ? error : new Error('Ошибка обработки события CLI.')); return; }
    }
  });
}

export function clean(value: unknown, limit = 16000): string {
  const text = String(value ?? '').replace(/\x1b\[[0-9;]*m/g, '').replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g, '[скрыто]');
  return text.length > limit ? text.slice(0, limit) + '\n[Вывод сокращён по пределу размера.]' : text;
}
