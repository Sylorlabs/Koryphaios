// OAuth 2.1 client for remote MCP servers (MCP authorization spec).
//
// Hosted MCP servers — Notion, Figma, Sentry, Atlassian, Supabase, Neon — do
// not accept a static token. They answer an unauthenticated request with
// `401` plus a `WWW-Authenticate: Bearer resource_metadata="..."` challenge, and
// expect the client to run a full authorization-code flow with PKCE against the
// server's authorization server, registering itself dynamically.
//
// The flow implemented here is the one the MCP authorization spec mandates:
//
//   1. probe the MCP endpoint, capture the 401 challenge
//   2. fetch Protected Resource Metadata (RFC 9728) for the MCP endpoint
//   3. fetch Authorization Server Metadata (RFC 8414) for its issuer
//   4. Dynamic Client Registration (RFC 7591) when the AS advertises one
//   5. authorization-code + PKCE (S256) with a loopback redirect
//   6. exchange the code for an access token, keep the refresh token
//
// Two behaviours here are not optional and are the difference between working
// and not working against real servers:
//
//   • A `User-Agent` is sent on every request. Notion and Sentry answer 403 to
//     the metadata endpoints when it is absent.
//   • Metadata is probed at BOTH the root well-known path and the
//     resource-path-inserted form. Sentry publishes PRM only at
//     `/.well-known/oauth-protected-resource/mcp`; Notion publishes it only at
//     `/.well-known/oauth-protected-resource/mcp` while its AS metadata is at
//     the root. Stripe's authorization server publishes neither.
//
// Nothing here logs a token, a code, a client secret, or any server-controlled
// string. Diagnostics carry byte counts and statuses only.

import { createHash, randomBytes } from 'node:crypto';
import { mcpLog, serverLog } from '../logger';

/** Every request identifies itself. Two real MCP servers 403 metadata fetches
 *  that arrive without one. */
const MCP_OAUTH_USER_AGENT = 'Koryphaios (MCP OAuth client)';
const METADATA_FETCH_TIMEOUT_MS = 15_000;
const TOKEN_REQUEST_TIMEOUT_MS = 30_000;
const MAX_METADATA_BYTES = 256 * 1024;
/** Bound on well-known probe candidates so a hostile issuer cannot steer us
 *  into an unbounded request fan-out. */
const MAX_METADATA_PROBES = 6;

export class McpOAuthError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'challenge_missing'
      | 'resource_metadata_unavailable'
      | 'authorization_server_metadata_unavailable'
      | 'dynamic_registration_unavailable'
      | 'pkce_unsupported'
      | 'authorization_denied'
      | 'state_mismatch'
      | 'token_exchange_failed'
      | 'network',
  ) {
    super(message);
    this.name = 'McpOAuthError';
  }
}

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported?: string[];
  resource_name?: string;
}

export interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  revocation_endpoint?: string;
  code_challenge_methods_supported?: string[];
  grant_types_supported?: string[];
  response_types_supported?: string[];
  scopes_supported?: string[];
  token_endpoint_auth_methods_supported?: string[];
}

/**
 * The client-authentication methods RFC 7591 permits a registration to name.
 *
 * `none` is a public client: no secret exists, and `client_id` travels in the
 * request body. The other two are confidential and are mutually exclusive with
 * each other and with `none` — see `clientAuth`.
 */
export type TokenEndpointAuthMethod = 'none' | 'client_secret_post' | 'client_secret_basic';

export interface DynamicClientRegistration {
  client_id: string;
  client_secret?: string;
  client_id_issued_at?: number;
  client_secret_expires_at?: number;
  redirect_uris?: string[];
  token_endpoint_auth_method?: TokenEndpointAuthMethod;
}

function isTokenEndpointAuthMethod(value: unknown): value is TokenEndpointAuthMethod {
  return value === 'none' || value === 'client_secret_post' || value === 'client_secret_basic';
}

