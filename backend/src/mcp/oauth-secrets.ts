// MCP OAuth token store.
//
// OAuth access and refresh tokens for remote MCP servers are long-lived,
// high-value credentials. They are stored HERE and never in koryphaios.json:
// that file is settings, it is committed, and an auto-committer snapshots it.
// `mcpServers.<name>.headers` is deliberately NOT used for tokens — it is
// written verbatim into the config file, so a token placed there would be
// committed in plaintext.
//
// Storage: <projectRoot>/.koryphaios/mcp-oauth.json, chmod 0600, written with
// the same atomic tmp+rename discipline as the provider and MCP-env secret
// stores. This follows the documented house policy for local secrets (see
// secret-store.ts): plaintext at rest, protected by file mode and location.
//
// Nothing in this file is ever logged.

import { existsSync, readFileSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { serverLog } from '../logger';
import { ensureSecureDir } from '../security/fs-permissions';
import type { TokenEndpointAuthMethod } from './oauth';

export interface StoredMcpOAuthGrant {
  accessToken: string;
  tokenType: string;
  refreshToken?: string;
  /** Epoch milliseconds; absent when the AS returned no lifetime. */
  expiresAt?: number;
  scope?: string;
  clientId: string;
  clientSecret?: string;
  /**
   * How this client authenticates at the token endpoint.
   *
   * Persisted because it is not recoverable from the stored secret alone: a
   * `client_secret_basic` server rejects a refresh that sends the secret in the
   * body, and re-discovering metadata to re-derive it would mean guessing.
   */
  tokenEndpointAuthMethod?: TokenEndpointAuthMethod;
  tokenEndpoint: string;
  /** The MCP resource this token is bound to (RFC 9728). */
  resource: string;
  authorizationServerIssuer?: string;
  /** True when these are the user's own app credentials rather than a client
   *  Koryphaios registered. Only Slack needs this today. */
  manualClient?: boolean;
  /** Epoch milliseconds of the last successful exchange, for diagnostics. */
  updatedAt: number;
}

export type McpOAuthGrants = Record<string, StoredMcpOAuthGrant>;

/** Refresh this far before actual expiry so a token cannot lapse mid-call. */
export const TOKEN_REFRESH_SKEW_MS = 60_000;

function grantsPath(projectRoot: string): string {
  return join(projectRoot, '.koryphaios', 'mcp-oauth.json');
}

export function loadMcpOAuthGrants(projectRoot: string): McpOAuthGrants {
  const path = grantsPath(projectRoot);
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: McpOAuthGrants = {};
    for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
      const grant = normalizeGrant(value);
      if (grant) out[name] = grant;
      else
        serverLog.warn(
          { server: name },
          'Discarding a malformed MCP OAuth grant from the secret store',
        );
    }
    return out;
  } catch (err: unknown) {
    serverLog.warn(
      { errorType: err instanceof Error ? err.name : typeof err },
      'MCP OAuth grant store is unreadable; treating all servers as unauthorized',
    );
    return {};
  }
}

function normalizeGrant(value: unknown): StoredMcpOAuthGrant | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.accessToken !== 'string' || record.accessToken.length === 0) return null;
  if (typeof record.clientId !== 'string' || record.clientId.length === 0) return null;
  if (typeof record.tokenEndpoint !== 'string' || record.tokenEndpoint.length === 0) return null;
  if (typeof record.resource !== 'string' || record.resource.length === 0) return null;
  const str = (key: string): string | undefined =>
    typeof record[key] === 'string' ? (record[key] as string) : undefined;
  const num = (key: string): number | undefined =>
    typeof record[key] === 'number' && Number.isFinite(record[key] as number)
      ? (record[key] as number)
      : undefined;
  const authMethod = record.tokenEndpointAuthMethod;
  return {
    accessToken: record.accessToken,
    tokenType: str('tokenType') ?? 'Bearer',
    refreshToken: str('refreshToken'),
    expiresAt: num('expiresAt'),
    scope: str('scope'),
    clientId: record.clientId,
    clientSecret: str('clientSecret'),
    tokenEndpointAuthMethod:
      authMethod === 'none' ||
      authMethod === 'client_secret_post' ||
      authMethod === 'client_secret_basic'
        ? authMethod
        : undefined,
    tokenEndpoint: record.tokenEndpoint,
    resource: record.resource,
    authorizationServerIssuer: str('authorizationServerIssuer'),
    manualClient: record.manualClient === true,
    updatedAt: num('updatedAt') ?? 0,
  };
}

