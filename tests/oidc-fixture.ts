import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';

export async function oidcFixture() {
  const keys = await generateKeyPair('RS256'), wrong = await generateKeyPair('RS256');
  const publicKey = { ...await exportJWK(keys.publicKey), kid: 'fixture', alg: 'RS256' };
  const codes = new Map<string, { url: URL; subject: string; clientId: string; options: Record<string, any> }>();
  const renewals = new Map<string, { subject: string; clientId: string }>();
  let issuer = '', exchanges = 0, refreshes = 0, revocations = 0, serial = 0, refreshError = '', revokeFailure = false;
  const grants: Record<string, string>[] = [];
  const mint = async (subject: string, clientId: string, nonce?: string, options: Record<string, any> = {}) => {
    const token = await new SignJWT({ sub: options.subject || subject, email: 'same@example.invalid', ...(nonce ? { nonce: options.nonce ?? nonce } : {}) }).setProtectedHeader({ alg: 'RS256', kid: 'fixture' }).setIssuer(options.issuer || issuer).setAudience(options.audience || clientId).setIssuedAt().setExpirationTime(options.expired ? Math.floor(Date.now() / 1000) - 60 : '1h').sign(options.wrongSignature ? wrong.privateKey : keys.privateKey);
    const refresh = 'TEST_REFRESH_' + ++serial; renewals.set(refresh, { subject, clientId });
    return { access_token: 'TEST_ACCESS_' + subject + '_' + serial, refresh_token: refresh, id_token: token, token_type: 'Bearer', expires_in: 3600, scope: options.scope ?? 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct' };
  };
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    const reply = (value: unknown, status = 200) => { response.writeHead(status); response.end(JSON.stringify(value)); };
    try {
      if (request.url === '/.well-known/openid-configuration') return reply({ issuer, authorization_endpoint: issuer + '/authorize', token_endpoint: issuer + '/token', revocation_endpoint: issuer + '/revoke', jwks_uri: issuer + '/jwks' });
      if (request.url === '/jwks') return reply({ keys: [publicKey] });
      let text = ''; for await (const part of request) text += part.toString();
      const params = new URLSearchParams(text), grant = Object.fromEntries(params); grants.push(grant);
      if (request.url === '/revoke') { revocations++; if (revokeFailure) return reply({ error: 'unavailable' }, 503); renewals.delete(params.get('token')!); response.writeHead(200); response.end(); return; }
      if (request.url !== '/token') return reply({}, 404);
      if (params.get('grant_type') === 'refresh_token') {
        refreshes++; const record = renewals.get(params.get('refresh_token')!);
        if (!record || refreshError) return reply({ error: refreshError || 'invalid_grant' }, 400);
        if (record.clientId !== params.get('client_id') || params.has('scope')) return reply({ error: 'invalid_client' }, 400);
        renewals.delete(params.get('refresh_token')!);
        await new Promise(resolve => setTimeout(resolve, 40));
        return reply(await mint(record.subject, record.clientId));
      }
      exchanges++; const record = codes.get(params.get('code')!); codes.delete(params.get('code')!);
      if (!record) return reply({ error: 'invalid_grant' }, 400);
      if (record.options.exchangeError) return reply({ error: record.options.exchangeError }, 400);
      const challenge = createHash('sha256').update(params.get('code_verifier') || '').digest('base64url');
      if (challenge !== record.url.searchParams.get('code_challenge') || record.clientId !== params.get('client_id') || params.get('redirect_uri') !== record.url.searchParams.get('redirect_uri') || params.get('resource') !== 'https://api.openai.com/v1') return reply({ error: 'invalid_grant' }, 400);
      const result: any = await mint(record.subject, record.clientId, record.url.searchParams.get('nonce')!, record.options);
      if (record.options.missingId) delete result.id_token;
      return reply(result);
    } catch { reply({ error: 'fixture_error' }, 500); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('fixture listener');
  issuer = 'http://127.0.0.1:' + address.port;
  return {
    issuer, grants, get exchanges() { return exchanges; }, get refreshes() { return refreshes; }, get revocations() { return revocations; },
    setRefreshError(value: string) { refreshError = value; }, setRevokeFailure(value: boolean) { revokeFailure = value; },
    async callback(authorize: string, subject = 'alice', options: Record<string, any> = {}) {
      const url = new URL(authorize), code = randomUUID();
      const selected = url.searchParams.get('client_id')!;
      const clientId = options.clientId || (selected === 'dynamic_agent_client' ? 'oaiapp_' + subject : selected);
      codes.set(code, { url, subject, clientId, options });
      const callback = new URL(url.searchParams.get('redirect_uri')!);
      callback.searchParams.set('state', options.state ?? url.searchParams.get('state')!);
      if (options.error) callback.searchParams.set('error', options.error);
      else callback.searchParams.set('code', code);
      if (!options.missingClient) callback.searchParams.set('client_id', clientId);
      return fetch(callback);
    },
    async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}