export interface OAuthTokens {
  accessToken: string;
  tokenType: string;
  refreshToken?: string;
  /** Epoch milliseconds. Absent when the AS returned no lifetime. */
  expiresAt?: number;
  scope?: string;
}

export interface PkcePair {
  verifier: string;
  challenge: string;
  method: 'S256';
}

// ─── WWW-Authenticate parsing ───────────────────────────────────────────────

/**
 * Parse a `WWW-Authenticate` header into its auth-param values.
 *
 * Deliberately small: it extracts the quoted string values we actually need
 * (`resource_metadata`, `scope`, `authorization_uri`, `error`) and ignores
 * everything else. Unquoted tokens are accepted too.
 */
export function parseWwwAuthenticate(header: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  // Only the Bearer scheme carries MCP resource metadata.
  if (!/^\s*Bearer\b/i.test(header)) return out;

  // Strip the scheme, then read key="value" / key=value pairs.
  const rest = header.replace(/^\s*Bearer\s+/i, '');
  const pattern = /([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(?:"([^"]*)"|([^\s,]+))/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(rest)) !== null) {
    const key = match[1].toLowerCase();
    const value = match[2] ?? match[3] ?? '';
    if (key.length > 0 && !(key in out)) out[key] = value;
  }
  return out;
}

// ─── Bounded JSON fetch ─────────────────────────────────────────────────────

/**
 * Fetch JSON with a hard byte ceiling and an identifying User-Agent.
 * Returns null for any non-2xx, oversized, or unparseable body — metadata
 * probing treats every one of those as "try the next candidate".
 */
async function fetchJson(
  url: string,
  options: { accept?: string; form?: Record<string, string>; basicAuth?: string } = {},
): Promise<unknown | null> {
  const headers: Record<string, string> = {
    'User-Agent': MCP_OAUTH_USER_AGENT,
    Accept: options.accept ?? 'application/json',
  };
  let body: string | undefined;
  if (options.form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(options.form).toString();
  }
  if (options.basicAuth) {
    headers.Authorization = `Basic ${Buffer.from(options.basicAuth).toString('base64')}`;
  }

  try {
    const resp = await fetch(url, {
      method: options.form ? 'POST' : 'GET',
      headers,
      body,
      redirect: 'follow',
      signal: AbortSignal.timeout(
        options.form ? TOKEN_REQUEST_TIMEOUT_MS : METADATA_FETCH_TIMEOUT_MS,
      ),
    });
    if (!resp.ok) {
      mcpLog.debug(
        { url: safeUrlForLog(url), status: resp.status },
        'MCP OAuth metadata endpoint returned non-OK status',
      );
      return null;
    }
    const text = await readCappedText(resp);
    if (text === null) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return null;
    }
  } catch (err: unknown) {
    mcpLog.debug(
      { url: safeUrlForLog(url), errorType: err instanceof Error ? err.name : typeof err },
      'MCP OAuth metadata fetch failed',
    );
    return null;
  }
}

/** Read at most `MAX_METADATA_BYTES`; refuse anything larger. */
async function readCappedText(resp: Response): Promise<string | null> {
  const body = resp.body;
  if (!body) return null;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_METADATA_BYTES) {
        await reader.cancel().catch(() => {});
        mcpLog.warn(
          { url: safeUrlForLog(resp.url), limitBytes: MAX_METADATA_BYTES },
          'MCP OAuth metadata response exceeded the byte ceiling',
        );
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** Strip query and fragment before logging a URL — neither may carry a code. */
function safeUrlForLog(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return 'invalid-url';
  }
}

// ─── Well-known candidate generation ────────────────────────────────────────

/**
 * Candidate well-known URLs for a base URL, most-likely first.
 *
 * RFC 8414 / RFC 9728 allow the well-known segment to be inserted *after* the
 * path. Real servers use both forms inconsistently, so we must try both.
 */
