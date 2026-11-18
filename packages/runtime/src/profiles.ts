import { homedir } from 'node:os';
import { emptyQuota, queryPlan } from './plan-quota.js';
import { discoverUsageHomes } from './usage-homes.js';
import type { HistoryRoot } from './device-history.js';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { type AccountProfile, type AccountProfiles, type ProfileBindings, SHARED_PROFILES, validProfileId } from '../../contracts/src/accounts.js';
import type { Provider, ProviderStatus } from '../../contracts/src/index.js';
import { probe } from './adapters.js';
import { cliEnvironment, executable, launch, processStamp, sharedClaudeConfigDir, terminateGroup } from './processes.js';
import { privateDirectory, readPrivate, writePrivate } from './secure-files.js';
import { SIWC, AuthError, type Registration, type SIWCOptions, type SignInAttempt } from './siwc.js';
import type { RuntimeEvents } from './runner.js';

interface StoredProfile extends Registration { id: string; provider: Provider; name: string; enabled: boolean; state: AccountProfile['state']; reason: string; }
interface Registry { version: 1; hostId: string; selected: ProfileBindings; profiles: StoredProfile[]; requests: Record<string, string>; welcomeSeen?: boolean; }
export interface ProfileLease { accountsRoot: string; id: string; provider: Provider; environment?: NodeJS.ProcessEnv; accessToken?: string; expiresAt?: number; release(): void; }
const exec = promisify(execFile);
const silent: RuntimeEvents = { changed() {}, process() {}, processGone() {} };

