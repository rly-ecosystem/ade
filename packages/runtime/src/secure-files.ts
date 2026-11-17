import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

export function privateDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Каталог аккаунта не может быть ссылкой.');
  chmodSync(directory, 0o700);
}
export function readPrivate<T>(file: string): T | null {
  if (!existsSync(file)) return null;
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Некорректный файл аккаунта.');
  chmodSync(file, 0o600);
  try { return JSON.parse(readFileSync(file, 'utf8')) as T; }
  catch { throw new Error('Не удалось прочитать сохранённое состояние аккаунта.'); }
}
export function writePrivate(file: string, value: unknown): void {
  privateDirectory(path.dirname(file));
  const temp = file + '.tmp-' + randomUUID(), fd = openSync(temp, 'wx', 0o600);
  try {
    try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, file);
    const directory = openSync(path.dirname(file), 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally { rmSync(temp, { force: true }); }
}

export async function withCredentialLock<T>(file: string, action: () => Promise<T>): Promise<T> {
  // SQLite releases the OS lock even when the process dies during a token rotation.
  const lock = file + '.mutex.sqlite';
  closeSync(openSync(lock, 'a', 0o600));
  const db = new DatabaseSync(lock), deadline = Date.now() + 30000;
  try {
    db.exec('PRAGMA busy_timeout=0');
    for (;;) {
      try { db.exec('BEGIN IMMEDIATE'); break; }
      catch (error) {
        if ((error as { errcode?: number }).errcode !== 5) throw error;
        if (Date.now() >= deadline) throw new Error('Обновление сеанса занято другим процессом. Повторите позже.');
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    return await action();
  } finally { db.close(); }
}
