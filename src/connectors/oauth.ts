import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { ControlStore } from '../control/store.js';

/** Google OAuth 2.0 authorization endpoint used by the connector. */
export const GOOGLE_AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
/** Google OAuth 2.0 token endpoint used for code exchange and refresh. */
export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
/** Google OAuth 2.0 revocation endpoint used on disconnect. */
export const GOOGLE_REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';
/** The single Gmail scope this connector may request (Google "Sensitive" scope). */
export const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
/** Allowlist of granted scopes. Requesting or receiving anything else fails closed. */
export const ALLOWED_GOOGLE_SCOPES: readonly string[] = Object.freeze([GMAIL_SEND_SCOPE]);
/** The only principal that may create, refresh, revoke, or read a connection. */
export const OWNER_PRINCIPAL_ID = 'owner';

const PROVIDER = 'google';
const PENDING_KIND = 'oauth_pending';
const CONNECTION_KIND = 'app_connections';
const DEFAULT_STATE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_REFRESH_SKEW_MS = 60 * 1000;
const DEFAULT_EXPIRES_IN_SECONDS = 3600;
const MAX_STATE_LENGTH = 512;
const MAX_CODE_LENGTH = 4096;
const CODE_VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;

/** Connection lifecycle shared by app connectors (CONN-006). */
export type ConnectionStatus =
  | 'DISCONNECTED'
  | 'AUTH_PENDING'
  | 'CONNECTED'
  | 'EXPIRED'
  | 'NEEDS_REAUTH'
  | 'ERROR'
  | 'REVOKED';

export type OAuthErrorCode =
  | 'OWNER_REQUIRED'
  | 'CONFIG_INVALID'
  | 'REDIRECT_URI_NOT_ALLOWED'
  | 'STATE_INVALID'
  | 'STATE_EXPIRED'
  | 'CODE_INVALID'
  | 'TOKEN_EXCHANGE_FAILED'
  | 'TOKEN_RESPONSE_INVALID'
  | 'SCOPE_NOT_ALLOWED'
  | 'CONNECTION_NOT_FOUND'
  | 'CONNECTION_REVOKED'
  | 'REAUTHORIZATION_REQUIRED'
  | 'REFRESH_TOKEN_MISSING'
  | 'REFRESH_REJECTED'
  | 'REFRESH_FAILED'
  | 'REVOKE_FAILED'
  | 'SECRETS_MISSING'
  | 'NETWORK_ERROR';

/** Redacted projection of a Google OAuth error response. Never contains credentials. */
export interface GoogleProviderError {
  status: number;
  error?: string;
  description?: string;
}

export class OAuthError extends Error {
  readonly code: OAuthErrorCode;
  readonly provider?: GoogleProviderError;
  constructor(code: OAuthErrorCode, message?: string, provider?: GoogleProviderError, options?: { cause?: unknown }) {
    super(message ?? code, options);
    this.name = 'OAuthError';
    this.code = code;
    this.provider = provider;
  }
}

/** Minimal response shape so tests can inject a fake fetch without real network access. */
export interface OAuthFetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export interface OAuthFetchRequest {
  method: 'POST';
  headers: Record<string, string>;
  body: string;
  redirect: 'error';
  signal: AbortSignal;
}

/** Injectable fetch used for every Google endpoint call. */
export type OAuthFetch = (url: string, init: OAuthFetchRequest) => Promise<OAuthFetchResponse>;

export interface GoogleOAuthConfig {
  /** Google OAuth client ID of a Web application client. */
  clientId: string;
  /** Client secret; optional for public PKCE clients, required by Google for Web clients. */
  clientSecret?: string;
  /** Exact HTTPS redirect allowlist. Entries must be canonical, fragment-free HTTPS URLs. */
  redirectUris: readonly string[];
  /** Test seam: replaces the global fetch. Defaults to globalThis.fetch. */
  fetch?: OAuthFetch;
  /** Clock seam for expiry checks. Defaults to Date.now. */
  now?: () => number;
  /** Authorization request lifetime. Defaults to 10 minutes. */
  stateTtlMs?: number;
  /** Refresh an access token when it expires within this window. Defaults to 60 seconds. */
  refreshSkewMs?: number;
}

