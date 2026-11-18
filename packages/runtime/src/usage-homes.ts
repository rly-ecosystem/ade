import { createHash } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Provider } from '../../contracts/src/index.js';
import type { HistoryRoot } from './device-history.js';

export interface ExternalHome extends HistoryRoot { name: string }

export async function discoverUsageHomes(home: string, env: NodeJS.ProcessEnv, known: HistoryRoot[]): Promise<ExternalHome[]> {
  const found: ExternalHome[] = [], seen = new Set(known.map(r => r.provider + ':' + path.resolve(r.home)));
  async function directories(parent: string) {
    try { return (await readdir(parent, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name).sort(); }
    catch { return []; }
  }
  async function hasFile(dir: string, name: string) {
    try { return (await stat(path.join(dir, name))).isFile(); } catch { return false; }
  }
  const add = (provider: Provider, dir: string) => {
    const absolute = path.resolve(dir), key = provider + ':' + absolute;
    if (seen.has(key)) return;
    seen.add(key);
    const id = createHash('sha256').update(key).digest('hex').slice(0, 24);
    const relative = path.relative(home, absolute);
    const name = relative && !relative.startsWith('..') ? relative : path.basename(absolute);
    found.push({ home: absolute, provider, profileId: 'cli-' + id, name });
  };
  const config = path.join(home, '.config');
  const [dotDirs, configDirs] = await Promise.all([directories(home), directories(config)]);
  const candidates = [...dotDirs.filter(d => d.startsWith('.')).map(d => path.join(home,d)), ...configDirs.map(d => path.join(config,d))];
  for (const dir of (env.CLAUDE_CONFIG_DIR || '').split(',').map(s => s.trim()).filter(s => path.isAbsolute(s))) add('claude', dir);
  const classify = async (dir: string) => {
    const name = path.basename(dir);
    if (path.dirname(dir) === home && name.startsWith('.codex') && (name === '.codex' || await hasFile(dir, 'auth.json') || await hasFile(dir, 'config.toml'))) return 'codex';
    if (dir === path.join(home,'.claude') || dir === path.join(config,'claude') || await hasFile(dir,'.claude.json') || await hasFile(dir,'.credentials.json')) return 'claude';
    return null;
  };
  const kinds = await Promise.all(candidates.map(classify));
  candidates.forEach((dir, index) => { const kind = kinds[index]; if (kind) add(kind, dir); });
  return found;
}