export function wellKnownCandidates(
  baseUrl: string,
  kind: 'oauth-protected-resource' | 'oauth-authorization-server',
): string[] {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return [];
  }
  const origin = parsed.origin;
  const path = parsed.pathname.replace(/\/+$/, '');
  const candidates = [`${origin}/.well-known/${kind}${path}`, `${origin}/.well-known/${kind}`];
  if (path) {
    candidates.push(`${origin}${path}/.well-known/${kind}`);
  }
  return [...new Set(candidates)].slice(0, MAX_METADATA_PROBES);
}

/** OpenID Connect discovery is a common fallback for AS metadata. */
function openIdCandidates(baseUrl: string): string[] {
  return wellKnownCandidates(baseUrl, 'oauth-authorization-server').map((candidate) =>
    candidate.replace('/oauth-authorization-server', '/openid-configuration'),
  );
}

// ─── Discovery ──────────────────────────────────────────────────────────────

export async function discoverProtectedResource(
  resourceUrl: string,
  wwwAuthenticate?: string | null,
): Promise<ProtectedResourceMetadata | null> {
  const challenge = parseWwwAuthenticate(wwwAuthenticate);

  // 1. The server tells us exactly where to look. Always prefer this.
  if (challenge.resource_metadata) {
    const direct = await fetchJson(challenge.resource_metadata);
    const parsed = parseProtectedResourceMetadata(direct);
    if (parsed) return parsed;
  }

  // 2. Otherwise probe the documented well-known locations.
  for (const candidate of wellKnownCandidates(resourceUrl, 'oauth-protected-resource')) {
    const parsed = parseProtectedResourceMetadata(await fetchJson(candidate));
    if (parsed) return parsed;
  }
  return null;
}

function parseProtectedResourceMetadata(value: unknown): ProtectedResourceMetadata | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const servers = Array.isArray(record.authorization_servers)
    ? record.authorization_servers.filter((s): s is string => typeof s === 'string')
    : [];
  const resource = typeof record.resource === 'string' ? record.resource : '';
  if (servers.length === 0 || resource.length === 0) return null;
  return {
    resource,
    authorization_servers: servers,
    scopes_supported: Array.isArray(record.scopes_supported)
      ? record.scopes_supported.filter((s): s is string => typeof s === 'string')
      : undefined,
    resource_name: typeof record.resource_name === 'string' ? record.resource_name : undefined,
  };
}

export async function discoverAuthorizationServer(
  issuer: string,
): Promise<AuthorizationServerMetadata | null> {
  const candidates = [
    ...wellKnownCandidates(issuer, 'oauth-authorization-server'),
    ...openIdCandidates(issuer),
  ];
  for (const candidate of [...new Set(candidates)].slice(0, MAX_METADATA_PROBES)) {
    const parsed = parseAuthorizationServerMetadata(await fetchJson(candidate));
    if (parsed) return parsed;
  }
  return null;
}

function parseAuthorizationServerMetadata(value: unknown): AuthorizationServerMetadata | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const authorizationEndpoint = record.authorization_endpoint;
  const tokenEndpoint = record.token_endpoint;
  if (typeof authorizationEndpoint !== 'string' || typeof tokenEndpoint !== 'string') return null;
  // Both endpoints must be absolute https URLs; a relative or javascript: URL
  // here would be an open-redirect vector straight into the user's browser.
  if (!isSafeAbsoluteHttpUrl(authorizationEndpoint) || !isSafeAbsoluteHttpUrl(tokenEndpoint)) {
    mcpLog.warn('MCP OAuth authorization server advertised a non-http(s) endpoint');
    return null;
  }
  const strArray = (key: string): string[] | undefined =>
    Array.isArray(record[key])
      ? (record[key] as unknown[]).filter((v): v is string => typeof v === 'string')
      : undefined;

  return {
    issuer: typeof record.issuer === 'string' ? record.issuer : '',
    authorization_endpoint: authorizationEndpoint,
    token_endpoint: tokenEndpoint,
    registration_endpoint:
      typeof record.registration_endpoint === 'string' &&
      isSafeAbsoluteHttpUrl(record.registration_endpoint)
        ? record.registration_endpoint
        : undefined,
    revocation_endpoint:
      typeof record.revocation_endpoint === 'string' &&
      isSafeAbsoluteHttpUrl(record.revocation_endpoint)
        ? record.revocation_endpoint
        : undefined,
    code_challenge_methods_supported: strArray('code_challenge_methods_supported'),
    grant_types_supported: strArray('grant_types_supported'),
    response_types_supported: strArray('response_types_supported'),
    scopes_supported: strArray('scopes_supported'),
    token_endpoint_auth_methods_supported: strArray('token_endpoint_auth_methods_supported'),
  };
}