export function saveMcpOAuthGrants(projectRoot: string, grants: McpOAuthGrants): void {
  const path = grantsPath(projectRoot);
  ensureSecureDir(dirname(path));
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(grants, null, 2), { encoding: 'utf-8', mode: 0o600 });
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600);
  } catch (err: unknown) {
    serverLog.debug(
      { errorType: err instanceof Error ? err.name : typeof err },
      'chmod 0o600 failed on the MCP OAuth store, best effort',
    );
  }
}

export function getMcpOAuthGrant(
  projectRoot: string,
  serverName: string,
): StoredMcpOAuthGrant | null {
  return loadMcpOAuthGrants(projectRoot)[serverName] ?? null;
}

export function upsertMcpOAuthGrant(
  projectRoot: string,
  serverName: string,
  grant: StoredMcpOAuthGrant,
): void {
  const grants = loadMcpOAuthGrants(projectRoot);
  grants[serverName] = grant;
  saveMcpOAuthGrants(projectRoot, grants);
}

export function removeMcpOAuthGrant(projectRoot: string, serverName: string): boolean {
  const grants = loadMcpOAuthGrants(projectRoot);
  if (!(serverName in grants)) return false;
  delete grants[serverName];
  saveMcpOAuthGrants(projectRoot, grants);
  return true;
}

/** True when the grant exists and is not within the refresh skew of expiry. */
export function isGrantFresh(grant: StoredMcpOAuthGrant, now = Date.now()): boolean {
  if (!grant.expiresAt) return true;
  return grant.expiresAt - TOKEN_REFRESH_SKEW_MS > now;
}

/** True when the grant can be refreshed without user interaction. */
export function canRefreshGrant(grant: StoredMcpOAuthGrant | null): boolean {
  return Boolean(grant?.refreshToken && grant.refreshToken.length > 0);
}

/**
 * Authorization headers for a grant, or an empty object when there is none.
 * The access token is returned to the HTTP layer only — never logged.
 */
export function grantAuthHeaders(grant: StoredMcpOAuthGrant | null): Record<string, string> {
  if (!grant || grant.accessToken.length === 0) return {};
  const scheme = grant.tokenType && grant.tokenType.length > 0 ? grant.tokenType : 'Bearer';
  return { Authorization: `${scheme} ${grant.accessToken}` };
}

/** Non-secret summary for the settings UI. Never includes token material. */
export interface McpOAuthGrantSummary {
  authorized: boolean;
  scope?: string;
  expiresAt?: number;
  expired: boolean;
  refreshable: boolean;
  resource?: string;
  /**
   * A live connection was rejected with 401 and no usable token was available.
   * This is what drives the "Authorize" affordance; it is distinct from
   * `authorized`, because a previously valid grant can be rejected by the
   * provider after a revocation on their side.
   */
  needsAuthorization: boolean;
}

export function summarizeGrant(
  grant: StoredMcpOAuthGrant | null,
  now = Date.now(),
): McpOAuthGrantSummary {
  if (!grant) {
    return { authorized: false, expired: false, refreshable: false, needsAuthorization: true };
  }
  return {
    authorized: true,
    scope: grant.scope,
    expiresAt: grant.expiresAt,
    expired: grant.expiresAt !== undefined && grant.expiresAt <= now,
    refreshable: canRefreshGrant(grant),
    resource: grant.resource,
    needsAuthorization: false,
  };
}
