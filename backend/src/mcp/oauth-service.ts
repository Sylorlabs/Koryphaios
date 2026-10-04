// Orchestrates the MCP OAuth authorization-code flow.
//
// Ties together the pieces in oauth.ts (discovery, DCR, PKCE), the loopback
// listener in oauth-callback.ts, and the token store in oauth-secrets.ts, and
// exposes the operations the settings UI and the MCP client need:
//
//   • beginAuthorization    — discover + register + hand back a URL to open
//   • completeAuthorization — await the redirect, exchange the code, store it
//   • ensureAccessToken     — refresh if stale; used by the client per request
//   • disconnect            — revoke remotely when possible, always delete locally
//
// Pending flows live in memory only and expire. Nothing about a flow is written
// to disk until a token actually exists.

import {
  McpOAuthError,
  buildAuthorizationUrl,
  discoverAuthorizationServer,
  exchangeAuthorizationCode,
  generatePkce,
  generateState,
  refreshAccessToken,
  resolveAuthorizationChallenge,
  revokeToken,
  type AuthorizationServerMetadata,
  type DynamicClientRegistration,
  type ManualClientCredentials,
} from './oauth';
import { startOAuthCallbackListener, type OAuthCallbackListener } from './oauth-callback';
import {
  canRefreshGrant,
  getMcpOAuthGrant,
  grantAuthHeaders,
  isGrantFresh,
  loadMcpOAuthGrants,
  removeMcpOAuthGrant,
  summarizeGrant,
  upsertMcpOAuthGrant,
  type McpOAuthGrantSummary,
  type StoredMcpOAuthGrant,
} from './oauth-secrets';
import { mcpLog, serverLog } from '../logger';

const FLOW_LIFETIME_MS = 5 * 60_000;
/** Bound on concurrent pending flows so a stuck browser cannot leak listeners. */
const MAX_PENDING_FLOWS = 8;

interface PendingFlow {
  serverName: string;
  projectRoot: string;
  redirectUri: string;
  authorizationServer: AuthorizationServerMetadata;
  registration: DynamicClientRegistration;
  pkceVerifier: string;
  resource: string;
  scopes: string[];
  listener: OAuthCallbackListener;
  expiresAt: number;
  /** Whether these came from the user's own app rather than dynamic registration. */
  manualClient: boolean;
}

const pendingFlows = new Map<string, PendingFlow>();

export interface BeginAuthorizationResult {
  /** Open this in the user's browser. */
  authorizationUrl: string;
  /** Host the user is being sent to, for display. */
  authorizationHost: string;
  scopes: string[];
  resourceName?: string;
  expiresInSeconds: number;
}

/**
 * Begin an authorization flow.
 *
 * Order matters: PKCE and state are generated first so the loopback listener can
 * enforce the state binding, then the listener's port supplies the `redirect_uri`
 * that Dynamic Client Registration records. Any failure tears the listener down
 * before returning.
 */
export async function beginAuthorization(options: {
  projectRoot: string;
  serverName: string;
  resourceUrl: string;
  wwwAuthenticate?: string | null;
  /** The user's own app credentials, for servers with no dynamic registration. */
  manualClient?: ManualClientCredentials;
}): Promise<BeginAuthorizationResult> {
  pruneExpiredFlows();
  if (pendingFlows.size >= MAX_PENDING_FLOWS) {
    throw new McpOAuthError(
      'Too many authorization attempts are already open. Finish or cancel one first.',
      'authorization_denied',
    );
  }
  // Re-beginning for the same server supersedes any earlier attempt.
  await cancelFlow(options.projectRoot, options.serverName);

  const pkce = generatePkce();
  const state = generateState();

  let listener: OAuthCallbackListener | undefined;
  try {
    listener = await startOAuthCallbackListener({ expectedState: state });
    const resolved = await resolveAuthorizationChallenge({
      resourceUrl: options.resourceUrl,
      redirectUri: listener.redirectUri,
      wwwAuthenticate: options.wwwAuthenticate,
      clientName: `Koryphaios (${options.serverName})`,
      pkce,
      state,
      manualClient: options.manualClient,
    });

    const authorizationUrl = buildAuthorizationUrl({
      metadata: resolved.authorizationServer,
      clientId: resolved.registration.client_id,
      redirectUri: listener.redirectUri,
      state,
      pkce,
      scopes: resolved.scopes,
      resource: resolved.protectedResource.resource,
    });

    pendingFlows.set(options.serverName, {
      serverName: options.serverName,
      projectRoot: options.projectRoot,
      redirectUri: listener.redirectUri,
      authorizationServer: resolved.authorizationServer,
      registration: resolved.registration,
      pkceVerifier: pkce.verifier,
      resource: resolved.protectedResource.resource,
      scopes: resolved.scopes,
      listener,
      expiresAt: Date.now() + FLOW_LIFETIME_MS,
      manualClient: Boolean(options.manualClient),
    });

    mcpLog.info(
      {
        server: options.serverName,
        authorizationHost: new URL(resolved.authorizationServer.authorization_endpoint).host,
        scopeCount: resolved.scopes.length,
        scopes: resolved.scopes,
      },
      'MCP OAuth authorization started',
    );

    return {
      authorizationUrl,
      authorizationHost: new URL(resolved.authorizationServer.authorization_endpoint).host,
      scopes: resolved.scopes,
      resourceName: resolved.protectedResource.resource_name,
      expiresInSeconds: Math.floor(FLOW_LIFETIME_MS / 1000),
    };
  } catch (err: unknown) {
    await listener?.close().catch(() => {});
    throw err;
  }
}

