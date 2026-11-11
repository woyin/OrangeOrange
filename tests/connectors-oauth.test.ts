import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ControlStore } from '../src/control/store.js';
import {
  ALLOWED_GOOGLE_SCOPES,
  GMAIL_SEND_SCOPE,
  GOOGLE_AUTHORIZATION_ENDPOINT,
  GOOGLE_REVOKE_ENDPOINT,
  GOOGLE_TOKEN_ENDPOINT,
  GoogleOAuthClient,
  OAuthError,
  type AppConnection,
  type GoogleOAuthConfig,
  type OAuthFetch,
  type OAuthFetchResponse,
} from '../src/connectors/oauth.js';

const REDIRECT = 'https://hda.example.com/oauth/google/callback';
const ACCESS_TOKEN = 'ya29.access-token-must-stay-secret';
const REFRESH_TOKEN = '1//refresh-token-must-stay-secret';
const CLIENT_ID = '1234.apps.googleusercontent.com';
const CLIENT_SECRET = 'client-secret-must-stay-secret';
const STATE_TTL_MS = 10 * 60 * 1000;
const FIXED_ENDPOINTS = new Set([GOOGLE_TOKEN_ENDPOINT, GOOGLE_REVOKE_ENDPOINT]);

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: URLSearchParams;
  raw: string;
}
type Route = (call: Call) => OAuthFetchResponse;

const dirs: string[] = [];
const stores: ControlStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {}
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function openStore(): ControlStore {
  const dir = mkdtempSync(join(tmpdir(), 'hda-oauth-'));
  dirs.push(dir);
  const store = new ControlStore(dir);
  stores.push(store);
  return store;
}

function response(status: number, body: unknown): OAuthFetchResponse {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, text: async () => text };
}

function recorder(route: Route) {
  const calls: Call[] = [];
  const fetch: OAuthFetch = async (url, init) => {
    const call: Call = {
      url,
      method: init.method,
      headers: init.headers,
      body: new URLSearchParams(init.body),
      raw: init.body,
    };
    calls.push(call);
    return route(call);
  };
  return { calls, fetch };
}

function tokenBody(extra: Record<string, unknown> = {}) {
  return {
    access_token: ACCESS_TOKEN,
    refresh_token: REFRESH_TOKEN,
    expires_in: 3599,
    scope: GMAIL_SEND_SCOPE,
    token_type: 'Bearer',
    ...extra,
  };
}

function clientFor(store: ControlStore, fetch: OAuthFetch, overrides: Partial<GoogleOAuthConfig> = {}) {
  return new GoogleOAuthClient(store, {
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUris: [REDIRECT],
    fetch,
    ...overrides,
  });
}

/** Production callback: a Google GET redirect carries state + code, and may have no Owner cookie. */
async function connect(client: GoogleOAuthClient, code = '4/0authorization-code'): Promise<AppConnection> {
  const start = await client.startAuthorization({ principalId: 'owner', redirectUri: REDIRECT });
  return client.completeAuthorization({ state: start.state, code });
}

function syncCode(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error instanceof OAuthError ? error.code : undefined;
  }
}

function secretsText(store: ControlStore): string {
  return store.db
    .prepare('SELECT name,cipher FROM secrets')
    .all()
    .map((row) => Buffer.from(row.cipher as Uint8Array).toString('utf8'))
    .join('|');
}

