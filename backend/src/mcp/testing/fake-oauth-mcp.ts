// A fake hosted MCP server protected by a real OAuth 2.1 authorization server.
//
// Shared by `oauth.test.ts` and the live agent probe so both exercise identical
// server behaviour. The shapes it reproduces were discovered by probing the real
// services (Notion, Sentry, Figma, Slack, Atlassian):
//
//   • protected-resource metadata published only at the path-inserted well-known
//     path (Sentry), or omitted entirely (Atlassian)
//   • metadata endpoints that 403 anything but a recognized User-Agent
//     (Notion, Sentry)
//   • a 401 challenge naming the metadata URL directly
//   • dynamic client registration producing either a public or a confidential
//     client (Notion vs Figma)
//   • a server with no registration endpoint at all (Slack)
//   • expiring access tokens requiring a refresh
//   • PKCE S256 verified against the challenge recorded at /authorize

import { createHash } from 'node:crypto';

/** Must match MCP_OAUTH_USER_AGENT in ../oauth.ts. */
export const EXPECTED_USER_AGENT = 'Koryphaios (MCP OAuth client)';

export interface FakeOAuthMcpOptions {
  /** Publish PRM ONLY at the path-inserted well-known form (Sentry's shape). */
  pathInsertedProtectedResource?: boolean;
  /** Publish AS metadata ONLY at the path-inserted form. */
  pathInsertedAuthorizationServer?: boolean;
  /** Publish AS metadata but NO protected-resource metadata (Atlassian). */
  omitProtectedResourceMetadata?: boolean;
  /** Publish AS metadata with no registration_endpoint (Slack's shape). */
  omitRegistrationEndpoint?: boolean;
  /** 403 any metadata request whose User-Agent is not ours. */
  rejectForeignAgents?: boolean;
  /** Issue a client_secret, making this a confidential client (Figma). */
  confidentialClient?: boolean;
  /**
   * Advertise these `token_endpoint_auth_methods_supported`, overriding the
   * `confidentialClient` default.
   *
   * Figma's real shape is `['client_secret_basic', 'client_secret_post']` — note
   * the absence of `none`. A server that never offers `none` is what forces a
   * client to register confidentially.
   */
  tokenEndpointAuthMethods?: string[];
  /** Access token lifetime in seconds. */
  tokenLifetimeSeconds?: number;
  /** Issue a refresh token alongside the access token. Default true. */
  issueRefreshToken?: boolean;
  /** Require the token request's redirect_uri to match what DCR recorded. */
  enforceRedirectUri?: boolean;
  /** Value the protected MCP tool returns — never sent to the model directly. */
  toolValue?: string;
  /** Name of the tool the server advertises. */
  toolName?: string;
}

export interface IssuedClient {
  redirectUris: string[];
  secret?: string;
  /** The `token_endpoint_auth_method` the registration settled on. */
  authMethod: string;
}

export interface FakeOAuthMcp {
  /** The MCP endpoint URL. */
  url: string;
  /** Origin serving both the MCP endpoint and the authorization server. */
  origin: string;
  recorded: RecordedCall[];
  issuedClients: Map<string, IssuedClient>;
  validAccessTokens: Set<string>;
  /**
   * Register a client out of band, the way an app a user created in a
   * provider's own console already exists.
   *
   * `/register` cannot express this: it always mints a fresh client id and its
   * own secret, whereas a user-supplied app has credentials Koryphaios did not
   * choose and cannot look up.
   */
  seedClient(client?: {
    clientId?: string;
    clientSecret?: string;
    authMethod?: string;
    redirectUris?: string[];
  }): string;
  stop(): void;
}

export interface RecordedCall {
  path: string;
  method: string;
  userAgent: string | null;
  authorization: string | null;
  form: Record<string, string> | null;
}