/**
 * Await the browser redirect, exchange the code, and persist the tokens.
 * The flow is consumed exactly once, so a repeat call reports that nothing is
 * pending rather than exchanging a code twice.
 */
export async function completeAuthorization(options: {
  projectRoot: string;
  serverName: string;
}): Promise<McpOAuthGrantSummary> {
  const flow = pendingFlows.get(options.serverName);
  if (!flow) {
    throw new McpOAuthError(
      'No authorization is in progress for this server. Start one first.',
      'authorization_denied',
    );
  }
  pendingFlows.delete(options.serverName);

  let callback: Awaited<typeof flow.listener.result>;
  try {
    callback = await flow.listener.result;
  } finally {
    await flow.listener.close().catch(() => {});
  }

  if (callback.error) {
    if (callback.error === 'state_mismatch') {
      throw new McpOAuthError(
        'The authorization response did not match the pending request and was discarded',
        'state_mismatch',
      );
    }
    throw new McpOAuthError(
      callback.errorDescription ?? `Authorization was not completed (${callback.error})`,
      'authorization_denied',
    );
  }
  if (!callback.code) {
    throw new McpOAuthError('Authorization returned no code', 'authorization_denied');
  }

  let tokens;
  try {
    tokens = await exchangeAuthorizationCode({
      metadata: flow.authorizationServer,
      registration: flow.registration,
      code: callback.code,
      codeVerifier: flow.pkceVerifier,
      redirectUri: flow.redirectUri,
      resource: flow.resource,
    });
  } catch (err: unknown) {
    serverLog.warn(
      { server: options.serverName, errorType: err instanceof Error ? err.name : typeof err },
      'MCP OAuth code exchange failed',
    );
    throw err;
  }

  const grant: StoredMcpOAuthGrant = {
    accessToken: tokens.accessToken,
    tokenType: tokens.tokenType,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
    scope: tokens.scope ?? (flow.scopes.length ? flow.scopes.join(' ') : undefined),
    clientId: flow.registration.client_id,
    clientSecret: flow.registration.client_secret,
    tokenEndpointAuthMethod: flow.registration.token_endpoint_auth_method,
    tokenEndpoint: flow.authorizationServer.token_endpoint,
    resource: flow.resource,
    authorizationServerIssuer: flow.authorizationServer.issuer,
    manualClient: flow.manualClient,
    updatedAt: Date.now(),
  };
  upsertMcpOAuthGrant(options.projectRoot, options.serverName, grant);

  mcpLog.info(
    {
      server: options.serverName,
      hasRefreshToken: Boolean(tokens.refreshToken),
      expiresAt: tokens.expiresAt ?? null,
      scope: grant.scope ?? null,
    },
    'MCP OAuth authorization completed',
  );
  return summarizeGrant(grant);
}

export function authorizationStatus(projectRoot: string, serverName: string): McpOAuthGrantSummary {
  return summarizeGrant(getMcpOAuthGrant(projectRoot, serverName));
}

