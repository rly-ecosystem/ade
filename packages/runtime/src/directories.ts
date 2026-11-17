import { lstat, realpath, readdir } from 'node:fs/promises';
import path from 'node:path';

export const IGNORED_DIRECTORIES = new Set(['node_modules', 'dist', 'build', 'target', 'vendor', 'logs', 'coverage', '__pycache__', 'venv']);
const visible = (name: string) => !name.startsWith('.') && !IGNORED_DIRECTORIES.has(name);
export function contains(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}
export function overlaps(a: string, b: string): boolean { return contains(a, b) || contains(b, a); }

export async function canonicalDirectory(directory: string): Promise<string> {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || directory.includes('\0')) throw new Error('Выберите существующую папку проекта.');
  try { const canonical = await realpath(directory); if (!(await lstat(canonical)).isDirectory()) throw new Error(); return canonical; }
  catch { throw new Error('Выберите существующую папку проекта.'); }
}

export interface DirectoryInfo { path: string; kind: 'repository' | 'directory'; hasChildren: boolean; }
export async function describeDirectory(directory: string): Promise<DirectoryInfo> {
  const canonical = await canonicalDirectory(directory);
  const entries = await readdir(canonical, { withFileTypes: true });
  return { path: canonical, kind: entries.some(entry => entry.name === '.git') ? 'repository' : 'directory', hasChildren: entries.some(entry => entry.isDirectory() && visible(entry.name)) };
}

export async function childDirectories(parent: string): Promise<DirectoryInfo[]> {
  const canonical = await canonicalDirectory(parent);
  const entries = (await readdir(canonical, { withFileTypes: true })).filter(entry => entry.isDirectory() && visible(entry.name)).sort((a, b) => a.name.localeCompare(b.name));
  if (entries.length > 1000) throw new Error('В папке более 1000 подпроектов. Выберите более узкий каталог.');
  const result: DirectoryInfo[] = [];
  for (const entry of entries) {
    const absolute = path.join(canonical, entry.name), actual = await realpath(absolute);
    if (!contains(canonical, actual) || (await lstat(absolute)).isSymbolicLink()) continue;
    try { result.push(await describeDirectory(actual)); }
    catch { result.push({ path: actual, kind: 'directory', hasChildren: true }); }
  }
  return result;
}

export async function directoryFiles(directory: string): Promise<string[]> {
  const canonical = await canonicalDirectory(directory), files: string[] = [];
  async function visit(current: string, depth: number) {
    if (depth > 32) throw new Error('Каталог глубже 32 уровней. Выберите более узкий проект.');
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.') || IGNORED_DIRECTORIES.has(entry.name)) continue;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(absolute, depth + 1);
      else if (entry.isFile() || entry.isSymbolicLink()) files.push(path.relative(canonical, absolute));
      if (files.length > 2000) throw new Error('В каталоге более 2000 файлов. Выберите подпроект для запуска.');
    }
  }
  await visit(canonical, 0); return files.sort();
}
