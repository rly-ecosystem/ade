import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath, lstat } from 'node:fs/promises';
import path from 'node:path';
import { canonicalDirectory, directoryFiles } from './directories.js';
import { createHash } from 'node:crypto';
import type { GitSnapshot, Project } from '../../contracts/src/index.js';

const exec = promisify(execFile);

async function git(directory: string, args: string[]): Promise<string> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  try {
    const result = await exec('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-C', directory, ...args], {
      env: { ...env, GIT_TERMINAL_PROMPT: '0' }, timeout: 10000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8',
    });
    return result.stdout;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new Error('Git не найден. Установите Command Line Tools и повторите.');
    throw new Error('Не удалось прочитать Git-репозиторий. Проверьте путь и доступ; предел вывода 2 МиБ, время 10 с.');
  }
}

export async function repositoryRoot(directory: string): Promise<string> {
  if (typeof directory !== 'string' || !directory || directory.includes('\0')) throw new Error('Некорректный каталог.');
  const canonical = await realpath(directory);
  if ((await git(canonical, ['rev-parse', '--is-inside-work-tree'])).trim() !== 'true') throw new Error('Выберите рабочий Git-репозиторий.');
  return realpath((await git(canonical, ['rev-parse', '--show-toplevel'])).trim());
}

export function parseStatus(output: string): GitSnapshot['files'] {
  const records = output.split('\0');
  const files: GitSnapshot['files'] = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) continue;
    if (record.length < 4 || record[2] !== ' ') throw new Error('Неизвестный формат Git status.');
    const status = record.slice(0, 2);
    const file: GitSnapshot['files'][number] = { status, path: record.slice(3) };
    if (/[RC]/.test(status)) {
      const previous = records[++i];
      if (!previous) throw new Error('Неполный Git status.');
      file.previousPath = previous;
    }
    files.push(file);
  }
  return files;
}

export async function inspectGit(project: Project): Promise<GitSnapshot> {
  const selected = await canonicalDirectory(project.path);
  if (selected !== project.path) throw new Error('Путь проекта изменился. Подключите его заново.');
  let ancestor = selected, hasGit = false;
  while (true) {
    if (await lstat(path.join(ancestor, '.git')).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) { hasGit = true; break; }
    if (ancestor === path.dirname(ancestor)) break;
    ancestor = path.dirname(ancestor);
  }
  if (!hasGit) {
    const files = (await directoryFiles(selected)).map(file => ({ path: file, status: '  ' }));
    return { projectId: project.id, kind: 'directory', repositoryRoot: null, head: null, branch: '', files, staged: '', unstaged: '', digest: createHash('sha256').update(JSON.stringify(files)).digest('hex'), capturedAt: new Date().toISOString() };
  }
  const canonical = await repositoryRoot(selected), relative = path.relative(canonical, selected);
  const scope = relative ? [':(top,literal)' + relative] : ['.'];
  const statusArgs = ['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all', '--', ...scope];
  const [status, branch, headLine, staged, unstaged] = await Promise.all([
    git(canonical, statusArgs),
    git(canonical, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => git(canonical, ['symbolic-ref', '--short', 'HEAD'])),
    git(canonical, ['rev-parse', '--verify', '--quiet', 'HEAD']).catch(() => ''),
    git(canonical, ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--', ...scope]),
    git(canonical, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--', ...scope]),
  ]);
  const finalStatus = await git(canonical, statusArgs);
  const finalHead = await git(canonical, ['rev-parse', '--verify', '--quiet', 'HEAD']).catch(() => '');
  if (status !== finalStatus || headLine !== finalHead) throw new Error('Репозиторий изменился при чтении. Обновите изменения.');
  return {
    projectId: project.id, kind: 'git', repositoryRoot: canonical, head: headLine.trim() || null, branch: branch.trim(), files: parseStatus(status).map(file => ({ ...file, path: path.relative(selected, path.resolve(canonical, file.path)) })), staged, unstaged,
    digest: createHash('sha256').update(JSON.stringify([headLine, status, staged, unstaged])).digest('hex'), capturedAt: new Date().toISOString(),
  };
}