export function listAuthorizedServers(projectRoot: string): string[] {
  return Object.keys(loadMcpOAuthGrants(projectRoot));
}

/** Cancel a pending flow without exchanging anything. */
export async function cancelFlow(projectRoot: string, serverName: string): Promise<boolean> {
  const flow = pendingFlows.get(serverName);
  if (!flow) return false;
  if (flow.projectRoot !== projectRoot) return false;
  pendingFlows.delete(serverName);
  await flow.listener.close().catch(() => {});
  return true;
}

function pruneExpiredFlows(): void {
  const now = Date.now();
  for (const [name, flow] of pendingFlows) {
    if (flow.expiresAt > now) continue;
    pendingFlows.delete(name);
    void flow.listener.close().catch(() => {});
  }
}

/**
 * Return a usable `Authorization` header for a server, refreshing a stale token
 * first. Returns null when there is no usable grant, which tells the caller the
 * user must authorize before this server can work.
 */
export async function ensureAccessToken(
  projectRoot: string,
  serverName: string,
): Promise<Record<string, string> | null> {
  const grant = getMcpOAuthGrant(projectRoot, serverName);
  if (!grant) return null;

  if (isGrantFresh(grant)) return grantAuthHeaders(grant);
  if (!canRefreshGrant(grant)) {
    mcpLog.info({ server: serverName }, 'MCP OAuth grant expired and cannot be refreshed');
    return null;
  }

  const metadata = await rediscover(grant);
  if (!metadata) return null;

  try {
    const tokens = await refreshAccessToken({
      metadata,
      registration: {
        client_id: grant.clientId,
        client_secret: grant.clientSecret,
        token_endpoint_auth_method: grant.tokenEndpointAuthMethod,
      },
      refreshToken: grant.refreshToken as string,
      resource: grant.resource,
    });
    const updated: StoredMcpOAuthGrant = {
      ...grant,
      accessToken: tokens.accessToken,
      tokenType: tokens.tokenType,
      refreshToken: tokens.refreshToken ?? grant.refreshToken,
      expiresAt: tokens.expiresAt,
      scope: tokens.scope ?? grant.scope,
      updatedAt: Date.now(),
    };
    upsertMcpOAuthGrant(projectRoot, serverName, updated);
    mcpLog.info({ server: serverName }, 'MCP OAuth access token refreshed');
    return grantAuthHeaders(updated);
  } catch (err: unknown) {
    serverLog.warn(
      { server: serverName, errorType: err instanceof Error ? err.name : typeof err },
      'MCP OAuth token refresh failed',
    );
    return null;
  }
}

/**
 * Re-fetch authorization-server metadata for a refresh or revocation. The issuer
 * is remembered on the grant; when it is unknown we cannot safely guess a token
 * endpoint, so we give up rather than post a credential somewhere unverified.
 */
async function rediscover(grant: StoredMcpOAuthGrant): Promise<AuthorizationServerMetadata | null> {
  if (!grant.authorizationServerIssuer) return null;
  return discoverAuthorizationServer(grant.authorizationServerIssuer);
}

/** Disconnect: revoke at the provider when we can, then delete locally. */
export async function disconnect(options: {
  projectRoot: string;
  serverName: string;
}): Promise<boolean> {
  await cancelFlow(options.projectRoot, options.serverName).catch(() => {});
  const grant = getMcpOAuthGrant(options.projectRoot, options.serverName);
  if (!grant) return false;

  const metadata = await rediscover(grant);
  if (metadata) {
    // Revoke BOTH tokens. Revoking only the refresh token leaves a live access
    // token usable until it expires, which is not what "disconnect" means.
    const registration: DynamicClientRegistration = {
      client_id: grant.clientId,
      client_secret: grant.clientSecret,
      token_endpoint_auth_method: grant.tokenEndpointAuthMethod,
    };
    if (grant.accessToken) {
      await revokeToken({
        metadata,
        registration,
        token: grant.accessToken,
        hint: 'access_token',
      });
    }
    if (grant.refreshToken && grant.refreshToken !== grant.accessToken) {
      await revokeToken({
        metadata,
        registration,
        token: grant.refreshToken,
        hint: 'refresh_token',
      });
    }
  }
  removeMcpOAuthGrant(options.projectRoot, options.serverName);
  mcpLog.info({ server: options.serverName }, 'MCP OAuth grant revoked and deleted');
  return true;
}