export interface StartAuthorizationInput {
  /** Caller identity; only the Owner may connect an account. */
  principalId: string;
  /** Must match one allowlisted redirect URI byte for byte. */
  redirectUri: string;
}

export interface AuthorizationStart {
  authorizationUrl: string;
  state: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  scopes: readonly string[];
  expiresAt: number;
}

export interface AuthorizationCallback {
  /**
   * Optional caller identity. A Google GET redirect can arrive without an Owner cookie,
   * so the one-time state is the proof of the flow; when a principal is supplied it must
   * match the owner bound to that state.
   */
  principalId?: string;
  state: string;
  code: string;
}

/** Pending authorization kept in ControlStore; the PKCE verifier is a separate encrypted secret. */
export interface PendingAuthorization {
  /** SHA-256 hex of the state value; also the entity id and secret-name suffix. */
  id: string;
  provider: typeof PROVIDER;
  ownerId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  createdAt: number;
  expiresAt: number;
}

/** Persisted connection metadata. Tokens live only in encrypted ControlStore secrets. */
export interface AppConnection {
  id: string;
  provider: typeof PROVIDER;
  ownerId: string;
  scopes: string[];
  status: ConnectionStatus;
  createdAt: number;
  updatedAt: number;
  lastAuthorizedAt: number;
  lastRefreshedAt?: number;
  tokenExpiresAt?: number;
  refreshable: boolean;
  revokedAt?: number;
  error?: { code: OAuthErrorCode; message: string; at: number };
}

export interface AccessToken {
  connectionId: string;
  accessToken: string;
  expiresAt: number;
  scopes: readonly string[];
}

interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  scope?: string;
}