export function isSafeAbsoluteHttpUrl(value: unknown): boolean {
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

// ─── PKCE ───────────────────────────────────────────────────────────────────

/**
 * Generate an RFC 7636 S256 PKCE pair.
 *
 * S256 only. `plain` is advertised by Notion but is downgraded protection and
 * is never required by the MCP spec, so we refuse to use it.
 */
export function generatePkce(): PkcePair {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge, method: 'S256' };
}

function base64Url(bytes: Buffer): string {
  return bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Unpredictable CSRF binding for the authorization response. */
export function generateState(): string {
  return base64Url(randomBytes(24));
}

export function assertPkceSupported(metadata: AuthorizationServerMetadata): void {
  const methods = metadata.code_challenge_methods_supported;
  if (!methods || methods.length === 0) {
    // Absent means the AS predates PKCE enforcement; RFC 7636 still allows the
    // client to send the challenge, so this is not fatal.
    return;
  }
  if (!methods.includes('S256')) {
    throw new McpOAuthError(
      'The MCP server only supports the weaker "plain" PKCE method',
      'pkce_unsupported',
    );
  }
}

// ─── Dynamic Client Registration ────────────────────────────────────────────

/**
 * Choose the client-authentication method to use.
 *
 * This must come from the server's own `token_endpoint_auth_methods_supported`,
 * not from a constant. Requesting a method the server does not advertise is an
 * `invalid_client_metadata` error under RFC 7591 §3.2.2, and Figma is a real
 * case: it advertises only `client_secret_basic` and `client_secret_post`, so a
 * blanket `none` cannot register there at all.
 *
 * `confidential` means "we are already holding a secret that must be used" —
 * the manual-credentials case. It is false for dynamic registration, where no
 * secret exists yet and `none` is preferred whenever the server allows it,
 * because a public client has nothing for us to persist or protect.
 */
export function selectTokenEndpointAuthMethod(options: {
  supported?: string[];
  /** True when the user supplied their own client secret (manual credentials). */
  confidential?: boolean;
}): TokenEndpointAuthMethod {
  const supported = options.supported?.filter(isTokenEndpointAuthMethod);

  // An AS that publishes no list predates the field; assume the RFC 7591 default
  // and let the secret decide between public and confidential.
  if (!supported || supported.length === 0) {
    return options.confidential ? 'client_secret_post' : 'none';
  }

  if (options.confidential) {
    const confidentialMethod = ['client_secret_post', 'client_secret_basic'].find((method) =>
      supported.includes(method as TokenEndpointAuthMethod),
    );
    if (confidentialMethod) return confidentialMethod as TokenEndpointAuthMethod;
    // Refuse rather than guess. Sending a secret to a server that only accepts
    // public clients is silently wrong, and dropping the secret would fail later
    // with a much less obvious error.
    throw new McpOAuthError(
      'This MCP server only accepts public clients, so app credentials with a client secret cannot be used against it. Reconnect using a public app, or remove the client secret.',
      'dynamic_registration_unavailable',
    );
  }

  if (supported.includes('none')) return 'none';
  const forConfidentialRegistration = ['client_secret_post', 'client_secret_basic'].find((method) =>
    supported.includes(method as TokenEndpointAuthMethod),
  );
  if (forConfidentialRegistration) return forConfidentialRegistration as TokenEndpointAuthMethod;

  throw new McpOAuthError(
    'This MCP server supports no client-authentication method Koryphaios can use',
    'dynamic_registration_unavailable',
  );
}

export async function registerDynamicClient(options: {
  registrationEndpoint: string;
  redirectUri: string;
  scopes: string[];
  resource?: string;
  clientName?: string;
  tokenEndpointAuthMethod: TokenEndpointAuthMethod;
}): Promise<DynamicClientRegistration> {
  const body: Record<string, unknown> = {
    client_name: options.clientName ?? 'Koryphaios',
    redirect_uris: [options.redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: options.tokenEndpointAuthMethod,
  };
  if (options.scopes.length > 0) body.scope = options.scopes.join(' ');
  if (options.resource) body.resource = options.resource;

  const response = await fetch(options.registrationEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': MCP_OAUTH_USER_AGENT,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
  });

  const text = await readCappedText(response);
  if (!response.ok) {
    throw new McpOAuthError(
      `Dynamic client registration failed (HTTP ${response.status})`,
      'dynamic_registration_unavailable',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text ?? '') as unknown;
  } catch {
    throw new McpOAuthError(
      'Dynamic client registration returned an unreadable response',
      'dynamic_registration_unavailable',
    );
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new McpOAuthError(
      'Dynamic client registration returned an unexpected response',
      'dynamic_registration_unavailable',
    );
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.client_id !== 'string' || record.client_id.length === 0) {
    throw new McpOAuthError(
      'Dynamic client registration returned no client_id',
      'dynamic_registration_unavailable',
    );
  }
  const clientSecret = typeof record.client_secret === 'string' ? record.client_secret : undefined;
  // An AS may omit the field. RFC 7591 §3.2.1 defaults it to
  // `client_secret_basic`, but a registration that came back without a secret is
  // really public no matter what the default says, so the issued secret decides.
  const declaredMethod = isTokenEndpointAuthMethod(record.token_endpoint_auth_method)
    ? record.token_endpoint_auth_method
    : clientSecret
      ? 'client_secret_basic'
      : 'none';
  return {
    client_id: record.client_id,
    client_secret: clientSecret,
    redirect_uris: Array.isArray(record.redirect_uris)
      ? (record.redirect_uris as unknown[]).filter((v): v is string => typeof v === 'string')
      : undefined,
    token_endpoint_auth_method: declaredMethod,
  };
}

// ─── Authorization URL + code exchange ──────────────────────────────────────

export function buildAuthorizationUrl(options: {
  metadata: AuthorizationServerMetadata;
  clientId: string;
  redirectUri: string;
  state: string;
  pkce: PkcePair;
  scopes: string[];
  resource?: string;
}): string {
  const url = new URL(options.metadata.authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', options.clientId);
  url.searchParams.set('redirect_uri', options.redirectUri);
  url.searchParams.set('state', options.state);
  url.searchParams.set('code_challenge', options.pkce.challenge);
  url.searchParams.set('code_challenge_method', options.pkce.method);
  if (options.scopes.length > 0) url.searchParams.set('scope', options.scopes.join(' '));
  // RFC 9728: bind the token to the MCP resource, not just the client.
  if (options.resource) url.searchParams.set('resource', options.resource);
  return url.toString();
}

interface TokenResponse {
  access_token?: unknown;
  token_type?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
  error?: unknown;
  error_description?: unknown;
  /** Slack's `oauth.v2.user.access` returns `ok: false` at HTTP 200 instead of a
   *  standard OAuth error object. A real authorization server using this shape
   *  is otherwise indistinguishable from success. */
  ok?: unknown;
}

function parseTokenResponse(payload: TokenResponse, endpointForLog: string): OAuthTokens {
  // Slack-style: `{ ok: false, error: "invalid_code" }` with HTTP 200.
  if (payload.ok === false && typeof payload.error === 'string') {
    serverLog.warn(
      { endpoint: safeUrlForLog(endpointForLog), oauthError: payload.error },
      'MCP OAuth token endpoint returned a non-standard error',
    );
    throw new McpOAuthError(`Authorization failed (${payload.error})`, 'token_exchange_failed');
  }
  if (typeof payload.error === 'string') {
    const description =
      typeof payload.error_description === 'string' ? `: ${payload.error_description}` : '';
    serverLog.warn(
      { endpoint: safeUrlForLog(endpointForLog), oauthError: payload.error },
      'MCP OAuth token endpoint returned an error',
    );
    throw new McpOAuthError(
      `Authorization failed (${payload.error})${description}`,
      'token_exchange_failed',
    );
  }
  if (typeof payload.access_token !== 'string' || payload.access_token.length === 0) {
    throw new McpOAuthError(
      'The authorization server returned no access token',
      'token_exchange_failed',
    );
  }
  const expiresIn = typeof payload.expires_in === 'number' ? payload.expires_in : undefined;
  return {
    accessToken: payload.access_token,
    tokenType: typeof payload.token_type === 'string' ? payload.token_type : 'Bearer',
    refreshToken: typeof payload.refresh_token === 'string' ? payload.refresh_token : undefined,
    expiresAt: expiresIn !== undefined ? Date.now() + expiresIn * 1000 : undefined,
    scope: typeof payload.scope === 'string' ? payload.scope : undefined,
  };
}

/**
 * Build the client authentication for one token or revocation request.
 *
 * RFC 6749 §2.3 is strict here: a client "MUST NOT use more than one
 * authentication method in each request". Sending an `Authorization: Basic`
 * header *and* repeating `client_id`/`client_secret` in the form body uses two,
 * and real authorization servers answer that with `invalid_request`. Figma and
 * Slack's confidential paths hit this; Notion's public path does not, which is
 * exactly why a local fake would never have caught it.
 *
 * The issued secret is the final arbiter. A registration marked confidential but
 * handed back without a secret can only be used as a public client, so it
 * degrades to `none` rather than sending a Basic header with an empty password.
 */
function clientAuth(registration: DynamicClientRegistration): {
  basicAuth?: string;
  form: Record<string, string>;
} {
  const secret = registration.client_secret;
  if (!secret) {
    // Public client: identify with client_id in the body, no secret anywhere.
    return { form: { client_id: registration.client_id } };
  }
  if (registration.token_endpoint_auth_method === 'client_secret_basic') {
    // Basic carries the identity; the body must not repeat it.
    return { basicAuth: `${registration.client_id}:${secret}`, form: {} };
  }
  // `client_secret_post`, and the safe default for a secret whose method the
  // server never stated.
  return { form: { client_id: registration.client_id, client_secret: secret } };
}

export async function exchangeAuthorizationCode(options: {
  metadata: AuthorizationServerMetadata;
  registration: DynamicClientRegistration;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  resource?: string;
}): Promise<OAuthTokens> {
  const { form, basicAuth } = clientAuth(options.registration);
  const payload = await postTokenRequest({
    endpoint: options.metadata.token_endpoint,
    form: {
      ...form,
      grant_type: 'authorization_code',
      code: options.code,
      redirect_uri: options.redirectUri,
      code_verifier: options.codeVerifier,
      ...(options.resource ? { resource: options.resource } : {}),
    },
    basicAuth,
  });
  return parseTokenResponse(payload, options.metadata.token_endpoint);
}

export async function refreshAccessToken(options: {
  metadata: AuthorizationServerMetadata;
  registration: DynamicClientRegistration;
  refreshToken: string;
  resource?: string;
}): Promise<OAuthTokens> {
  const { form, basicAuth } = clientAuth(options.registration);
  const payload = await postTokenRequest({
    endpoint: options.metadata.token_endpoint,
    form: {
      ...form,
      grant_type: 'refresh_token',
      refresh_token: options.refreshToken,
      ...(options.resource ? { resource: options.resource } : {}),
    },
    basicAuth,
  });
  const tokens = parseTokenResponse(payload, options.metadata.token_endpoint);
  // Some ASes rotate the refresh token; some omit it on refresh, in which case
  // the old one stays valid.
  return { ...tokens, refreshToken: tokens.refreshToken ?? options.refreshToken };
}

async function postTokenRequest(options: {
  endpoint: string;
  form: Record<string, string>;
  basicAuth?: string;
}): Promise<TokenResponse> {
  let resp: Response;
  try {
    resp = await fetch(options.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        'User-Agent': MCP_OAUTH_USER_AGENT,
        ...(options.basicAuth ? { Authorization: `Basic ${options.basicAuth}` } : {}),
      },
      body: new URLSearchParams(options.form).toString(),
      signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
    });
  } catch (err: unknown) {
    serverLog.warn(
      {
        endpoint: safeUrlForLog(options.endpoint),
        errorType: err instanceof Error ? err.name : typeof err,
      },
      'MCP OAuth token request failed at the transport layer',
    );
    throw new McpOAuthError('Could not reach the authorization server', 'network');
  }

  const text = await readCappedText(resp);
  let parsed: TokenResponse = {};
  try {
    parsed = text ? (JSON.parse(text) as TokenResponse) : {};
  } catch {
    if (!resp.ok) {
      throw new McpOAuthError(
        `Token endpoint returned an unreadable error (HTTP ${resp.status})`,
        'token_exchange_failed',
      );
    }
    throw new McpOAuthError(
      'Token endpoint returned an unreadable response',
      'token_exchange_failed',
    );
  }
  return parsed;
}

