import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from 'jose';
import { readPrivate, writePrivate, withCredentialLock } from './secure-files.js';

const ISSUER = 'https://auth.openai.com', RESOURCE = 'https://api.openai.com/v1';
const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
const random = () => randomBytes(32).toString('base64url');
interface Discovery { issuer: string; authorization_endpoint: string; token_endpoint: string; revocation_endpoint: string; jwks_uri: string; }
export interface Registration { clientId: string | null; subject: string | null; email: string | null; }
export interface Session { clientId: string; issuer: string; subject: string; email: string | null; idToken: string; accessToken: string; refreshToken: string | null; scopes: string[]; expiresAt: number; }
export interface SignInAttempt { url: string; done: Promise<void>; cancel(): void; }
export interface SIWCOptions { issuer?: string; fetch?: typeof fetch; lifetimeMs?: number; }
export class AuthError extends Error {
  constructor(public code: string, message: string, public terminal = false) { super(message); }
}

export class SIWC {
  private issuer: string;
  private request: typeof fetch;
  private discovery: Promise<Discovery> | null = null;
  constructor(private options: SIWCOptions = {}) { this.issuer = options.issuer || ISSUER; this.request = options.fetch || fetch; }
  private async json(url: string, init?: RequestInit): Promise<any> {
    let response: Response;
    try { response = await this.request(url, { ...init, redirect: 'error', signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000) }); }
    catch { throw new AuthError('network', 'Не удалось связаться с OpenAI. Повторите вход или проверку позже.'); }
    const reader = response.body?.getReader(); let body = '', size = 0;
    if (reader) {
      const decoder = new TextDecoder();
      try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 256 * 1024) throw new AuthError('response_size', 'OpenAI вернул слишком большой ответ.'); body += decoder.decode(part.value, { stream: true }); } body += decoder.decode(); }
      finally { await reader.cancel().catch(() => {}); }
    }
    let value: any; try { value = body ? JSON.parse(body) : {}; } catch { throw new AuthError('invalid_response', 'OpenAI вернул неподдержанный ответ.'); }
    if (!response.ok) {
      const code = ['invalid_grant', 'invalid_token', 'invalid_client', 'unauthorized_client', 'access_denied'].includes(value.error) ? value.error : 'provider_error';
      throw new AuthError(code, code === 'invalid_grant' || code === 'invalid_token' ? 'Сеанс больше недействителен. Войдите в этот профиль заново.' : 'OpenAI не подтвердил операцию входа.', ['invalid_grant', 'invalid_token', 'invalid_client', 'unauthorized_client'].includes(code));
    }
    return value;
  }
  private configuration(): Promise<Discovery> {
    if (!this.discovery) this.discovery = this.json(this.issuer + '/.well-known/openid-configuration').then(value => {
      if (value.issuer !== this.issuer) throw new AuthError('issuer', 'Не совпал издатель OpenID.');
      for (const key of ['authorization_endpoint', 'token_endpoint', 'revocation_endpoint', 'jwks_uri']) {
        const url = new URL(value[key]);
        if (url.origin !== this.issuer || url.username || url.password || url.hash || url.protocol !== (this.issuer === ISSUER ? 'https:' : new URL(this.issuer).protocol)) throw new AuthError('endpoint', 'Неподдержанный адрес OpenID.');
      }
      return value as Discovery;
    }).catch(error => { this.discovery = null; throw error; });
    return this.discovery;
  }
  private async identity(token: string, clientId: string, nonce?: string) {
    const config = await this.configuration();
    try {
      const jwks = await this.json(config.jwks_uri) as JSONWebKeySet;
      const { payload } = await jwtVerify(token, createLocalJWKSet(jwks), { issuer: this.issuer, audience: clientId, algorithms: ['RS256'], requiredClaims: ['sub', 'exp', 'iat'], clockTolerance: 5 });
      if (typeof payload.sub !== 'string' || !payload.sub || nonce !== undefined && payload.nonce !== nonce || typeof payload.iat !== 'number' || payload.iat > Date.now() / 1000 + 5 || payload.azp !== undefined && payload.azp !== clientId || Array.isArray(payload.aud) && payload.aud.length > 1 && !payload.azp) throw new Error('claims');
      return { subject: payload.sub, email: typeof payload.email === 'string' ? payload.email.slice(0, 320) : null };
    } catch (error) { if (error instanceof AuthError && error.code === 'network') throw error; throw new AuthError('identity', 'Не удалось проверить личность OpenAI. Сохранённый аккаунт не изменён.'); }
  }
  private async session(data: any, clientId: string, expected: Registration, nonce?: string, previous?: Session): Promise<Session> {
    if (!data || typeof data.access_token !== 'string' || !data.access_token || data.access_token.length > 32000 || String(data.token_type).toLowerCase() !== 'bearer' || !Number.isFinite(data.expires_in) || data.expires_in <= 0 || data.expires_in > 366 * 86400) throw new AuthError('tokens', 'Получен неполный ответ входа.');
    let identity;
    if (typeof data.id_token === 'string' && data.id_token.length <= 32000) identity = await this.identity(data.id_token, clientId, nonce);
    else if (previous && data.id_token === undefined) identity = { subject: previous.subject, email: previous.email };
    else throw new AuthError('identity', 'OpenAI не вернул проверяемый ID token.');
    if (expected.subject && identity.subject !== expected.subject) throw new AuthError('account_mismatch', 'Вход относится к другому аккаунту. Добавьте отдельный профиль.', !!previous);
    if (data.scope !== undefined && typeof data.scope !== 'string' || data.refresh_token !== undefined && (typeof data.refresh_token !== 'string' || !data.refresh_token || data.refresh_token.length > 32000)) throw new AuthError('tokens', 'Получен некорректный ответ входа.');
    return { ...identity, issuer: this.issuer, clientId, idToken: data.id_token || previous!.idToken, accessToken: data.access_token, refreshToken: data.refresh_token || previous?.refreshToken || null, scopes: data.scope === undefined ? previous?.scopes || [] : data.scope.split(/\s+/).filter(Boolean), expiresAt: Date.now() + data.expires_in * 1000 };
  }
  async start(registration: Registration, hostId: string, retained: Session | null, saveRegistration: (clientId: string) => void, saveSession: (value: Session) => void): Promise<SignInAttempt> {
    const config = await this.configuration(), state = random(), nonce = random(), verifier = random();
    const controller = new AbortController();
    let server: Server, consumed = false, finished = false, doneResolve: () => void, doneReject: (error: Error) => void;
    const done = new Promise<void>((resolve, reject) => { doneResolve = resolve; doneReject = reject; });
    void done.catch(() => {});
    let timer: ReturnType<typeof setTimeout>;
    const finish = (error?: Error) => { if (finished) return; finished = true; clearTimeout(timer); server.close(); server.closeIdleConnections(); error ? doneReject(error) : doneResolve(); };
    server = createServer((request, response) => {
      response.setHeader('Content-Type', 'text/plain; charset=utf-8'); response.setHeader('Cache-Control', 'no-store'); response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
      const reject = () => { response.writeHead(400); response.end('Этот запрос входа не принят. Вернитесь в ADE.'); };
      if ((request.url?.length || 0) > 16000 || request.method !== 'GET' || consumed) { reject(); return; }
      let url: URL; try { url = new URL(request.url!, redirectUri); } catch { reject(); return; }
      const received = url.searchParams.get('state') || '';
      if (request.headers.host !== new URL(redirectUri).host || url.pathname !== '/auth/callback' || url.origin !== new URL(redirectUri).origin || url.searchParams.getAll('state').length !== 1 || Buffer.byteLength(received) !== Buffer.byteLength(state) || !timingSafeEqual(Buffer.from(received), Buffer.from(state))) { reject(); return; }
      const error = url.searchParams.get('error'), code = url.searchParams.get('code'), returnedClient = url.searchParams.get('client_id');
      if (url.searchParams.getAll('code').length > 1 || url.searchParams.getAll('client_id').length > 1 || url.searchParams.getAll('error').length > 1) { reject(); return; }
      consumed = true;
      response.end('Вход обрабатывается. Вернитесь в ADE, чтобы увидеть результат.');
      void (async () => {
        if (error) throw new AuthError('access_denied', 'Вход отменён или доступ не предоставлен. Сохранённые аккаунты не изменены.');
        const clientId = returnedClient || registration.clientId;
        if (!code || !clientId || clientId === 'dynamic_agent_client' || !/^[a-zA-Z0-9._-]{1,128}$/.test(clientId) || registration.clientId && returnedClient && returnedClient !== registration.clientId) throw new AuthError('registration', 'Регистрация не подтверждена. Повторите вход.');
        saveRegistration(clientId);
        const data = await this.json(config.token_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier, redirect_uri: redirectUri, resource: RESOURCE }), signal: controller.signal });
        const credentials = await this.session(data, clientId, registration, nonce);
        if (controller.signal.aborted) throw new AuthError('cancelled', 'Вход отменён.');
        saveSession(credentials);
      })().then(() => finish(), error => finish(error instanceof AuthError ? error : new AuthError('sign_in', 'Не удалось завершить вход.')));
    });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address(); if (!address || typeof address === 'string') { server.close(); throw new AuthError('callback', 'Не удалось открыть локальный callback.'); }
    const redirectUri = `http://127.0.0.1:${address.port}/auth/callback`;
    const url = new URL(config.authorization_endpoint);
    for (const [key, value] of Object.entries({ client_id: registration.clientId || 'dynamic_agent_client', ext_agent_host_id: hostId, response_type: 'code', redirect_uri: redirectUri, scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct', resource: RESOURCE, state, nonce, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') })) url.searchParams.set(key, value);
    if (!registration.clientId) url.searchParams.set('agent_name_hint', 'RLY ADE');
    if (registration.clientId && retained?.idToken) url.searchParams.set('id_token_hint', retained.idToken);
    if (registration.clientId && registration.email) url.searchParams.set('login_hint', registration.email);
    timer = setTimeout(() => { controller.abort(); finish(new AuthError('timeout', 'Время входа истекло. Повторите вход.')); }, this.options.lifetimeMs || 10 * 60 * 1000); timer.unref();
    return { url: url.href, done, cancel: () => { if (controller.signal.aborted) return; controller.abort(); finish(new AuthError('cancelled', 'Вход отменён.')); } };
  }
  read(file: string): Session | null { return readPrivate<Session>(file); }
  hasPlan(session: Session | null): boolean { return !!session?.scopes.includes(PLAN_SCOPE); }
  async access(file: string, expected: Registration): Promise<Session> {
    return withCredentialLock(file, async () => {
      const saved = this.read(file);
      if (!saved || saved.issuer !== this.issuer || saved.clientId !== expected.clientId || saved.subject !== expected.subject) throw new AuthError('signed_out', 'Войдите в выбранный аккаунт.', true);
      if (!this.hasPlan(saved)) throw new AuthError('plan_disabled', 'Вход выполнен, но использование ChatGPT plan не разрешено.');
      if (saved.expiresAt > Date.now() + 16 * 60 * 1000) return saved;
      if (!saved.refreshToken) throw new AuthError('refresh_missing', 'Сеанс истёк. Войдите в этот профиль заново.', true);
      const config = await this.configuration();
      const data = await this.json(config.token_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', client_id: saved.clientId, refresh_token: saved.refreshToken, resource: RESOURCE }) });
      const next = await this.session(data, saved.clientId, expected, undefined, saved);
      writePrivate(file, next);
      if (!this.hasPlan(next)) throw new AuthError('plan_disabled', 'OpenAI больше не разрешает использование ChatGPT plan.');
      return next;
    });
  }
  async revoke(file: string): Promise<boolean> {
    return withCredentialLock(file, async () => {
      const saved = this.read(file); if (!saved?.refreshToken) return true;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const config = await this.configuration();
          await this.json(config.revocation_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: saved.refreshToken, token_type_hint: 'refresh_token', client_id: saved.clientId }) });
          return true;
        } catch { if (!attempt) await new Promise(resolve => setTimeout(resolve, 200)); }
      }
      return false;
    });
  }
}