function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sha256Base64Url(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

function equalsHex(left: string, right: string): boolean {
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

function requireOwner(principalId: string): void {
  if (principalId !== OWNER_PRINCIPAL_ID) {
    throw new OAuthError('OWNER_REQUIRED', 'Only the authenticated Owner may manage app connections.');
  }
}

function validateRedirectUris(uris: readonly string[]): readonly string[] {
  if (!Array.isArray(uris) || uris.length === 0) {
    throw new OAuthError('CONFIG_INVALID', 'At least one HTTPS redirect URI is required.');
  }
  for (const uri of uris) {
    if (typeof uri !== 'string' || uri === '') {
      throw new OAuthError('CONFIG_INVALID', 'Redirect URIs must be non-empty strings.');
    }
    let parsed: URL;
    try {
      parsed = new URL(uri);
    } catch {
      throw new OAuthError('CONFIG_INVALID', `Redirect URI is not an absolute URL: ${uri}`);
    }
    if (parsed.protocol !== 'https:') {
      throw new OAuthError('CONFIG_INVALID', `Redirect URI must use HTTPS: ${uri}`);
    }
    if (parsed.hash !== '') {
      throw new OAuthError('CONFIG_INVALID', `Redirect URI must not contain a fragment: ${uri}`);
    }
    if (parsed.username !== '' || parsed.password !== '') {
      throw new OAuthError('CONFIG_INVALID', `Redirect URI must not contain credentials: ${uri}`);
    }
    if (parsed.toString() !== uri) {
      throw new OAuthError('CONFIG_INVALID', `Redirect URI must be canonical: ${uri} (expected ${parsed.toString()})`);
    }
  }
  return [...uris];
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

async function safeText(response: OAuthFetchResponse): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

async function readProviderError(response: OAuthFetchResponse): Promise<GoogleProviderError> {
  const parsed = parseJsonObject(await safeText(response));
  const error = parsed && typeof parsed.error === 'string' && parsed.error !== '' ? parsed.error : undefined;
  const description =
    parsed && typeof parsed.error_description === 'string' && parsed.error_description !== ''
      ? parsed.error_description
      : undefined;
  return {
    status: response.status,
    ...(error === undefined ? {} : { error }),
    ...(description === undefined ? {} : { description }),
  };
}

function expiresInSeconds(value: unknown): number {
  const parsed = typeof value === 'string' ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed) || parsed <= 0) return DEFAULT_EXPIRES_IN_SECONDS;
  return Math.min(parsed, 24 * 60 * 60);
}

function isReauthFailure(provider: GoogleProviderError | undefined): boolean {
  if (!provider) return false;
  if (provider.error === 'invalid_client') return false;
  if (provider.error === 'invalid_grant' || provider.error === 'invalid_scope' || provider.error === 'unauthorized_client') {
    return true;
  }
  return provider.status === 400 || provider.status === 401;
}

/** Redacted connection view for display paths that have no Owner session. */
export interface PublicConnectionStatus {
  id: string;
  provider: typeof PROVIDER;
  status: ConnectionStatus;
  scopes: readonly string[];
  expiresAt?: number;
  needsReauthorization: boolean;
}

/**
 * Google OAuth 2.0 Authorization Code + PKCE client for app connectors.
 *
 * Guarantees:
 * - Only the Owner principal may start, complete, refresh, revoke, or read a connection.
 * - Every authorization request uses one-time state plus S256 PKCE; both are consumed before code exchange.
 * - Redirect URIs are compared byte for byte against a canonical HTTPS allowlist.
 * - Only `gmail.send` may be requested or granted; anything else fails closed.
 * - Access and refresh tokens exist only as AES-256-GCM secrets in ControlStore.
 * - Endpoints are fixed Google production URLs; the injectable fetch replaces transport only and cannot
 *   redirect or override a request target.
 */

/** Owner-only cleanup of one pending flow, including its encrypted PKCE verifier. */
export function discardPendingAuthorization(store: ControlStore, stateHash: string, principalId: string): boolean {
  if (principalId !== OWNER_PRINCIPAL_ID) throw new OAuthError('OWNER_REQUIRED');
  if (!/^[a-f0-9]{64}$/.test(stateHash)) throw new OAuthError('STATE_INVALID');
  return store.transaction(() => {
    const name = `oauth_pending:${stateHash}:code_verifier`;
    const pending = store.get(PENDING_KIND, stateHash), secret = store.secretMetadata().some(s => s.name === name);
    if (pending) store.remove(PENDING_KIND, stateHash, principalId);
    if (secret) store.deleteSecret(name);
    return Boolean(pending || secret);
  });
}

export class GoogleOAuthClient {
  private readonly clientId: string;
  private readonly clientSecret: string | undefined;
  private readonly redirectUris: readonly string[];
  private readonly fetcher: OAuthFetch;
  private readonly clock: () => number;
  private readonly stateTtlMs: number;
  private readonly refreshSkewMs: number;

  constructor(
    private readonly store: ControlStore,
    config: GoogleOAuthConfig,
  ) {
    if (typeof config.clientId !== 'string' || config.clientId.trim() === '') {
      throw new OAuthError('CONFIG_INVALID', 'A Google OAuth client ID is required.');
    }
    if (config.clientSecret !== undefined && (typeof config.clientSecret !== 'string' || config.clientSecret.trim() === '')) {
      throw new OAuthError('CONFIG_INVALID', 'The Google OAuth client secret must be a non-empty string when configured.');
    }
    const ttl = config.stateTtlMs ?? DEFAULT_STATE_TTL_MS;
    if (!Number.isFinite(ttl) || ttl <= 0) {
      throw new OAuthError('CONFIG_INVALID', 'stateTtlMs must be a positive number.');
    }
    const skew = config.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS;
    if (!Number.isFinite(skew) || skew < 0) {
      throw new OAuthError('CONFIG_INVALID', 'refreshSkewMs must not be negative.');
    }
    this.clientId = config.clientId;
    this.clientSecret = config.clientSecret;
    this.redirectUris = validateRedirectUris(config.redirectUris);
    this.fetcher = config.fetch ?? ((url, init) => globalThis.fetch(url, init));
    this.clock = config.now ?? Date.now;
    this.stateTtlMs = ttl;
    this.refreshSkewMs = skew;
  }

  /** Build the Google authorization URL and persist a one-time pending request. */
  async startAuthorization(input: StartAuthorizationInput): Promise<AuthorizationStart> {
    requireOwner(input.principalId);
    if (typeof input.redirectUri !== 'string' || !this.redirectUris.includes(input.redirectUri)) {
      throw new OAuthError(
        'REDIRECT_URI_NOT_ALLOWED',
        `The redirect URI is not in the exact HTTPS allowlist: ${String(input.redirectUri)}`,
      );
    }
    const now = this.clock();
    const state = randomToken();
    const codeVerifier = randomToken();
    const codeChallenge = sha256Base64Url(codeVerifier);
    const id = sha256Hex(state);
    const pending: PendingAuthorization = {
      id,
      provider: PROVIDER,
      ownerId: OWNER_PRINCIPAL_ID,
      redirectUri: input.redirectUri,
      codeChallenge,
      scopes: [...ALLOWED_GOOGLE_SCOPES],
      createdAt: now,
      expiresAt: now + this.stateTtlMs,
    };
    this.store.transaction(() => {
      this.store.put(PENDING_KIND, id, pending, OWNER_PRINCIPAL_ID);
      this.store.setSecret(this.verifierSecretName(id), codeVerifier);
    });
    this.store.event('oauth.authorization_started', id, { provider: PROVIDER, scopes: pending.scopes });

    const url = new URL(GOOGLE_AUTHORIZATION_ENDPOINT);
    const params = url.searchParams;
    params.set('client_id', this.clientId);
    params.set('redirect_uri', input.redirectUri);
    params.set('response_type', 'code');
    params.set('scope', GMAIL_SEND_SCOPE);
    params.set('state', state);
    params.set('code_challenge', codeChallenge);
    params.set('code_challenge_method', 'S256');
    params.set('access_type', 'offline');
    params.set('prompt', 'consent');
    params.set('include_granted_scopes', 'false');
    return {
      authorizationUrl: url.toString(),
      state,
      codeChallenge,
      codeChallengeMethod: 'S256',
      scopes: [...ALLOWED_GOOGLE_SCOPES],
      expiresAt: pending.expiresAt,
    };
  }

  /**
   * Verify the one-time state and its owner/redirect binding, consume it, then exchange the code.
   * The Owner cookie is optional: the state is the proof, and it is bound to owner plus redirect URI.
   */
  async completeAuthorization(input: AuthorizationCallback): Promise<AppConnection> {
    if (input.principalId !== undefined && input.principalId !== OWNER_PRINCIPAL_ID) {
      throw new OAuthError('OWNER_REQUIRED', 'Only the authenticated Owner may manage app connections.');
    }
    if (typeof input.state !== 'string' || input.state === '' || input.state.length > MAX_STATE_LENGTH) {
      throw new OAuthError('STATE_INVALID', 'The OAuth state value is missing or malformed.');
    }
    if (typeof input.code !== 'string' || input.code === '' || input.code.length > MAX_CODE_LENGTH) {
      throw new OAuthError('CODE_INVALID', 'The authorization code is missing or malformed.');
    }
    const stateHash = sha256Hex(input.state);
    const pending = this.store.get<PendingAuthorization>(PENDING_KIND, stateHash);
    if (!pending) {
      throw new OAuthError('STATE_INVALID', 'The OAuth state is unknown, already used, or expired.');
    }
    if (
      typeof pending.id !== 'string' ||
      !equalsHex(pending.id, stateHash) ||
      pending.provider !== PROVIDER ||
      typeof pending.ownerId !== 'string' ||
      typeof pending.redirectUri !== 'string' ||
      typeof pending.codeChallenge !== 'string'
    ) {
      this.consumePending(stateHash);
      throw new OAuthError('STATE_INVALID', 'The pending authorization record is invalid.');
    }
    if (pending.ownerId !== OWNER_PRINCIPAL_ID || (input.principalId !== undefined && pending.ownerId !== input.principalId)) {
      throw new OAuthError('OWNER_REQUIRED', 'This authorization was started by a different principal.');
    }
    const now = this.clock();
    if (!(pending.expiresAt > now)) {
      this.consumePending(stateHash);
      throw new OAuthError('STATE_EXPIRED', 'The OAuth state expired; start the connection again.');
    }
    if (!this.redirectUris.includes(pending.redirectUri)) {
      this.consumePending(stateHash);
      throw new OAuthError('REDIRECT_URI_NOT_ALLOWED', 'The redirect URI is no longer allowlisted.');
    }
    const codeVerifier = this.store.getSecret(this.verifierSecretName(stateHash));
    // Single use: consume state and verifier before any network exchange.
    this.consumePending(stateHash);
    if (typeof codeVerifier !== 'string' || !CODE_VERIFIER_PATTERN.test(codeVerifier)) {
      throw new OAuthError('STATE_INVALID', 'The PKCE code verifier is missing or malformed.');
    }
    const tokens = await this.requestToken(
      {
        grant_type: 'authorization_code',
        code: input.code,
        redirect_uri: pending.redirectUri,
        client_id: this.clientId,
        code_verifier: codeVerifier,
        ...(this.clientSecret === undefined ? {} : { client_secret: this.clientSecret }),
      },
      'TOKEN_EXCHANGE_FAILED',
    );
    let scopes: string[];
    try {
      scopes = this.grantedScopes(tokens.scope);
    } catch (error) {
      await this.remoteRevoke(tokens.refreshToken ?? tokens.accessToken);
      throw error;
    }
    const connectionId = `gmail_${randomUUID()}`;
    const connection: AppConnection = {
      id: connectionId,
      provider: PROVIDER,
      ownerId: OWNER_PRINCIPAL_ID,
      scopes: [...scopes],
      status: 'CONNECTED',
      createdAt: now,
      updatedAt: now,
      lastAuthorizedAt: now,
      tokenExpiresAt: tokens.expiresAt,
      refreshable: tokens.refreshToken !== undefined,
    };
    this.store.transaction(() => {
      this.store.put(CONNECTION_KIND, connectionId, connection, OWNER_PRINCIPAL_ID);
      this.store.setSecret(this.accessSecretName(connectionId), tokens.accessToken);
      if (tokens.refreshToken !== undefined) {
        this.store.setSecret(this.refreshSecretName(connectionId), tokens.refreshToken);
      }
    });
    this.store.event('oauth.connected', connectionId, { provider: PROVIDER, scopes: connection.scopes });
    return connection;
  }

  /** Exchange the stored refresh token for a new access token. */
  async refresh(connectionId: string, principalId: string): Promise<AppConnection> {
    requireOwner(principalId);
    const connection = this.mustConnection(connectionId);
    if (connection.status === 'REVOKED') {
      throw new OAuthError('CONNECTION_REVOKED', 'This Google connection was revoked; authorize again.');
    }
    const refreshToken = this.readSecret(this.refreshSecretName(connectionId));
    if (refreshToken === undefined) {
      this.markNeedsReauth(connectionId, 'REFRESH_TOKEN_MISSING', 'Google returned no refresh token; authorize again.');
      throw new OAuthError('REFRESH_TOKEN_MISSING', 'Google returned no refresh token for this connection; authorize again.');
    }
    let tokens: TokenSet;
    try {
      tokens = await this.requestToken(
        {
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: this.clientId,
          ...(this.clientSecret === undefined ? {} : { client_secret: this.clientSecret }),
        },
        'REFRESH_FAILED',
      );
    } catch (error) {
      if (this.mustConnection(connectionId).status === 'REVOKED') {
        throw new OAuthError('CONNECTION_REVOKED', 'This Google connection was revoked; authorize again.');
      }
      if (error instanceof OAuthError && error.code === 'REFRESH_FAILED' && isReauthFailure(error.provider)) {
        this.markNeedsReauth(connectionId, 'REFRESH_REJECTED', 'Google rejected the stored refresh token; authorize again.');
        throw new OAuthError(
          'REFRESH_REJECTED',
          'Google rejected the stored refresh token; authorize again.',
          error.provider,
          { cause: error },
        );
      }
      throw error;
    }
    const now = this.clock();
    return this.store.transaction(() => {
      const current = this.mustConnection(connectionId);
      if (current.status === 'REVOKED') {
        throw new OAuthError('CONNECTION_REVOKED', 'This Google connection was revoked; authorize again.');
      }
      const scope = tokens.scope ?? (Array.isArray(current.scopes) ? current.scopes.join(' ') : '');
      if (scope.trim() === '') {
        throw new OAuthError('SCOPE_NOT_ALLOWED', 'The refresh token scope is unknown.');
      }
      const scopes = this.grantedScopes(scope);
      this.store.setSecret(this.accessSecretName(connectionId), tokens.accessToken);
      if (tokens.refreshToken !== undefined) {
        this.store.setSecret(this.refreshSecretName(connectionId), tokens.refreshToken);
      }
      const updated = this.patch(connectionId, {
        status: 'CONNECTED',
        scopes: [...scopes],
        tokenExpiresAt: tokens.expiresAt,
        refreshable: true,
        lastRefreshedAt: now,
        error: undefined,
      });
      this.store.event('oauth.refreshed', connectionId, { provider: PROVIDER });
      return updated;
    });
  }

  /** Revoke at Google when possible, delete local secrets, and keep the record for audit. */
  async revoke(connectionId: string, principalId: string): Promise<void> {
    requireOwner(principalId);
    const connection = this.mustConnection(connectionId);
    if (connection.status === 'REVOKED') {
      this.clearTokens(connectionId);
      return;
    }
    const token =
      this.readSecret(this.refreshSecretName(connectionId)) ??
      this.readSecret(this.accessSecretName(connectionId));
    const now = this.clock();
    this.store.transaction(() => {
      this.clearTokens(connectionId);
      this.patch(connectionId, {
        status: 'REVOKED',
        refreshable: false,
        tokenExpiresAt: undefined,
        revokedAt: now,
        error: undefined,
      });
    });
    const revokedRemotely = token === undefined ? true : await this.remoteRevoke(token);
    this.store.transaction(() => {
      const current = this.mustConnection(connectionId);
      if (current.status === 'REVOKED' && current.revokedAt === now && !revokedRemotely) {
        this.patch(connectionId, {
          error: {
            code: 'REVOKE_FAILED',
            message: 'Google did not confirm the token revocation; local credentials were deleted.',
            at: now,
          },
        });
      }
      this.store.event('oauth.revoked', connectionId, { provider: PROVIDER, remote: revokedRemotely });
    });
  }

  /** Current connection view with derived EXPIRED/NEEDS_REAUTH state. Owner-only. */
  connection(connectionId: string, principalId: string): AppConnection | undefined {
    requireOwner(principalId);
    const connection = this.store.get<AppConnection>(CONNECTION_KIND, connectionId);
    if (!connection || connection.provider !== PROVIDER) return undefined;
    return this.derive(connection);
  }

  /** All Google connections. Owner-only. */
  connections(principalId: string): AppConnection[] {
    requireOwner(principalId);
    return this.store
      .list<AppConnection>(CONNECTION_KIND)
      .filter((connection) => connection.provider === PROVIDER)
      .map((connection) => this.derive(connection));
  }

  /** Redacted status for display paths without an Owner session; never reports a false CONNECTED. */
  publicStatus(connectionId: string): PublicConnectionStatus | undefined {
    const connection = this.store.get<AppConnection>(CONNECTION_KIND, connectionId);
    if (!connection || connection.provider !== PROVIDER) return undefined;
    const derived = this.derive(connection);
    return {
      id: derived.id,
      provider: PROVIDER,
      status: derived.status,
      scopes: derived.scopes,
      ...(derived.tokenExpiresAt === undefined ? {} : { expiresAt: derived.tokenExpiresAt }),
      needsReauthorization:
        derived.status === 'NEEDS_REAUTH' || derived.status === 'ERROR' || derived.status === 'REVOKED',
    };
  }

  /** Short-lived access token for an authorized action; refreshes automatically when near expiry. */
  async accessToken(connectionId: string, principalId: string): Promise<AccessToken> {
    requireOwner(principalId);
    const connection = this.derive(this.mustConnection(connectionId));
    if (connection.status === 'REVOKED') {
      throw new OAuthError('CONNECTION_REVOKED', 'This Google connection was revoked; authorize again.');
    }
    if (connection.status !== 'CONNECTED' && connection.status !== 'EXPIRED') {
      throw new OAuthError('REAUTHORIZATION_REQUIRED', 'The Google connection needs a new Owner authorization.');
    }
    const now = this.clock();
    const stored = this.readSecret(this.accessSecretName(connectionId));
    if (stored !== undefined && connection.tokenExpiresAt !== undefined && connection.tokenExpiresAt - now > this.refreshSkewMs) {
      return { connectionId, accessToken: stored, expiresAt: connection.tokenExpiresAt, scopes: connection.scopes };
    }
    const refreshed = await this.refresh(connectionId, principalId);
    const accessToken = this.readSecret(this.accessSecretName(connectionId));
    if (accessToken === undefined) {
      throw new OAuthError('TOKEN_RESPONSE_INVALID', 'No access token is stored for this connection.');
    }
    return { connectionId, accessToken, expiresAt: refreshed.tokenExpiresAt ?? now, scopes: refreshed.scopes };
  }

  private async requestToken(params: Record<string, string>, failureCode: OAuthErrorCode): Promise<TokenSet> {
    const response = await this.post(GOOGLE_TOKEN_ENDPOINT, params);
    if (!response.ok) {
      const provider = await readProviderError(response);
      throw new OAuthError(
        failureCode,
        `Google token endpoint rejected the request (HTTP ${provider.status}${provider.error === undefined ? '' : `: ${provider.error}`}).`,
        provider,
      );
    }
    const parsed = parseJsonObject(await safeText(response));
    const accessToken = parsed && typeof parsed.access_token === 'string' ? parsed.access_token : '';
    if (accessToken === '') {
      throw new OAuthError('TOKEN_RESPONSE_INVALID', 'Google token endpoint returned no access token.');
    }
    const refreshToken =
      parsed && typeof parsed.refresh_token === 'string' && parsed.refresh_token !== '' ? parsed.refresh_token : undefined;
    const scope = parsed && typeof parsed.scope === 'string' ? parsed.scope : undefined;
    return {
      accessToken,
      ...(refreshToken === undefined ? {} : { refreshToken }),
      expiresAt: this.clock() + expiresInSeconds(parsed?.expires_in) * 1000,
      ...(scope === undefined ? {} : { scope }),
    };
  }

  private async post(url: string, params: Record<string, string>): Promise<OAuthFetchResponse> {
    try {
      return await this.fetcher(url, {
        method: 'POST',
        redirect: 'error', signal: AbortSignal.timeout(30000),
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams(params).toString(),
      });
    } catch (error) {
      throw new OAuthError('NETWORK_ERROR', 'OAuth endpoint request failed.', undefined, { cause: error });
    }
  }

  private async remoteRevoke(token: string): Promise<boolean> {
    try {
      const response = await this.fetcher(GOOGLE_REVOKE_ENDPOINT, {
        method: 'POST',
        redirect: 'error', signal: AbortSignal.timeout(30000),
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ token }).toString(),
      });
      // 400 invalid_token means the credential is already unusable, which satisfies revocation.
      return response.ok || response.status === 400;
    } catch {
      return false;
    }
  }

  private grantedScopes(raw: string | undefined): string[] {
    const requested = (raw ?? '').split(/\s+/).filter((scope) => scope !== '');
    const granted = [...new Set(requested.length === 0 ? [GMAIL_SEND_SCOPE] : requested)];
    const unexpected = granted.filter((scope) => !ALLOWED_GOOGLE_SCOPES.includes(scope));
    if (unexpected.length > 0) {
      throw new OAuthError('SCOPE_NOT_ALLOWED', `Google granted scopes outside the allowlist: ${unexpected.join(', ')}`);
    }
    if (!granted.includes(GMAIL_SEND_SCOPE)) {
      throw new OAuthError('SCOPE_NOT_ALLOWED', 'Google did not grant the gmail.send scope.');
    }
    return [GMAIL_SEND_SCOPE];
  }

  private mustConnection(connectionId: string): AppConnection {
    const connection = this.store.get<AppConnection>(CONNECTION_KIND, connectionId);
    if (
      !connection ||
      connection.provider !== PROVIDER ||
      typeof connection.id !== 'string' ||
      typeof connection.status !== 'string'
    ) {
      throw new OAuthError('CONNECTION_NOT_FOUND', `No Google connection exists: ${connectionId}`);
    }
    if (connection.ownerId !== OWNER_PRINCIPAL_ID) {
      throw new OAuthError('OWNER_REQUIRED', 'Only the authenticated Owner may manage app connections.');
    }
    return connection;
  }

  /** Never report CONNECTED without decryptable credentials; a restore without secrets needs reauthorization. */
  private derive(connection: AppConnection): AppConnection {
    if (connection.status !== 'CONNECTED' && connection.status !== 'EXPIRED') return connection;
    const now = this.clock();
    const access = this.readSecret(this.accessSecretName(connection.id));
    const refresh = this.readSecret(this.refreshSecretName(connection.id));
    if (access === undefined && refresh === undefined) {
      return {
        ...connection,
        status: 'NEEDS_REAUTH',
        refreshable: false,
        error: {
          code: 'SECRETS_MISSING',
          message: 'Stored credentials are missing; authorize this account again.',
          at: now,
        },
      };
    }
    if (access === undefined || (connection.tokenExpiresAt !== undefined && connection.tokenExpiresAt <= now)) {
      return { ...connection, status: 'EXPIRED' };
    }
    return connection;
  }

  private readSecret(name: string): string | undefined {
    try {
      return this.store.getSecret(name);
    } catch {
      return undefined;
    }
  }

  private patch(connectionId: string, changes: Partial<AppConnection>): AppConnection {
    const current = this.mustConnection(connectionId);
    const updated: AppConnection = { ...current, ...changes, updatedAt: this.clock() };
    this.store.put(CONNECTION_KIND, connectionId, updated, OWNER_PRINCIPAL_ID);
    return updated;
  }

  private markNeedsReauth(connectionId: string, code: OAuthErrorCode, message: string): AppConnection {
    return this.store.transaction(() => {
      if (this.mustConnection(connectionId).status === 'REVOKED') {
        throw new OAuthError('CONNECTION_REVOKED', 'This Google connection was revoked; authorize again.');
      }
      this.clearTokens(connectionId);
      const updated = this.patch(connectionId, {
        status: 'NEEDS_REAUTH',
        refreshable: false,
        error: { code, message, at: this.clock() },
      });
      this.store.event('oauth.reauthorization_required', connectionId, { code });
      return updated;
    });
  }

  private clearTokens(connectionId: string): void {
    const names = new Set(this.store.secretMetadata().map((entry) => entry.name));
    const access = this.accessSecretName(connectionId);
    const refresh = this.refreshSecretName(connectionId);
    if (names.has(access)) this.store.deleteSecret(access);
    if (names.has(refresh)) this.store.deleteSecret(refresh);
  }

  private consumePending(stateHash: string): void {
    this.store.transaction(() => {
      if (this.store.get<PendingAuthorization>(PENDING_KIND, stateHash) !== undefined) {
        this.store.remove(PENDING_KIND, stateHash, OWNER_PRINCIPAL_ID);
      }
      const verifier = this.verifierSecretName(stateHash);
      if (this.store.secretMetadata().some((entry) => entry.name === verifier)) {
        this.store.deleteSecret(verifier);
      }
    });
  }

  private verifierSecretName(stateHash: string): string {
    return `oauth_pending:${stateHash}:code_verifier`;
  }

  private accessSecretName(connectionId: string): string {
    return `app_connection:${connectionId}:access_token`;
  }

  private refreshSecretName(connectionId: string): string {
    return `app_connection:${connectionId}:refresh_token`;
  }
}