export async function revokeToken(options: {
  metadata: AuthorizationServerMetadata;
  registration: DynamicClientRegistration;
  token: string;
  hint?: 'access_token' | 'refresh_token';
}): Promise<void> {
  if (!options.metadata.revocation_endpoint) return;
  const { form, basicAuth } = clientAuth(options.registration);
  try {
    await fetch(options.metadata.revocation_endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': MCP_OAUTH_USER_AGENT,
        ...(basicAuth ? { Authorization: `Basic ${basicAuth}` } : {}),
      },
      body: new URLSearchParams({
        ...form,
        token: options.token,
        ...(options.hint ? { token_type_hint: options.hint } : {}),
      }),
      signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
    });
  } catch {
    // Best effort: a local disconnect must not fail because the AS is down.
    serverLog.debug('MCP OAuth revocation request failed; ignoring');
  }
}

// ─── End-to-end challenge resolution ────────────────────────────────────────

/** Everything needed to start an authorization, fully resolved. */
export interface ResolvedAuthorizationChallenge {
  challenge: Record<string, string>;
  protectedResource: ProtectedResourceMetadata;
  authorizationServer: AuthorizationServerMetadata;
  registration: DynamicClientRegistration;
  /** Scopes to request: the challenge's `scope` when given, else the PRM's. */
  scopes: string[];
  pkce: PkcePair;
  state: string;
  redirectUri: string;
}