function base64Url(bytes: Buffer): string {
  return bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function startFakeOAuthMcp(
  options: FakeOAuthMcpOptions = {},
): Promise<FakeOAuthMcp> {
  const recorded: RecordedCall[] = [];
  const issuedClients = new Map<string, IssuedClient>();
  const validAccessTokens = new Set<string>();
  const validRefreshTokens = new Set<string>();
  /** PKCE challenges seen at /authorize, keyed by code. A real AS records the
   *  challenge there and verifies it against the verifier at /token. */
  const challengeByCode = new Map<string, string>();
  const mcpPath = '/mcp';
  const toolName = options.toolName ?? 'whoami';
  const toolValue = options.toolValue ?? 'workspace';
  /** Assigned from the bound server before the first request is served. */
  let port = 0;
  const origin = (): string => `http://127.0.0.1:${port}`;

  /** The client-auth methods this server is willing to accept. */
  const advertisedAuthMethods = (): string[] =>
    options.tokenEndpointAuthMethods ??
    (options.confidentialClient ? ['client_secret_post'] : ['none']);

  /**
   * Resolve which single client-auth method a token request used.
   *
   * RFC 6749 §2.3 forbids using more than one in a request. A faithful fake has
   * to reject the double-authenticated shape — `Authorization: Basic` *and*
   * `client_secret` in the body — because real authorization servers do, and a
   * fake that only reads the body will happily pass a client that Figma and
   * Slack reject in production.
   */
  const resolveClientAuth = (
    req: Request,
    form: Record<string, string>,
  ):
    | { ok: true; clientId: string; secret?: string; method: string }
    | { ok: false; error: string; description: string } => {
    const header = req.headers.get('authorization');
    const basic = header?.startsWith('Basic ') ? header.slice(6).trim() : null;
    const bodySecret = form.client_secret;

    if (basic !== null && bodySecret !== undefined) {
      return {
        ok: false,
        error: 'invalid_request',
        description: 'More than one client authentication mechanism was used',
      };
    }

    if (basic !== null) {
      const decoded = Buffer.from(basic, 'base64').toString('utf-8');
      const separator = decoded.indexOf(':');
      if (separator < 0) {
        return { ok: false, error: 'invalid_client', description: 'Malformed Basic credentials' };
      }
      return {
        ok: true,
        clientId: decoded.slice(0, separator),
        secret: decoded.slice(separator + 1),
        method: 'client_secret_basic',
      };
    }

    return {
      ok: true,
      clientId: form.client_id ?? '',
      secret: bodySecret,
      method: bodySecret === undefined ? 'none' : 'client_secret_post',
    };
  };

  const json = (value: unknown, status = 200, headers: Record<string, string> = {}): Response =>
    new Response(JSON.stringify(value), {
      status,
      headers: { 'Content-Type': 'application/json', ...headers },
    });

  const unauthorized = (): Response =>
    json(
      { error: 'invalid_token', error_description: 'Missing or invalid access token' },
      401,
      {
        'WWW-Authenticate': `Bearer realm="OAuth", resource_metadata="${origin()}/.well-known/oauth-protected-resource${mcpPath}", error="invalid_token"`,
      },
    );

  const guardUserAgent = (req: Request): boolean => {
    const userAgent = req.headers.get('user-agent');
    recorded.push({
      path: new URL(req.url).pathname,
      method: req.method,
      userAgent,
      authorization: req.headers.get('authorization'),
      form: null,
    });
    if (!options.rejectForeignAgents) return true;
    return userAgent === EXPECTED_USER_AGENT;
  };

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      const auth = req.headers.get('authorization');
      const bearer = auth?.replace(/^Bearer\s+/i, '') ?? '';

      // ── The MCP endpoint: every method requires a valid access token ────
      if (path === mcpPath) {
        recorded.push({
          path,
          method: 'POST',
          userAgent: req.headers.get('user-agent'),
          authorization: auth,
          form: null,
        });
        if (!validAccessTokens.has(bearer)) return unauthorized();

        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        const id = typeof body.id === 'number' ? body.id : null;
        const method = (req.headers.get('mcp-method') ?? body.method) as string | null;

        if (method === 'server/discover') {
          return json({
            jsonrpc: '2.0',
            id,
            error: { code: -32601, message: 'method not found' },
          });
        }
        if (method === 'initialize') {
          return json({
            jsonrpc: '2.0',
            id,
            result: { protocolVersion: '2025-11-25', capabilities: { tools: {} } },
          });
        }
        if (method === 'tools/list') {
          return json({
            jsonrpc: '2.0',
            id,
            result: {
              tools: [
                {
                  name: toolName,
                  description: `Return the ${toolValue} this token can reach.`,
                  inputSchema: { type: 'object', properties: {} },
                },
              ],
            },
          });
        }
        if (method === 'tools/call') {
          // Echo the presenting token alongside the value. `toolValue` is only
          // reachable by really calling this tool, and the token proves the call
          // was authorized — together they catch both a skipped tool call and an
          // unauthenticated one.
          return json({
            jsonrpc: '2.0',
            id,
            result: { content: [{ type: 'text', text: `${toolValue}|token:${bearer}` }] },
          });
        }
        return json({
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: 'method not found' },
        });
      }

      // ── Protected Resource Metadata (RFC 9728) ──────────────────────────
      if (path.includes('/.well-known/oauth-protected-resource')) {
        if (!guardUserAgent(req)) return json({ error: 'forbidden' }, 403);
        if (options.omitProtectedResourceMetadata) {
          return json({ error: 'not found' }, 404);
        }
        if (options.pathInsertedProtectedResource && !path.endsWith(mcpPath)) {
          return json({ error: 'not found' }, 404);
        }
        return json({
          resource: `${origin()}${mcpPath}`,
          authorization_servers: [origin()],
          scopes_supported: ['workspace:read'],
          resource_name: 'Fake Workspace MCP',
        });
      }

      // ── Authorization Server Metadata (RFC 8414) ────────────────────────
      if (path.includes('/.well-known/oauth-authorization-server')) {
        if (!guardUserAgent(req)) return json({ error: 'forbidden' }, 403);
        if (options.pathInsertedAuthorizationServer && !path.endsWith(mcpPath)) {
          return json({ error: 'not found' }, 404);
        }
        return json({
          issuer: origin(),
          authorization_endpoint: `${origin()}/authorize`,
          token_endpoint: `${origin()}/token`,
          ...(options.omitRegistrationEndpoint
            ? {}
            : { registration_endpoint: `${origin()}/register` }),
          revocation_endpoint: `${origin()}/revoke`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          scopes_supported: ['workspace:read'],
          token_endpoint_auth_methods_supported: advertisedAuthMethods(),
        });
      }

      // ── Dynamic Client Registration (RFC 7591) ──────────────────────────
      if (path === '/register' && req.method === 'POST') {
        const body = (await req.json().catch(() => ({}))) as {
          redirect_uris?: string[];
          token_endpoint_auth_method?: string;
        };
        // RFC 7591 §3.2.2: requesting a method the server does not advertise is
        // `invalid_client_metadata`. Figma rejects a public-client registration
        // outright, so a client that hardcodes `none` cannot connect at all.
        const requested = body.token_endpoint_auth_method ?? 'client_secret_basic';
        if (!advertisedAuthMethods().includes(requested)) {
          return json(
            {
              error: 'invalid_client_metadata',
              error_description: `token_endpoint_auth_method "${requested}" is not supported`,
            },
            400,
          );
        }
        const clientId = `client-${issuedClients.size + 1}`;
        const secret = requested === 'none' ? undefined : `secret-${clientId}`;
        issuedClients.set(clientId, {
          redirectUris: body.redirect_uris ?? [],
          secret,
          authMethod: requested,
        });
        return json(
          {
            client_id: clientId,
            ...(secret ? { client_secret: secret } : {}),
            redirect_uris: body.redirect_uris,
            token_endpoint_auth_method: requested,
          },
          201,
        );
      }

      // ── Authorization endpoint: where the user's browser is sent ─────────
      if (path === '/authorize') {
        const clientId = url.searchParams.get('client_id') ?? '';
        const client = issuedClients.get(clientId);
        if (!client) return new Response('unknown client', { status: 400 });
        if (options.enforceRedirectUri) {
          const redirect = url.searchParams.get('redirect_uri') ?? '';
          if (!client.redirectUris.includes(redirect)) {
            return new Response('redirect_uri mismatch', { status: 400 });
          }
        }
        const code = 'the-authorization-code';
        const challenge = url.searchParams.get('code_challenge');
        if (challenge) challengeByCode.set(code, challenge);
        // Echo the redirect_uri that was actually requested. A real AS validates
        // it against the registration and then redirects to exactly that value,
        // rather than to whatever the registration happened to list first.
        const requested = url.searchParams.get('redirect_uri') ?? client.redirectUris[0] ?? '';
        const callback = new URL(requested);
        callback.searchParams.set('code', code);
        callback.searchParams.set('state', url.searchParams.get('state') ?? '');
        return new Response(`<html><body>Continue at ${callback.toString()}</body></html>`, {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        });
      }

      // ── Token endpoint ──────────────────────────────────────────────────
      if (path === '/token' && req.method === 'POST') {
        const form = Object.fromEntries(new URLSearchParams(await req.text()));
        recorded.push({
          path,
          method: 'POST',
          userAgent: req.headers.get('user-agent'),
          authorization: auth,
          form,
        });

        const resolvedAuth = resolveClientAuth(req, form);
        if (!resolvedAuth.ok) {
          return json({ error: resolvedAuth.error, error_description: resolvedAuth.description }, 400);
        }
        const client = issuedClients.get(resolvedAuth.clientId);
        if (!client) return json({ error: 'invalid_client' }, 400);
        // The method used must be the one the registration settled on. A public
        // client that suddenly presents a secret is rejected, as is a
        // confidential client that authenticates the wrong way.
        if (client.authMethod !== resolvedAuth.method) {
          return json(
            {
              error: 'invalid_client',
              error_description: `registered for ${client.authMethod}, request used ${resolvedAuth.method}`,
            },
            401,
          );
        }
        if (client.secret && client.secret !== resolvedAuth.secret) {
          return json({ error: 'invalid_client' }, 401);
        }

        if (form.grant_type === 'authorization_code') {
          if (options.enforceRedirectUri && !client.redirectUris.includes(form.redirect_uri ?? '')) {
            return json({ error: 'invalid_grant' }, 400);
          }
          const stored = challengeByCode.get(form.code ?? '');
          if (!stored) {
            return json({ error: 'invalid_grant', error_description: 'unknown code' }, 400);
          }
          const expected = base64Url(
            createHash('sha256').update(form.code_verifier ?? '').digest(),
          );
          if (stored !== expected) {
            return json({ error: 'invalid_grant', error_description: 'PKCE mismatch' }, 400);
          }
          return json(issueTokens());
        }

        if (form.grant_type === 'refresh_token') {
          if (!validRefreshTokens.has(form.refresh_token ?? '')) {
            return json(
              { error: 'invalid_grant', error_description: 'unknown refresh token' },
              400,
            );
          }
          return json(issueTokens());
        }

        return json({ error: 'unsupported_grant_type' }, 400);
      }

      // ── Revocation ──────────────────────────────────────────────────────
      if (path === '/revoke' && req.method === 'POST') {
        const form = Object.fromEntries(new URLSearchParams(await req.text()));
        validAccessTokens.delete(form.token ?? '');
        validRefreshTokens.delete(form.token ?? '');
        return new Response(null, { status: 200 });
      }

      return json({ error: 'not found' }, 404);

      function issueTokens(): Record<string, unknown> {
        const accessToken = `at-${validAccessTokens.size + 1}`;
        validAccessTokens.add(accessToken);
        const payload: Record<string, unknown> = {
          access_token: accessToken,
          token_type: 'Bearer',
          expires_in: options.tokenLifetimeSeconds ?? 3600,
          scope: 'workspace:read',
        };
        if (options.issueRefreshToken !== false) {
          const refreshToken = `rt-${accessToken}`;
          validRefreshTokens.add(refreshToken);
          payload.refresh_token = refreshToken;
        }
        return payload;
      }
    },
  });

  port = server.port as number;

  return {
    url: `${origin()}${mcpPath}`,
    origin: origin(),
    recorded,
    issuedClients,
    validAccessTokens,
    seedClient: (client = {}) => {
      const clientId = client.clientId ?? `seeded-${issuedClients.size + 1}`;
      const authMethod = client.authMethod ?? (client.clientSecret ? 'client_secret_post' : 'none');
      issuedClients.set(clientId, {
        redirectUris: client.redirectUris ?? [],
        secret: client.clientSecret,
        authMethod,
      });
      return clientId;
    },
    stop: () => server.stop(true),
  };
}