export class Profiles {
  private registry: Registry;
  private siwc: SIWC;
  private leases = new Map<string, number>();
  private pending = new Map<string, { cancel(): Promise<void>; done: Promise<void>; code?(value: string): void; needsCode?: boolean }>();
  private shared = new Map<string, ProviderStatus>();
  private checking = new Map<string, number>();
  private signingOut = new Set<string>();
  private closing = false;
  readonly root: string;
  constructor(directory: string, private events: RuntimeEvents = silent, options: SIWCOptions = {}) {
    this.root = path.join(directory, 'accounts'); privateDirectory(this.root);
    this.siwc = new SIWC(options);
    this.registry = readPrivate<Registry>(this.registryFile()) || { version: 1, hostId: 'urn:uuid:' + randomUUID(), selected: { ...SHARED_PROFILES }, profiles: [], requests: {} };
    if (this.registry.version !== 1 || !Array.isArray(this.registry.profiles) || !this.registry.selected || typeof this.registry.hostId !== 'string' || !this.registry.hostId.startsWith('urn:uuid:') || this.registry.profiles.some(item => !validProfileId(item.id) || item.id.startsWith('shared-') || !['codex', 'claude'].includes(item.provider))) throw new Error('Неподдержанное состояние аккаунтов.');
    this.persist();
  }
  private registryFile() { return path.join(this.root, 'registry.json'); }
  private persist() { writePrivate(this.registryFile(), this.registry); }
  private changed(authComplete = false) { this.persist(); this.events.changed(authComplete ? 'profiles-auth' : 'profiles'); }
  private profile(id: string): StoredProfile {
    if (!validProfileId(id)) throw new Error('Некорректный профиль.');
    const profile = this.registry.profiles.find(item => item.id === id); if (!profile) throw new Error('Изолированный профиль не найден.'); return profile;
  }
  private directory(id: string): string { this.profile(id); const value = path.join(this.root, id); privateDirectory(value); return value; }
  private tokenFile(id: string) { return path.join(this.directory(id), 'siwc-session.json'); }
  private idle(id: string) { if (this.closing) throw new Error('Приложение завершает работу.'); if (this.signingOut.has(id) || this.checking.has(id)) throw new Error('Идёт проверка или выход из профиля. Повторите через несколько секунд.'); if (this.leases.get(id)) throw new Error('Аккаунт занят исполнителем. Сначала остановите его.'); }
  private nameAvailable(provider: Provider, name: string, except?: string) {
    if (!name.trim() || name.trim().length > 40 || /[\r\n\0]/.test(name) || this.registry.profiles.some(item => item.id !== except && item.provider === provider && item.name.toLocaleLowerCase() === name.trim().toLocaleLowerCase())) throw new Error('Название должно быть уникальным для провайдера и содержать до 40 символов.');
  }
  assertProvider(id: string, provider: Provider): void {
    if (id === SHARED_PROFILES[provider]) return;
    if (this.profile(id).provider !== provider) throw new Error('Профиль принадлежит другому исполнителю.');
  }
  snapshot(): ProfileBindings { return { ...this.registry.selected }; }
  list(): AccountProfiles {
    const shared = (['codex', 'claude'] as Provider[]).map(provider => {
      const status = this.shared.get(SHARED_PROFILES[provider]);
      return { id: SHARED_PROFILES[provider], provider, name: 'Текущий CLI ' + (provider === 'codex' ? 'Codex' : 'Claude'), mode: 'shared_cli' as const, enabled: true, state: status?.authenticated ? 'connected' as const : 'needs_sign_in' as const, email: null, reason: status?.reason || 'Общий вход CLI. ADE не изменяет его авторизацию.', pending: false, needsCode: false };
    });
    return { selected: this.snapshot(), welcomeProfileId: this.registry.welcomeSeen ? null : this.registry.profiles.find(profile => profile.provider === 'codex' && profile.state === 'connected')?.id || null, profiles: [...shared, ...this.registry.profiles.map(profile => ({ id: profile.id, provider: profile.provider, name: profile.name, mode: profile.provider === 'codex' ? 'siwc' as const : 'isolated_cli' as const, enabled: profile.enabled, state: profile.state, email: profile.email, reason: profile.reason, pending: this.pending.has(profile.id), needsCode: !!this.pending.get(profile.id)?.needsCode }))] };
  }
  welcome(id: string): AccountProfiles { const profile = this.profile(id); if (profile.provider !== 'codex' || profile.state !== 'connected') throw new Error('Сначала завершите вход ChatGPT.'); this.registry.welcomeSeen = true; this.changed(); return this.list(); }
  create(provider: Provider, name: string, requestId: string): AccountProfiles {
    if (this.closing) throw new Error('Приложение завершает работу.');
    const existing = this.registry.requests[requestId];
    if (existing) { const profile = this.profile(existing); if (profile.provider !== provider || profile.name !== name.trim()) throw new Error('Ключ создания уже использован с другими данными.'); return this.list(); }
    if (this.registry.profiles.length >= 32) throw new Error('Достигнут предел 32 изолированных профилей.');
    this.nameAvailable(provider, name);
    const id = randomUUID();
    this.registry.profiles.push({ id, provider, name: name.trim(), enabled: true, state: 'signed_out', reason: 'Войдите в этот профиль. Общие входы CLI сохраняются.', clientId: null, subject: null, email: null });
    this.registry.requests[requestId] = id;
    this.directory(id); this.changed(); return this.list();
  }
  rename(id: string, name: string): AccountProfiles { const profile = this.profile(id); this.nameAvailable(profile.provider, name, id); profile.name = name.trim(); this.changed(); return this.list(); }
  enable(id: string, enabled: boolean): AccountProfiles { this.idle(id); const profile = this.profile(id); if (this.pending.has(id)) throw new Error('Сначала отмените вход.'); profile.enabled = enabled; this.changed(); return this.list(); }
  async select(id: string): Promise<AccountProfiles> {
    const status = await this.status(id); if (!status.authenticated) throw new Error(status.reason);
    this.registry.selected[status.provider] = id; this.changed(); return this.list();
  }
  private registeredHomes(): HistoryRoot[] {
    return this.list().profiles.map(p => {
      const shared = p.mode === 'shared_cli';
      const home = shared ? (p.provider === 'codex' ? process.env.CODEX_HOME : sharedClaudeConfigDir()) || path.join(homedir(), '.' + p.provider) : path.join(this.root, p.id, p.provider);
      return { home, profileId: p.id, provider: p.provider };
    });
  }
  externalHomes() { return discoverUsageHomes(homedir(), process.env, this.registeredHomes()); }
  async historyRoots() { const known = this.registeredHomes(); return [...known, ...await discoverUsageHomes(homedir(), process.env, known)]; }
  async quota(id: string) {
    if (id.startsWith('cli-')) {
      const source = (await this.externalHomes()).find(r => r.profileId === id);
      if (!source) throw new Error('Каталог профиля больше не доступен.');
      return queryPlan(source.provider, { [source.provider === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR']: source.home });
    }
    const p = this.list().profiles.find(profile => profile.id === id);
    if (!p) throw new Error('Профиль не найден.');
    if (!p.enabled || p.pending || this.signingOut.has(id)) return emptyQuota('Профиль отключён или выполняется вход.');
    if (p.mode === 'siwc') return emptyQuota('Лимиты этого входа доступны в настройках ChatGPT.');
    if (p.mode !== 'shared_cli' && p.state !== 'connected') return emptyQuota('Для просмотра лимитов войдите в профиль.');
    return queryPlan(p.provider, this.environment(id));
  }
  environment(id: string): NodeJS.ProcessEnv | undefined {
    if (Object.values(SHARED_PROFILES).includes(id)) return undefined;
    const profile = this.profile(id), directory = this.directory(id), config = path.join(directory, profile.provider);
    privateDirectory(config); privateDirectory(path.join(directory, 'xdg'));
    return { [profile.provider === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR']: config, XDG_CONFIG_HOME: path.join(directory, 'xdg') };
  }
  async status(id: string, confirmingLogin = false): Promise<ProviderStatus> {
    if (this.signingOut.has(id)) throw new Error('Выполняется выход из аккаунта.');
    this.checking.set(id, (this.checking.get(id) || 0) + 1);
    try { return await this.checkStatus(id, confirmingLogin); }
    finally {
      const remaining = (this.checking.get(id) || 1) - 1;
      if (remaining) this.checking.set(id, remaining); else this.checking.delete(id);
    }
  }
  private async checkStatus(id: string, confirmingLogin: boolean): Promise<ProviderStatus> {
    const provider = (Object.entries(SHARED_PROFILES).find(([, value]) => value === id)?.[0] as Provider | undefined) || this.profile(id).provider;
    if (id === SHARED_PROFILES[provider]) { const value = await probe(provider); this.shared.set(id, value); return { ...value, profileId: id, profileName: this.list().profiles.find(item => item.id === id)!.name }; }
    const profile = this.profile(id);
    if (!profile.enabled) return { provider, installed: true, authenticated: false, version: '', reason: 'Выбранный аккаунт отключён. Выберите другой явно.', profileId: id, profileName: profile.name };
    if (this.pending.has(id) && !confirmingLogin) return { provider, installed: true, authenticated: false, version: '', reason: 'Вход ещё не завершён.', profileId: id, profileName: profile.name };
    let value: ProviderStatus;
    if (provider === 'codex') {
      try {
        const session = await this.siwc.access(this.tokenFile(id), profile);
        value = await probe(provider, this.environment(id), true);
        profile.state = this.siwc.hasPlan(session) ? 'connected' : 'plan_disabled';
        profile.reason = value.installed ? 'SIWC · доступ к выбранной модели проверяется при запуске.' : value.reason;
      } catch (error) {
        if (error instanceof AuthError && error.terminal) { profile.state = 'needs_sign_in'; rmSync(this.tokenFile(id), { force: true }); }
        else if (error instanceof AuthError && error.code === 'plan_disabled') profile.state = 'plan_disabled';
        profile.reason = error instanceof AuthError ? error.message : 'Не удалось проверить сохранённый сеанс.';
        value = { provider, installed: false, authenticated: false, version: '', reason: profile.reason };
      }
    } else {
      value = await probe(provider, this.environment(id));
      profile.state = value.authenticated ? 'connected' : 'needs_sign_in';
      profile.reason = value.authenticated ? 'Официальный Claude CLI · отдельное состояние входа.' : value.reason;
    }
    this.persist();
    return { ...value, authenticated: value.authenticated && profile.state === 'connected', reason: profile.reason, profileId: id, profileName: profile.name };
  }
  async selectedStatus(): Promise<ProviderStatus[]> { const snapshot = this.snapshot(); return Promise.all((['codex', 'claude'] as Provider[]).map(provider => this.status(snapshot[provider]))); }
  async check(id: string): Promise<AccountProfiles> { await this.status(id); this.events.changed('profiles'); return this.list(); }
  async acquire(id: string, provider: Provider): Promise<ProfileLease> {
    this.assertProvider(id, provider);
    if (this.closing || this.signingOut.has(id) || this.pending.has(id)) throw new Error('Аккаунт занят входом или завершением работы.');
    if (!id.startsWith('shared-') && !this.profile(id).enabled) throw new Error('Выбранный аккаунт отключён. Общий вход не подставляется.');
    this.leases.set(id, (this.leases.get(id) || 0) + 1);
    let released = false;
    const release = () => { if (!released) { released = true; const count = (this.leases.get(id) || 1) - 1; count ? this.leases.set(id, count) : this.leases.delete(id); } };
    try {
      const status = await this.status(id); if (!status.authenticated) throw new Error(status.reason);
      const session = provider === 'codex' && !id.startsWith('shared-') ? this.siwc.read(this.tokenFile(id)) : null;
      if (provider === 'codex' && !id.startsWith('shared-') && !session?.accessToken) throw new Error('Сеанс профиля недоступен. Войдите заново.');
      return { accountsRoot: this.root, id, provider, environment: this.environment(id), ...(session ? { accessToken: session.accessToken, expiresAt: session.expiresAt } : {}), release };
    } catch (error) { release(); throw error; }
  }
  async startLogin(id: string): Promise<{ url?: string }> {
    this.idle(id); const profile = this.profile(id);
    if (!profile.enabled) throw new Error('Сначала включите профиль.');
    if (this.pending.has(id)) throw new Error('Вход в этот профиль уже открыт.');
    if (profile.provider === 'codex') {
      // Reserve before network discovery so logout and a second sign-in cannot race it.
      let attempt: SignInAttempt | undefined, cancelled = false;
      const pending = { cancel: async () => { cancelled = true; attempt?.cancel(); }, done: Promise.resolve() };
      this.pending.set(id, pending); this.events.changed('profiles');
      try {
        attempt = await this.siwc.start({ clientId: profile.clientId, subject: profile.subject, email: profile.email }, this.registry.hostId, this.siwc.read(this.tokenFile(id)), clientId => { if (!cancelled) { profile.clientId = clientId; this.persist(); } }, session => {
          if (cancelled || this.closing) return;
          writePrivate(this.tokenFile(id), session); profile.subject = session.subject; profile.email = session.email;
          profile.state = this.siwc.hasPlan(session) ? 'connected' : 'plan_disabled';
          profile.reason = profile.state === 'connected' ? 'Вход SIWC выполнен. Можно выбрать этот аккаунт.' : 'Вход выполнен, но ChatGPT plan не разрешён. Повторите вход и разрешите доступ.';
          this.persist();
        });
        if (cancelled || this.closing) attempt.cancel();
        pending.done = attempt.done.catch(error => { profile.reason = error instanceof AuthError ? error.message : 'Не удалось завершить вход.'; }).finally(() => { if (this.pending.get(id) === pending) this.pending.delete(id); this.changed(true); });
        return cancelled ? {} : { url: attempt.url };
      } catch (error) { this.pending.delete(id); this.events.changed('profiles'); throw error; }
    }
    const binary = executable('claude'), environment = this.environment(id)!;
    // BSD script requires a real input pipe; Node's stdio socket fails its ioctl.
    const child = launch('/bin/bash', ['--noprofile', '--norc', '-c', 'exec /usr/bin/script -q /dev/null "$@" < <(/bin/cat)', 'ade-auth', binary, 'auth', 'login', '--claudeai'], this.directory(id), environment);
    child.stdin.on('error', () => {});
    const pid = child.pid, stamp = pid ? processStamp(pid) : null;
    if (!pid || !stamp) { child.kill('SIGKILL'); throw new Error('Не удалось зарегистрировать официальный вход CLI.'); }
    this.events.process('auth:' + id, pid, stamp);
    let cancelled = false, output = '';
    const pending = { needsCode: false, cancel: async () => { cancelled = true; await terminateGroup(pid, stamp, true); }, code: (value: string) => { if (!child.stdin.writable) throw new Error('Вход CLI уже завершён.'); pending.needsCode = false; output = ''; child.stdin.write(value + '\n'); }, done: Promise.resolve() };
    this.pending.set(id, pending);
    const inspect = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-2000); if (/paste.*code|enter.*code/i.test(output) && !pending.needsCode) { pending.needsCode = true; this.events.changed('profiles'); } };
    child.stdout.on('data', inspect); child.stderr.on('data', inspect);
    const deadline = setTimeout(() => { void pending.cancel().catch(() => {}); }, 10 * 60 * 1000); deadline.unref();
    pending.done = new Promise<void>(resolve => { child.once('error', () => resolve()); child.once('exit', () => resolve()); }).then(async () => {
      clearTimeout(deadline);
      try {
        await terminateGroup(pid, stamp, true); this.events.processGone('auth:' + id);
        if (!cancelled && !this.closing) await this.status(id, true);
        else profile.reason = 'Вход отменён. Сохранённые аккаунты не изменены.';
      } finally { this.pending.delete(id); this.changed(true); }
    }).catch(() => { profile.reason = 'Не удалось завершить официальный вход CLI.'; this.changed(); });
    this.events.changed('profiles'); return {};
  }
  async cancel(id: string): Promise<AccountProfiles> { const pending = this.pending.get(id); if (pending) { await pending.cancel(); await pending.done; } return this.list(); }
  code(id: string, value: string): AccountProfiles { const pending = this.pending.get(id); if (!pending?.code || !pending.needsCode) throw new Error('Официальный CLI не ожидает код.'); pending.code(value); return this.list(); }
  async logout(id: string): Promise<AccountProfiles> {
    this.idle(id); const profile = this.profile(id); if (this.pending.has(id)) throw new Error('Сначала отмените вход.');
    this.signingOut.add(id);
    try {
      if (profile.provider === 'codex') {
        const revoked = await this.siwc.revoke(this.tokenFile(id)); rmSync(this.tokenFile(id), { force: true });
        profile.reason = revoked ? 'Выход выполнен. Регистрация сохранена для следующего входа.' : 'Локальный выход выполнен. Удалённый отзыв не подтверждён; отключить приложение можно в настройках ChatGPT.';
      } else {
        const binary = executable('claude');
        try { await exec(binary, ['auth', 'logout'], { cwd: this.directory(id), env: cliEnvironment(binary, this.environment(id)), timeout: 15000, maxBuffer: 65536 }); }
        catch { throw new Error('Официальный Claude CLI не подтвердил выход. Проверьте профиль повторно.'); }
        profile.reason = 'Официальный CLI выполнил выход только из этого профиля.';
      }
      profile.state = 'signed_out'; this.changed(); return this.list();
    } finally { this.signingOut.delete(id); }
  }
  async close(): Promise<void> { this.closing = true; await Promise.all([...this.pending.values()].map(async item => { await item.cancel(); await item.done; })); }
}