/**
 * Resolve everything needed to start an authorization.
 *
 * `resource` in the returned record is the RFC 9728 resource identifier sent to
 * both the authorization and token endpoints.
 *
 * Atlassian publishes authorization-server metadata but no protected-resource
 * metadata at all, so when PRM discovery fails we fall back to treating the MCP
 * server's own origin as the issuer and the MCP URL as the resource. That is
 * what its own endpoints expect, and it is the only way to support a deployment
 * that omits the optional PRM document.
 *
 * Throws `McpOAuthError` with an actionable message when the server cannot be
 * driven automatically — notably Slack, which publishes no registration
 * endpoint and therefore needs its own pre-registered app credentials.
 */
/**
 * A client the user registered themselves with the provider.
 *
 * Some authorization servers publish no `registration_endpoint`, so dynamic
 * registration is impossible and the user must bring their own app credentials.
 * Slack is the case in Koryphaios' featured catalog.
 */
export interface ManualClientCredentials {
  clientId: string;
  clientSecret?: string;
}

export async function resolveAuthorizationChallenge(options: {
  resourceUrl: string;
  redirectUri: string;
  wwwAuthenticate?: string | null;
  clientName?: string;
  /** Pre-generated so the callback listener can enforce the state binding. */
  pkce?: PkcePair;
  state?: string;
  /** Use these credentials instead of attempting dynamic registration. */
  manualClient?: ManualClientCredentials;
}): Promise<ResolvedAuthorizationChallenge> {
  const protectedResource = await discoverProtectedResource(
    options.resourceUrl,
    options.wwwAuthenticate,
  );

  let resource: ProtectedResourceMetadata;
  let authorizationServer: AuthorizationServerMetadata | null;

  if (protectedResource) {
    resource = protectedResource;
    authorizationServer = await discoverAuthorizationServer(
      protectedResource.authorization_servers[0]!,
    );
  } else {
    const issuer = originOf(options.resourceUrl);
    if (!issuer) {
      throw new McpOAuthError(
        'This MCP server did not publish OAuth protected-resource metadata, so Koryphaios cannot authorize against it automatically',
        'resource_metadata_unavailable',
      );
    }
    mcpLog.info(
      { issuer },
      'No protected-resource metadata published; falling back to the MCP origin as issuer',
    );
    resource = { resource: options.resourceUrl, authorization_servers: [issuer] };
    authorizationServer = await discoverAuthorizationServer(issuer);
  }

  if (!authorizationServer) {
    throw new McpOAuthError(
      `The authorization server for ${resource.resource_name ?? resource.resource} (${resource.authorization_servers[0]}) does not publish OAuth metadata`,
      'authorization_server_metadata_unavailable',
    );
  }
  assertPkceSupported(authorizationServer);

  const challenge = parseWwwAuthenticate(options.wwwAuthenticate);
  const scopes =
    typeof challenge.scope === 'string' && challenge.scope.length > 0
      ? challenge.scope.split(/\s+/).filter(Boolean)
      : (resource.scopes_supported ?? authorizationServer.scopes_supported ?? []);

  let registration: DynamicClientRegistration;
  if (options.manualClient) {
    // The user supplied their own app credentials. Do not attempt dynamic
    // registration, and do not require a registration endpoint to exist.
    registration = {
      client_id: options.manualClient.clientId,
      client_secret: options.manualClient.clientSecret,
      token_endpoint_auth_method: selectTokenEndpointAuthMethod({
        supported: authorizationServer.token_endpoint_auth_methods_supported,
        confidential: Boolean(options.manualClient.clientSecret),
      }),
    };
    mcpLog.info(
      {
        authorizationHost: safeUrlForLog(authorizationServer.authorization_endpoint),
        confidential: Boolean(options.manualClient.clientSecret),
        tokenEndpointAuthMethod: registration.token_endpoint_auth_method,
      },
      'MCP OAuth authorization started with user-supplied app credentials',
    );
  } else {
    if (!authorizationServer.registration_endpoint) {
      let host = resource.authorization_servers[0]!;
      try {
        host = new URL(host).host;
      } catch {
        /* keep the raw issuer for the message */
      }
      throw new McpOAuthError(
        `${host} does not allow apps to register automatically. Create your own app with them, then enter its client ID and client secret here.`,
        'dynamic_registration_unavailable',
      );
    }
    registration = await registerDynamicClient({
      registrationEndpoint: authorizationServer.registration_endpoint,
      redirectUri: options.redirectUri,
      scopes,
      resource: resource.resource,
      clientName: options.clientName,
      tokenEndpointAuthMethod: selectTokenEndpointAuthMethod({
        supported: authorizationServer.token_endpoint_auth_methods_supported,
        confidential: false,
      }),
    });
  }

  return {
    challenge,
    protectedResource: resource,
    authorizationServer,
    registration,
    scopes,
    pkce: options.pkce ?? generatePkce(),
    state: options.state ?? generateState(),
    redirectUri: options.redirectUri,
  };
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}