describe('Google OAuth connector (CONN-004/006, GML-001/007)', () => {
  it('builds a Google authorization request with PKCE, one-time state, and only gmail.send', async () => {
    const store = openStore();
    const rec = recorder(() => response(200, {}));
    const client = clientFor(store, rec.fetch);

    await expect(
      client.startAuthorization({ principalId: 'agent-1', redirectUri: REDIRECT }),
    ).rejects.toMatchObject({ code: 'OWNER_REQUIRED' });
    await expect(
      client.startAuthorization({ principalId: 'owner', redirectUri: 'https://evil.example.com/callback' }),
    ).rejects.toMatchObject({ code: 'REDIRECT_URI_NOT_ALLOWED' });
    await expect(
      client.startAuthorization({ principalId: 'owner', redirectUri: `${REDIRECT}?extra=1` }),
    ).rejects.toMatchObject({ code: 'REDIRECT_URI_NOT_ALLOWED' });

    const start = await client.startAuthorization({ principalId: 'owner', redirectUri: REDIRECT });
    const url = new URL(start.authorizationUrl);
    expect(start.authorizationUrl.startsWith(`${GOOGLE_AUTHORIZATION_ENDPOINT}?`)).toBe(true);
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe(GMAIL_SEND_SCOPE);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBe(start.codeChallenge);
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('include_granted_scopes')).toBe('false');
    expect(url.searchParams.get('state')).toBe(start.state);
    expect(url.searchParams.get('scope')).not.toContain('readonly');
    expect(url.searchParams.get('scope')).not.toContain('compose');
    expect(start.scopes).toEqual([GMAIL_SEND_SCOPE]);
    expect(start.codeChallengeMethod).toBe('S256');
    expect(start.state.length).toBeGreaterThanOrEqual(32);
    expect(start.authorizationUrl).not.toContain(CLIENT_SECRET);
    expect(rec.calls).toHaveLength(0);

    const stateHash = createHash('sha256').update(start.state).digest('hex');
    const pending = store.get<Record<string, unknown>>('oauth_pending', stateHash);
    expect(pending).toMatchObject({ ownerId: 'owner', redirectUri: REDIRECT, scopes: [GMAIL_SEND_SCOPE] });
    expect(JSON.stringify(pending)).not.toContain('code_verifier');
    expect(start.expiresAt).toBe((pending!.createdAt as number) + STATE_TTL_MS);
  });

  it('rejects non-HTTPS or non-canonical redirect allowlists at construction', () => {
    const store = openStore();
    const fetch: OAuthFetch = async () => response(200, {});
    expect(syncCode(() => clientFor(store, fetch, { redirectUris: [] }))).toBe('CONFIG_INVALID');
    expect(syncCode(() => clientFor(store, fetch, { redirectUris: ['http://hda.example.com/cb'] }))).toBe(
      'CONFIG_INVALID',
    );
    expect(syncCode(() => clientFor(store, fetch, { redirectUris: [`${REDIRECT}#fragment`] }))).toBe(
      'CONFIG_INVALID',
    );
    expect(syncCode(() => clientFor(store, fetch, { redirectUris: ['https://HDA.example.com/cb'] }))).toBe(
      'CONFIG_INVALID',
    );
    expect(syncCode(() => clientFor(store, fetch, { redirectUris: ['not a url'] }))).toBe('CONFIG_INVALID');
    expect(syncCode(() => clientFor(store, fetch, { clientId: '  ' }))).toBe('CONFIG_INVALID');
    expect(syncCode(() => clientFor(store, fetch, { clientSecret: '' }))).toBe('CONFIG_INVALID');
  });

  it('exchanges the code with the stored PKCE verifier and keeps tokens only in encrypted secrets', async () => {
    const store = openStore();
    const rec = recorder((call) => (call.url === GOOGLE_TOKEN_ENDPOINT ? response(200, tokenBody()) : response(404, {})));
    const client = clientFor(store, rec.fetch);

    const start = await client.startAuthorization({ principalId: 'owner', redirectUri: REDIRECT });
    const connection = await client.completeAuthorization({ state: start.state, code: '4/0authorization-code' });

    expect(connection).toMatchObject({
      provider: 'google',
      ownerId: 'owner',
      status: 'CONNECTED',
      scopes: [GMAIL_SEND_SCOPE],
      refreshable: true,
    });
    expect(rec.calls).toHaveLength(1);
    const exchange = rec.calls[0]!;
    expect(exchange.url).toBe(GOOGLE_TOKEN_ENDPOINT);
    expect(exchange.method).toBe('POST');
    expect(exchange.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(exchange.body.get('grant_type')).toBe('authorization_code');
    expect(exchange.body.get('code')).toBe('4/0authorization-code');
    expect(exchange.body.get('redirect_uri')).toBe(REDIRECT);
    expect(exchange.body.get('client_id')).toBe(CLIENT_ID);
    expect(exchange.body.get('client_secret')).toBe(CLIENT_SECRET);
    const verifier = exchange.body.get('code_verifier');
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]{43,128}$/);
    expect(createHash('sha256').update(verifier!).digest('base64url')).toBe(start.codeChallenge);

    // No plaintext token anywhere in the database, events, or audit rows.
    expect(secretsText(store)).not.toContain(ACCESS_TOKEN);
    expect(secretsText(store)).not.toContain(REFRESH_TOKEN);
    expect(JSON.stringify(store.list('app_connections'))).not.toContain(ACCESS_TOKEN);
    expect(JSON.stringify(store.list('app_connections'))).not.toContain(REFRESH_TOKEN);
    expect(JSON.stringify(store.events())).not.toContain(ACCESS_TOKEN);
    expect(JSON.stringify(store.events())).not.toContain(REFRESH_TOKEN);
    expect(JSON.stringify(store.db.prepare('SELECT * FROM audit_events').all())).not.toContain(REFRESH_TOKEN);

    await expect(client.accessToken(connection.id, 'owner')).resolves.toMatchObject({
      connectionId: connection.id,
      accessToken: ACCESS_TOKEN,
      scopes: [GMAIL_SEND_SCOPE],
    });

    // State is single use even with a valid verifier.
    await expect(
      client.completeAuthorization({ state: start.state, code: '4/0authorization-code' }),
    ).rejects.toMatchObject({ code: 'STATE_INVALID' });
    expect(store.list('oauth_pending')).toHaveLength(0);
    expect(store.secretMetadata().filter((entry) => entry.name.startsWith('oauth_pending:'))).toHaveLength(0);
  });

  it('completes a cookie-less callback from state alone and keeps the state owner-bound', async () => {
    const store = openStore();
    const rec = recorder((call) => (call.url === GOOGLE_TOKEN_ENDPOINT ? response(200, tokenBody()) : response(404, {})));
    const client = clientFor(store, rec.fetch);

    const start = await client.startAuthorization({ principalId: 'owner', redirectUri: REDIRECT });
    await expect(
      client.completeAuthorization({ principalId: 'agent-1', state: start.state, code: '4/0code' }),
    ).rejects.toMatchObject({ code: 'OWNER_REQUIRED' });
    expect(store.list('oauth_pending')).toHaveLength(1);
    expect(rec.calls).toHaveLength(0);

    await expect(
      client.completeAuthorization({ state: 'unknown-state-value', code: '4/0code' }),
    ).rejects.toMatchObject({ code: 'STATE_INVALID' });
    expect(store.list('oauth_pending')).toHaveLength(1);

    // No Owner cookie: state is the proof, and it still resolves to the bound owner.
    const connection = await client.completeAuthorization({ state: start.state, code: '4/0code' });
    expect(connection).toMatchObject({ status: 'CONNECTED', ownerId: 'owner' });
    expect(client.connection(connection.id, 'owner')).toMatchObject({ status: 'CONNECTED' });
  });

  it('expires pending state after its TTL and rejects malformed callbacks', async () => {
    const store = openStore();
    let clock = 1_700_000_000_000;
    const rec = recorder(() => response(200, tokenBody()));
    const client = clientFor(store, rec.fetch, { now: () => clock, stateTtlMs: 60_000 });

    const start = await client.startAuthorization({ principalId: 'owner', redirectUri: REDIRECT });
    clock += 60_001;
    await expect(client.completeAuthorization({ state: start.state, code: '4/0code' })).rejects.toMatchObject({
      code: 'STATE_EXPIRED',
    });
    expect(store.list('oauth_pending')).toHaveLength(0);
    expect(store.secretMetadata().filter((entry) => entry.name.startsWith('oauth_pending:'))).toHaveLength(0);
    expect(rec.calls).toHaveLength(0);

    const fresh = await client.startAuthorization({ principalId: 'owner', redirectUri: REDIRECT });
    await expect(client.completeAuthorization({ state: fresh.state, code: '' })).rejects.toMatchObject({
      code: 'CODE_INVALID',
    });
    await expect(client.completeAuthorization({ state: '', code: '4/0code' })).rejects.toMatchObject({
      code: 'STATE_INVALID',
    });
  });

  it('fails closed on scope escalation, revokes the over-scoped token, and stores nothing', async () => {
    const store = openStore();
    const rec = recorder((call) => {
      if (call.url === GOOGLE_TOKEN_ENDPOINT) {
        return response(200, tokenBody({ scope: `${GMAIL_SEND_SCOPE} https://www.googleapis.com/auth/gmail.readonly` }));
      }
      if (call.url === GOOGLE_REVOKE_ENDPOINT) return response(200, {});
      return response(404, {});
    });
    const client = clientFor(store, rec.fetch);

    const start = await client.startAuthorization({ principalId: 'owner', redirectUri: REDIRECT });
    await expect(client.completeAuthorization({ state: start.state, code: '4/0code' })).rejects.toMatchObject({
      code: 'SCOPE_NOT_ALLOWED',
    });

    expect(ALLOWED_GOOGLE_SCOPES).toEqual([GMAIL_SEND_SCOPE]);
    expect(store.list('app_connections')).toHaveLength(0);
    expect(store.secretMetadata().filter((entry) => entry.name.startsWith('app_connection:'))).toHaveLength(0);
    const revocation = rec.calls.find((call) => call.url === GOOGLE_REVOKE_ENDPOINT);
    expect(revocation?.body.get('token')).toBe(REFRESH_TOKEN);
  });

  it('rejects a grant that omits gmail.send', async () => {
    const store = openStore();
    const rec = recorder((call) => {
      if (call.url === GOOGLE_TOKEN_ENDPOINT) return response(200, tokenBody({ scope: 'openid email' }));
      return response(400, {});
    });
    const client = clientFor(store, rec.fetch);
    const start = await client.startAuthorization({ principalId: 'owner', redirectUri: REDIRECT });
    await expect(client.completeAuthorization({ state: start.state, code: '4/0code' })).rejects.toMatchObject({
      code: 'SCOPE_NOT_ALLOWED',
    });
    expect(store.list('app_connections')).toHaveLength(0);
  });

  it('classifies token exchange failures without persisting a connection', async () => {
    const store = openStore();
    const rec = recorder(() => response(400, { error: 'invalid_grant', error_description: 'Malformed auth code.' }));
    const client = clientFor(store, rec.fetch);
    const start = await client.startAuthorization({ principalId: 'owner', redirectUri: REDIRECT });
    await expect(client.completeAuthorization({ state: start.state, code: '4/0code' })).rejects.toMatchObject({
      name: 'OAuthError',
      code: 'TOKEN_EXCHANGE_FAILED',
      provider: { status: 400, error: 'invalid_grant' },
    });
    expect(store.list('app_connections')).toHaveLength(0);
    expect(store.list('oauth_pending')).toHaveLength(0);
  });

  it('refreshes an expired access token and reports EXPIRED until the refresh succeeds', async () => {
    const store = openStore();
    let clock = 1_700_000_000_000;
    const refetched = 'ya29.refreshed-access-token';
    const rec = recorder((call) => {
      if (call.url !== GOOGLE_TOKEN_ENDPOINT) return response(404, {});
      const grant = call.body.get('grant_type');
      if (grant === 'authorization_code') return response(200, tokenBody({ expires_in: 60 }));
      if (grant === 'refresh_token') {
        return response(200, { access_token: refetched, expires_in: 3599, scope: GMAIL_SEND_SCOPE, token_type: 'Bearer' });
      }
      return response(400, { error: 'unsupported_grant_type' });
    });
    const client = clientFor(store, rec.fetch, { now: () => clock });
    const connection = await connect(client);

    expect(client.connection(connection.id, 'owner')!.status).toBe('CONNECTED');
    clock += 61_000;
    expect(client.connection(connection.id, 'owner')!.status).toBe('EXPIRED');

    const token = await client.accessToken(connection.id, 'owner');
    expect(token.accessToken).toBe(refetched);
    expect(token.scopes).toEqual([GMAIL_SEND_SCOPE]);
    const refreshCall = rec.calls.at(-1)!;
    expect(refreshCall.url).toBe(GOOGLE_TOKEN_ENDPOINT);
    expect(refreshCall.body.get('grant_type')).toBe('refresh_token');
    expect(refreshCall.body.get('refresh_token')).toBe(REFRESH_TOKEN);
    expect(refreshCall.body.get('client_id')).toBe(CLIENT_ID);
    expect(client.connection(connection.id, 'owner')!.status).toBe('CONNECTED');
    expect(client.connection(connection.id, 'owner')!.lastRefreshedAt).toBe(clock);
    expect(rec.calls.filter((call) => call.url === GOOGLE_REVOKE_ENDPOINT)).toHaveLength(0);
  });

  it.each([
    ['success after revoke', 200, tokenBody({ access_token: 'new-access', refresh_token: 'new-refresh' }), false],
    ['failure after revoke', 400, { error: 'invalid_grant' }, false],
    ['success while revoke is pending', 200, tokenBody({ access_token: 'new-access', refresh_token: 'new-refresh' }), true],
    ['failure while revoke is pending', 400, { error: 'invalid_grant' }, true],
  ])('keeps revocation final on refresh %s', async (_label, status, body, revokePending) => {
    const store = openStore();
    let finishRefresh!: (value: OAuthFetchResponse) => void;
    let finishRevoke!: (value: OAuthFetchResponse) => void;
    const fetch: OAuthFetch = async (url, init) => {
      if (url === GOOGLE_REVOKE_ENDPOINT) {
        if (revokePending) return new Promise((resolve) => { finishRevoke = resolve; });
        return response(200, {});
      }
      if (new URLSearchParams(init.body).get('grant_type') === 'authorization_code') {
        return response(200, tokenBody());
      }
      return new Promise((resolve) => { finishRefresh = resolve; });
    };
    const refreshClient = clientFor(store, fetch);
    const revokeClient = clientFor(store, fetch);
    const connection = await connect(refreshClient);
    const refresh = refreshClient.refresh(connection.id, 'owner');
    const refreshResult = refresh.then(() => undefined, (error: unknown) => error);
    const revoke = revokeClient.revoke(connection.id, 'owner');
    if (!revokePending) await revoke;
    finishRefresh(response(status, body));
    expect(await refreshResult).toMatchObject({ code: 'CONNECTION_REVOKED' });
    if (revokePending) {
      finishRevoke(response(200, {}));
      await revoke;
    }
    expect(store.get<AppConnection>('app_connections', connection.id)?.status).toBe('REVOKED');
    expect(store.secretMetadata().filter((entry) => entry.name.startsWith(`app_connection:${connection.id}:`))).toHaveLength(0);
    expect(store.events().filter((event) => event.type === 'oauth.refreshed' || event.type === 'oauth.reauthorization_required')).toHaveLength(0);
  });

  it('does not assume a refresh scope when the stored scope is unknown', async () => {
    const store = openStore();
    const rec = recorder((call) => call.body.get('grant_type') === 'authorization_code'
      ? response(200, tokenBody())
      : response(200, { access_token: 'new-access', expires_in: 3600 }));
    const client = clientFor(store, rec.fetch);
    const connection = await connect(client);
    store.put('app_connections', connection.id, { ...connection, scopes: [] }, 'owner');
    await expect(client.refresh(connection.id, 'owner')).rejects.toMatchObject({ code: 'SCOPE_NOT_ALLOWED' });
    expect(store.getSecret(`app_connection:${connection.id}:access_token`)).toBe(ACCESS_TOKEN);
  });
  it('marks NEEDS_REAUTH and drops the refresh token when Google rejects it', async () => {
    const store = openStore();
    let clock = 1_700_000_000_000;
    const rec = recorder((call) => {
      if (call.url !== GOOGLE_TOKEN_ENDPOINT) return response(404, {});
      if (call.body.get('grant_type') === 'authorization_code') return response(200, tokenBody({ expires_in: 60 }));
      return response(400, { error: 'invalid_grant' });
    });
    const client = clientFor(store, rec.fetch, { now: () => clock });
    const connection = await connect(client);
    clock += 61_000;

    await expect(client.refresh(connection.id, 'owner')).rejects.toMatchObject({ code: 'REFRESH_REJECTED' });
    const updated = client.connection(connection.id, 'owner')!;
    expect(updated.status).toBe('NEEDS_REAUTH');
    expect(updated.refreshable).toBe(false);
    expect(updated.error?.code).toBe('REFRESH_REJECTED');
    expect(store.secretMetadata().filter((entry) => entry.name.endsWith(':refresh_token'))).toHaveLength(0);
    await expect(client.accessToken(connection.id, 'owner')).rejects.toMatchObject({
      code: 'REAUTHORIZATION_REQUIRED',
    });
    expect(store.events().some((event) => event.type === 'oauth.reauthorization_required')).toBe(true);
  });

  it('revokes at Google with the refresh token, deletes local secrets, and stays idempotent', async () => {
    const store = openStore();
    const rec = recorder((call) => {
      if (call.url === GOOGLE_TOKEN_ENDPOINT) return response(200, tokenBody());
      if (call.url === GOOGLE_REVOKE_ENDPOINT) return response(200, {});
      return response(404, {});
    });
    const client = clientFor(store, rec.fetch);
    const connection = await connect(client);

    await client.revoke(connection.id, 'owner');
    const revocation = rec.calls.find((call) => call.url === GOOGLE_REVOKE_ENDPOINT)!;
    expect(revocation.body.get('token')).toBe(REFRESH_TOKEN);
    expect(
      store.secretMetadata().filter((entry) => entry.name.startsWith(`app_connection:${connection.id}:`)),
    ).toHaveLength(0);
    expect(client.connection(connection.id, 'owner')!.status).toBe('REVOKED');
    expect(client.connection(connection.id, 'owner')!.revokedAt).toBeTypeOf('number');
    expect(client.publicStatus(connection.id)).toMatchObject({ status: 'REVOKED', needsReauthorization: true });
    expect(store.events().some((event) => event.type === 'oauth.revoked')).toBe(true);
    await expect(client.accessToken(connection.id, 'owner')).rejects.toMatchObject({ code: 'CONNECTION_REVOKED' });
    await expect(client.refresh(connection.id, 'owner')).rejects.toMatchObject({ code: 'CONNECTION_REVOKED' });

    const before = rec.calls.length;
    await client.revoke(connection.id, 'owner');
    expect(rec.calls).toHaveLength(before);
    expect(client.connection(connection.id, 'owner')!.status).toBe('REVOKED');
  });

  it('completes local revocation when the Google revoke endpoint is unreachable', async () => {
    const store = openStore();
    const rec = recorder((call) => {
      if (call.url === GOOGLE_TOKEN_ENDPOINT) return response(200, tokenBody());
      throw new Error('socket hang up');
    });
    const client = clientFor(store, rec.fetch);
    const connection = await connect(client);

    await client.revoke(connection.id, 'owner');
    const updated = client.connection(connection.id, 'owner')!;
    expect(updated.status).toBe('REVOKED');
    expect(updated.error?.code).toBe('REVOKE_FAILED');
    expect(store.secretMetadata().filter((entry) => entry.name.startsWith('app_connection:'))).toHaveLength(0);
  });

  it('reports NEEDS_REAUTH, not CONNECTED, when restored data has no secrets', async () => {
    const store = openStore();
    const rec = recorder((call) => (call.url === GOOGLE_TOKEN_ENDPOINT ? response(200, tokenBody()) : response(404, {})));
    const client = clientFor(store, rec.fetch);
    const connection = await connect(client);

    store.deleteSecret(`app_connection:${connection.id}:access_token`);
    store.deleteSecret(`app_connection:${connection.id}:refresh_token`);

    // The stored record is unchanged; every read path derives the truth from secret presence.
    expect(store.get<AppConnection>('app_connections', connection.id)!.status).toBe('CONNECTED');
    expect(client.connection(connection.id, 'owner')).toMatchObject({
      status: 'NEEDS_REAUTH',
      refreshable: false,
      error: { code: 'SECRETS_MISSING' },
    });
    expect(client.publicStatus(connection.id)).toMatchObject({
      status: 'NEEDS_REAUTH',
      needsReauthorization: true,
    });
    await expect(client.accessToken(connection.id, 'owner')).rejects.toMatchObject({
      code: 'REAUTHORIZATION_REQUIRED',
    });
    await expect(client.refresh(connection.id, 'owner')).rejects.toMatchObject({ code: 'REFRESH_TOKEN_MISSING' });
  });

  it('serves connection state to the Owner only and calls only the fixed Google endpoints', async () => {
    const store = openStore();
    const rec = recorder((call) => (call.url === GOOGLE_TOKEN_ENDPOINT ? response(200, tokenBody()) : response(404, {})));
    const client = clientFor(store, rec.fetch);
    const connection = await connect(client);
    await client.refresh(connection.id, 'owner');

    expect(client.connection(connection.id, 'owner')).toMatchObject({ id: connection.id, provider: 'google' });
    expect(syncCode(() => client.connection(connection.id, 'agent-1'))).toBe('OWNER_REQUIRED');
    expect(syncCode(() => client.connections('agent-1'))).toBe('OWNER_REQUIRED');
    expect(syncCode(() => client.publicStatus(connection.id))).toBeUndefined();
    expect(client.connections('owner')).toHaveLength(1);
    expect(client.connection('missing', 'owner')).toBeUndefined();
    expect(client.publicStatus('missing')).toBeUndefined();
    await expect(client.refresh('missing', 'owner')).rejects.toMatchObject({ code: 'CONNECTION_NOT_FOUND' });
    await expect(client.revoke('missing', 'owner')).rejects.toMatchObject({ code: 'CONNECTION_NOT_FOUND' });
    await expect(client.accessToken(connection.id, 'agent-1')).rejects.toMatchObject({ code: 'OWNER_REQUIRED' });

    // Transport injection cannot change targets: every call went to a fixed production endpoint.
    expect(rec.calls.length).toBeGreaterThan(1);
    for (const call of rec.calls) expect(FIXED_ENDPOINTS.has(call.url)).toBe(true);
    expect(store.list('app_connections')).toHaveLength(1);
  });
});
