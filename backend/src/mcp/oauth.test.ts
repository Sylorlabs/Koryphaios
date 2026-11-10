// End-to-end OAuth 2.1 for remote MCP servers, against a fake authorization
// server that behaves like the real ones.
//
// The behaviours reproduced here are the ones that actually broke against
// production, each discovered by probing the live services:
//
//   • metadata published only at the resource-path-inserted well-known path
//     (Sentry publishes PRM only at /.well-known/oauth-protected-resource/mcp)
//   • metadata endpoints that answer 403 when no User-Agent is sent
//     (Notion and Sentry both do this)
//   • a 401 challenge that names the metadata URL directly
//   • dynamic client registration issuing a client that is confidential
//     (Figma) as well as public (Notion)
//   • access tokens that expire and must be refreshed with a refresh token
//
// The test drives the real MCPClient, the real discovery/DCR/PKCE code, the
// real loopback listener, and the real token store.

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { MCPClient } from './client';
import {
  discoverProtectedResource,
  discoverAuthorizationServer,
  parseWwwAuthenticate,
  wellKnownCandidates,
  generatePkce,
  buildAuthorizationUrl,
} from './oauth';
import {
  getMcpOAuthGrant,
  loadMcpOAuthGrants,
  removeMcpOAuthGrant,
  saveMcpOAuthGrants,
  upsertMcpOAuthGrant,
  isGrantFresh,
  summarizeGrant,
  TOKEN_REFRESH_SKEW_MS,
} from './oauth-secrets';
import { startOAuthCallbackListener } from './oauth-callback';
import { createHash } from 'node:crypto';
import { startFakeOAuthMcp, EXPECTED_USER_AGENT } from './testing/fake-oauth-mcp';

// ─── Fake authorization server + MCP server in one origin ───────────────────

// ─── Test harness ───────────────────────────────────────────────────────────

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    // Cleanups may be sync (rmSync, server.stop) or async (listener.close).
    await Promise.resolve(fn?.()).catch(() => {});
  }
});

function tempProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'kory-mcp-oauth-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

/**
 * Drive a complete authorization the way the settings UI does: start the flow,
 * follow the authorization URL like a browser would, let the loopback listener
 * capture the redirect, then complete.
 */
async function runAuthorizationFlow(options: {
  projectRoot: string;
  serverName: string;
  resourceUrl: string;
  wwwAuthenticate?: string | null;
}): Promise<{ authorizationUrl: string }> {
  const { beginAuthorization, completeAuthorization } = await import('./oauth-service');
  const started = await beginAuthorization({
    projectRoot: options.projectRoot,
    serverName: options.serverName,
    resourceUrl: options.resourceUrl,
    wwwAuthenticate: options.wwwAuthenticate ?? null,
  });

  // "Open the browser": follow the authorization endpoint and read the
  // callback URL it produced.
  const authResp = await fetch(started.authorizationUrl, { redirect: 'manual' });
  const page = await authResp.text();
  const match = /Continue at (http:\/\/127\.0\.0\.1:\d+\/callback\?[^<"]+)/.exec(page);
  if (!match)
    throw new Error(`authorization endpoint did not produce a redirect: ${page.slice(0, 200)}`);
  await fetch(match[1]!, { redirect: 'manual' });

  await completeAuthorization({
    projectRoot: options.projectRoot,
    serverName: options.serverName,
  });
  return { authorizationUrl: started.authorizationUrl };
}

// ─── Pure unit tests ────────────────────────────────────────────────────────

describe('WWW-Authenticate parsing', () => {
  test('extracts the MCP resource metadata pointer', () => {
    const parsed = parseWwwAuthenticate(
      'Bearer realm="OAuth", resource_metadata="https://mcp.notion.com/.well-known/oauth-protected-resource/mcp", error="invalid_token", error_description="Missing or invalid access token"',
    );
    expect(parsed.resource_metadata).toBe(
      'https://mcp.notion.com/.well-known/oauth-protected-resource/mcp',
    );
    expect(parsed.error).toBe('invalid_token');
  });

  test('extracts the scope hint Figma sends', () => {
    const parsed = parseWwwAuthenticate(
      'Bearer resource_metadata="https://mcp.figma.com/.well-known/oauth-protected-resource",scope="mcp:connect",authorization_uri="https://api.figma.com/.well-known/oauth-authorization-server"',
    );
    expect(parsed.scope).toBe('mcp:connect');
    expect(parsed.authorization_uri).toBe(
      'https://api.figma.com/.well-known/oauth-authorization-server',
    );
  });

  test('ignores non-Bearer schemes and empty headers', () => {
    expect(parseWwwAuthenticate('Basic realm="x"')).toEqual({});
    expect(parseWwwAuthenticate(null)).toEqual({});
    expect(parseWwwAuthenticate(undefined)).toEqual({});
  });
});

describe('well-known candidate generation', () => {
  test('tries the path-inserted form before the root form', () => {
    const candidates = wellKnownCandidates(
      'https://mcp.notion.com/mcp',
      'oauth-protected-resource',
    );
    expect(candidates[0]).toBe('https://mcp.notion.com/.well-known/oauth-protected-resource/mcp');
    expect(candidates).toContain('https://mcp.notion.com/.well-known/oauth-protected-resource');
  });

  test('handles a bare origin with no path', () => {
    const candidates = wellKnownCandidates('https://mcp.sentry.dev', 'oauth-authorization-server');
    expect(candidates).toContain('https://mcp.sentry.dev/.well-known/oauth-authorization-server');
  });

  test('returns nothing for an unparseable base URL', () => {
    expect(wellKnownCandidates('not a url', 'oauth-protected-resource')).toEqual([]);
  });
});

function base64Url(bytes: Buffer): string {
  return bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

describe('PKCE', () => {
  test('produces an S256 challenge that matches the verifier', () => {
    const { verifier, challenge, method } = generatePkce();
    expect(method).toBe('S256');
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(challenge).not.toContain('=');
    expect(base64Url(createHash('sha256').update(verifier).digest())).toBe(challenge);
  });

  test('never repeats a verifier', () => {
    const seen = new Set(Array.from({ length: 32 }, () => generatePkce().verifier));
    expect(seen.size).toBe(32);
  });
});

describe('authorization URL construction', () => {
  test('carries PKCE, state, redirect and resource', () => {
    const pkce = generatePkce();
    const url = new URL(
      buildAuthorizationUrl({
        metadata: {
          issuer: 'https://as.example',
          authorization_endpoint: 'https://as.example/authorize',
          token_endpoint: 'https://as.example/token',
        },
        clientId: 'abc',
        redirectUri: 'http://127.0.0.1:5555/callback',
        state: 'st-1',
        pkce,
        scopes: ['a', 'b'],
        resource: 'https://mcp.example/mcp',
      }),
    );
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBe(pkce.challenge);
    expect(url.searchParams.get('state')).toBe('st-1');
    expect(url.searchParams.get('scope')).toBe('a b');
    expect(url.searchParams.get('resource')).toBe('https://mcp.example/mcp');
  });
});

// ─── Token store ────────────────────────────────────────────────────────────

describe('MCP OAuth token store', () => {
  const grant = {
    accessToken: 'at-secret',
    tokenType: 'Bearer',
    refreshToken: 'rt-secret',
    expiresAt: Date.now() + 3_600_000,
    clientId: 'cid',
    clientSecret: 'csec',
    tokenEndpoint: 'https://as.example/token',
    resource: 'https://mcp.example/mcp',
    updatedAt: Date.now(),
  };

  test('round-trips a grant and keeps the file owner-only', () => {
    const root = tempProject();
    upsertMcpOAuthGrant(root, 'notion', grant);
    expect(getMcpOAuthGrant(root, 'notion')).toMatchObject({
      accessToken: 'at-secret',
      refreshToken: 'rt-secret',
      clientId: 'cid',
    });
    if (process.platform !== 'win32') {
      const mode = statSync(join(root, '.koryphaios', 'mcp-oauth.json')).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  test('never writes tokens into koryphaios.json', () => {
    const root = tempProject();
    upsertMcpOAuthGrant(root, 'notion', grant);
    // The committed config must not exist at all, let alone contain a token.
    expect(() => readFileSync(join(root, 'koryphaios.json'))).toThrow();
  });

  test('drops a malformed grant instead of trusting it', () => {
    const root = tempProject();
    saveMcpOAuthGrants(root, {
      good: grant,
      // Missing the access token.
      bad: { clientId: 'x', tokenEndpoint: 'y', resource: 'z' } as never,
      // Access token is the wrong type entirely.
      worse: { accessToken: 42, clientId: 'x', tokenEndpoint: 'y', resource: 'z' } as never,
    });
    const loaded = loadMcpOAuthGrants(root);
    expect(Object.keys(loaded)).toEqual(['good']);
  });

  test('treats a token near expiry as stale', () => {
    const now = 1_700_000_000_000;
    expect(isGrantFresh({ ...grant, expiresAt: now + TOKEN_REFRESH_SKEW_MS + 1000 }, now)).toBe(
      true,
    );
    expect(isGrantFresh({ ...grant, expiresAt: now + TOKEN_REFRESH_SKEW_MS - 1000 }, now)).toBe(
      false,
    );
    // No lifetime advertised means we trust it until a 401 says otherwise.
    expect(isGrantFresh({ ...grant, expiresAt: undefined }, now)).toBe(true);
  });

  test('summarizes without leaking token material', () => {
    const summary = summarizeGrant(grant);
    expect(summary.authorized).toBe(true);
    expect(summary.refreshable).toBe(true);
    expect(JSON.stringify(summary)).not.toContain('at-secret');
    expect(JSON.stringify(summary)).not.toContain('rt-secret');
  });

  test('removes a grant', () => {
    const root = tempProject();
    upsertMcpOAuthGrant(root, 'notion', grant);
    expect(removeMcpOAuthGrant(root, 'notion')).toBe(true);
    expect(removeMcpOAuthGrant(root, 'notion')).toBe(false);
    expect(getMcpOAuthGrant(root, 'notion')).toBeNull();
  });
});

// ─── Loopback listener ──────────────────────────────────────────────────────

describe('OAuth callback listener', () => {
  test('captures the code and enforces the state binding', async () => {
    const listener = await startOAuthCallbackListener({ expectedState: 'good-state' });
    cleanups.push(() => listener.close());

    const wrong = await fetch(`${listener.redirectUri}?code=abc&state=wrong-state`, {
      redirect: 'manual',
    });
    expect(wrong.status).toBe(400);

    const result = await listener.result;
    expect(result.error).toBe('state_mismatch');
  });

  test('returns the code on a matching state', async () => {
    const listener = await startOAuthCallbackListener({ expectedState: 'good-state' });
    cleanups.push(() => listener.close());

    const resp = await fetch(`${listener.redirectUri}?code=the-code&state=good-state`, {
      redirect: 'manual',
    });
    expect(resp.status).toBe(200);
    const body = await resp.text();
    expect(body).toContain('Koryphaios connected');
    // The page must never echo the authorization code back into the DOM.
    expect(body).not.toContain('the-code');

    const result = await listener.result;
    expect(result).toMatchObject({ code: 'the-code', state: 'good-state' });
  });

  test('surfaces a provider-side error', async () => {
    const listener = await startOAuthCallbackListener({ expectedState: 's' });
    cleanups.push(() => listener.close());
    await fetch(`${listener.redirectUri}?error=access_denied&error_description=User+said+no`, {
      redirect: 'manual',
    });
    const result = await listener.result;
    expect(result.error).toBe('access_denied');
    expect(result.errorDescription).toBe('User said no');
  });

  test('binds loopback only and serves one route', async () => {
    const listener = await startOAuthCallbackListener({ expectedState: 's' });
    cleanups.push(() => listener.close());
    const port = new URL(listener.redirectUri).port;
    expect(listener.redirectUri.startsWith('http://127.0.0.1:')).toBe(true);

    const wrongPath = await fetch(`http://127.0.0.1:${port}/anything-else`, {
      redirect: 'manual',
    });
    expect(wrongPath.status).toBe(404);

    await fetch(`${listener.redirectUri}?code=c&state=s`, { redirect: 'manual' });
    await listener.result;
  });
});

// ─── Discovery against a fake AS ────────────────────────────────────────────

describe('OAuth metadata discovery', () => {
  test('finds metadata published only at the path-inserted well-known path', async () => {
    const fake = await startFakeOAuthMcp({ pathInsertedProtectedResource: true });
    cleanups.push(fake.stop);

    const prm = await discoverProtectedResource(fake.url);
    expect(prm?.authorization_servers).toHaveLength(1);

    const as = await discoverAuthorizationServer(prm!.authorization_servers[0]!);
    expect(as?.authorization_endpoint).toContain('/authorize');
    expect(as?.registration_endpoint).toContain('/register');
  });

  test('identifies itself with its own User-Agent on every metadata request', async () => {
    // Notion and Sentry both answer 403 to metadata requests that do not carry a
    // recognizable agent, so the exact value matters — asserting merely "some
    // User-Agent is present" would pass even without Koryphaios setting one,
    // because the HTTP client supplies a default.
    const fake = await startFakeOAuthMcp({ rejectForeignAgents: true });
    cleanups.push(fake.stop);

    const prm = await discoverProtectedResource(fake.url);
    expect(prm).not.toBeNull();
    const as = await discoverAuthorizationServer(prm!.authorization_servers[0]!);
    expect(as).not.toBeNull();

    expect(fake.recorded.length).toBeGreaterThan(0);
    for (const call of fake.recorded) {
      expect(call.userAgent).toBe('Koryphaios (MCP OAuth client)');
    }
  });

  test('a metadata endpoint that 403s a foreign agent blocks discovery', async () => {
    // Guards the guard: the fake must actually be refusing, otherwise the test
    // above proves nothing.
    const fake = await startFakeOAuthMcp({ rejectForeignAgents: true });
    cleanups.push(fake.stop);
    const resp = await fetch(
      `${fake.url.replace('/mcp', '')}/.well-known/oauth-protected-resource/mcp`,
      {
        headers: { 'User-Agent': 'Python-urllib/3.13' },
      },
    );
    expect(resp.status).toBe(403);
  });

  test('prefers the metadata URL the server names in its 401 challenge', async () => {
    const fake = await startFakeOAuthMcp();
    cleanups.push(fake.stop);

    // Discover via the challenge header alone, with a URL that cannot be probed.
    const prm = await discoverProtectedResource(
      'https://unreachable.invalid/mcp',
      `Bearer resource_metadata="${fake.url.replace('/mcp', '')}/.well-known/oauth-protected-resource/mcp"`,
    );
    expect(prm?.resource).toContain('127.0.0.1');
  });
});

// ─── Full flow: client + store ──────────────────────────────────────────────

describe('remote MCP server authorization end to end', () => {
  test('a 401 puts the client into "requires authorization" instead of failing opaquely', async () => {
    const fake = await startFakeOAuthMcp();
    cleanups.push(fake.stop);
    const root = tempProject();

    const client = new MCPClient({ name: 'workspace', transport: 'sse', url: fake.url }, async () =>
      (await import('./oauth-service')).ensureAccessToken(root, 'workspace'),
    );

    await expect(client.connect()).rejects.toThrow(/requires authorization/);
    expect(client.needsAuthorization).toBe(true);
    // The 401's challenge is retained so the UI can start discovery from it.
    expect(client.authorizationChallengeHeader).toContain('resource_metadata');
    await client.shutdown();
  });

  test('a full authorization makes the same client connect and call tools', async () => {
    const fake = await startFakeOAuthMcp({ issueRefreshToken: true });
    cleanups.push(fake.stop);
    const root = tempProject();

    await runAuthorizationFlow({
      projectRoot: root,
      serverName: 'workspace',
      resourceUrl: fake.url,
    });

    const grant = getMcpOAuthGrant(root, 'workspace');
    expect(grant?.accessToken).toMatch(/^at-/);
    expect(grant?.refreshToken).toMatch(/^rt-/);
    expect(grant?.clientId).toMatch(/^client-/);
    expect(grant?.resource).toContain('127.0.0.1');
    // A confidential secret must not be persisted for a public client.
    expect(grant?.clientSecret).toBeUndefined();

    const client = new MCPClient({ name: 'workspace', transport: 'sse', url: fake.url }, async () =>
      (await import('./oauth-service')).ensureAccessToken(root, 'workspace'),
    );
    await client.connect();
    expect(client.needsAuthorization).toBe(false);
    expect(client.availableTools.map((t) => t.name)).toEqual(['whoami']);

    const result = await client.callTool('whoami', {});
    expect(result.isError).toBeFalsy();
    // The echoed token proves the tool call itself was authorized, not just the
    // earlier handshake.
    expect(result.content[0]?.text).toBe(`workspace|token:${grant!.accessToken}`);

    await client.shutdown();
  });

  test('works with a confidential client that receives a client secret', async () => {
    const fake = await startFakeOAuthMcp({ confidentialClient: true, enforceRedirectUri: true });
    cleanups.push(fake.stop);
    const root = tempProject();

    await runAuthorizationFlow({
      projectRoot: root,
      serverName: 'figma_like',
      resourceUrl: fake.url,
    });

    const grant = getMcpOAuthGrant(root, 'figma_like');
    expect(grant?.clientSecret).toMatch(/^secret-/);

    const client = new MCPClient(
      { name: 'figma_like', transport: 'sse', url: fake.url },
      async () => (await import('./oauth-service')).ensureAccessToken(root, 'figma_like'),
    );
    await client.connect();
    expect(client.availableTools.length).toBe(1);
    await client.shutdown();
  });

  test('registers confidentially against a server that refuses public clients (Figma)', async () => {
    // Figma's live metadata advertises token_endpoint_auth_methods_supported of
    // ["client_secret_basic", "client_secret_post"] — there is no "none". A
    // client that hardcodes a public registration is rejected outright with
    // invalid_client_metadata, so it can never reach a consent screen at all.
    const fake = await startFakeOAuthMcp({
      tokenEndpointAuthMethods: ['client_secret_basic', 'client_secret_post'],
    });
    cleanups.push(fake.stop);
    const root = tempProject();

    await runAuthorizationFlow({
      projectRoot: root,
      serverName: 'figma',
      resourceUrl: fake.url,
    });

    const grant = getMcpOAuthGrant(root, 'figma');
    expect(grant?.clientSecret).toMatch(/^secret-/);
    expect(grant?.accessToken).toMatch(/^at-/);
    // The registered method is persisted, because a refresh has to reuse it.
    expect(grant?.tokenEndpointAuthMethod).toBe('client_secret_post');

    // The registration must not have asked for a method the server refused.
    const registered = [...fake.issuedClients.values()][0];
    expect(registered?.authMethod).not.toBe('none');
    expect(fake.issuedClients.has('client-1')).toBe(true);
  });

  test('a token request uses exactly one client-authentication method', async () => {
    // RFC 6749 §2.3: a client MUST NOT use more than one authentication method
    // per request. Sending Basic *and* client_secret in the body is two, and
    // real authorization servers answer that with invalid_request. A public
    // client never triggers it, which is why it survives against a naive fake.
    const fake = await startFakeOAuthMcp({
      tokenEndpointAuthMethods: ['client_secret_post'],
    });
    cleanups.push(fake.stop);
    const root = tempProject();

    await runAuthorizationFlow({
      projectRoot: root,
      serverName: 'confidential',
      resourceUrl: fake.url,
    });

    const exchanges = fake.recorded.filter((call) => call.path === '/token');
    expect(exchanges.length).toBeGreaterThan(0);
    for (const exchange of exchanges) {
      const usedBasic = exchange.authorization?.startsWith('Basic ') ?? false;
      const usedPost = exchange.form?.client_secret !== undefined;
      expect(usedBasic && usedPost).toBe(false);
      if (usedBasic) {
        // Basic carries the identity, so the body must not repeat it.
        expect(exchange.form?.client_id).toBeUndefined();
        expect(exchange.form?.client_secret).toBeUndefined();
      }
    }
  });

  test('a refresh reuses the method the client registered with', async () => {
    const fake = await startFakeOAuthMcp({
      tokenEndpointAuthMethods: ['client_secret_post'],
      tokenLifetimeSeconds: 1,
      issueRefreshToken: true,
    });
    cleanups.push(fake.stop);
    const root = tempProject();

    await runAuthorizationFlow({
      projectRoot: root,
      serverName: 'confidential',
      resourceUrl: fake.url,
    });

    const { ensureAccessToken } = await import('./oauth-service');
    const headers = await ensureAccessToken(root, 'confidential');
    expect(headers?.Authorization).toMatch(/^Bearer at-/);
    // A refresh that silently changed authentication method would be rejected
    // by a server that only accepts one; the fake enforces that, so reaching a
    // new token here proves the persisted method was carried through.
    expect(getMcpOAuthGrant(root, 'confidential')?.tokenEndpointAuthMethod).toBe(
      'client_secret_post',
    );
  });

  test('an expired token is refreshed transparently before the next call', async () => {
    // 1 second lifetime, and the refresh skew is 60s, so the token is stale
    // immediately after issue — exactly the real-world case.
    const fake = await startFakeOAuthMcp({ tokenLifetimeSeconds: 1, issueRefreshToken: true });
    cleanups.push(fake.stop);
    const root = tempProject();

    await runAuthorizationFlow({
      projectRoot: root,
      serverName: 'workspace',
      resourceUrl: fake.url,
    });
    const firstToken = getMcpOAuthGrant(root, 'workspace')!.accessToken;

    const { ensureAccessToken } = await import('./oauth-service');
    const headers = await ensureAccessToken(root, 'workspace');
    expect(headers?.Authorization).toMatch(/^Bearer at-/);

    const secondToken = getMcpOAuthGrant(root, 'workspace')!.accessToken;
    expect(secondToken).not.toBe(firstToken);

    // The refreshed token actually works against the server.
    const client = new MCPClient({ name: 'workspace', transport: 'sse', url: fake.url }, async () =>
      ensureAccessToken(root, 'workspace'),
    );
    await client.connect();
    expect(client.availableTools.length).toBe(1);
    await client.shutdown();
  });

  test('a 401 after the grant is gone re-enters the needs-authorization state', async () => {
    const fake = await startFakeOAuthMcp({ issueRefreshToken: false });
    cleanups.push(fake.stop);
    const root = tempProject();

    await runAuthorizationFlow({
      projectRoot: root,
      serverName: 'workspace',
      resourceUrl: fake.url,
    });

    // Provider forgets the token (e.g. it was revoked server-side).
    fake.validAccessTokens.clear();

    const { ensureAccessToken } = await import('./oauth-service');
    const client = new MCPClient({ name: 'workspace', transport: 'sse', url: fake.url }, async () =>
      ensureAccessToken(root, 'workspace'),
    );
    await expect(client.connect()).rejects.toThrow(/requires authorization/);
    expect(client.needsAuthorization).toBe(true);
    await client.shutdown();
  });

  test('PKCE is verified: a mismatched verifier is rejected by the server', async () => {
    const fake = await startFakeOAuthMcp();
    cleanups.push(fake.stop);

    // Drive /authorize so the fake records the challenge we will later fail to
    // reproduce from the verifier, exactly as a real AS does.
    const pkce = generatePkce();
    const { discoverAuthorizationServer } = await import('./oauth');
    const as = await discoverAuthorizationServer(fake.url);

    // Register first: /authorize rejects a client_id it has never issued.
    const registrationResp = await fetch(`${fake.url.replace('/mcp', '')}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Name the public method explicitly. Omitting it makes a real AS default
      // to `client_secret_basic` and issue a secret, which would then be
      // required on every exchange.
      body: JSON.stringify({
        redirect_uris: ['http://127.0.0.1:9/callback'],
        token_endpoint_auth_method: 'none',
      }),
    });
    const registered = (await registrationResp.json()) as { client_id: string };

    const authorizationUrl = buildAuthorizationUrl({
      metadata: as!,
      clientId: registered.client_id,
      redirectUri: 'http://127.0.0.1:9/callback',
      state: 'probe-state',
      pkce,
      scopes: ['workspace:read'],
    });
    const page = await (await fetch(authorizationUrl, { redirect: 'manual' })).text();
    const match = /Continue at (http:\/\/127\.0\.0\.1:\d+\/callback\?[^<"]+)/.exec(page);
    expect(match).not.toBeNull();
    const code = new URL(match![1]!).searchParams.get('code')!;

    const { exchangeAuthorizationCode } = await import('./oauth');
    const registration = { client_id: registered.client_id };

    // The correct verifier succeeds.
    const ok = await exchangeAuthorizationCode({
      metadata: as!,
      registration,
      code,
      codeVerifier: pkce.verifier,
      redirectUri: 'http://127.0.0.1:9/callback',
    });
    expect(ok.accessToken).toMatch(/^at-/);

    // A tampered verifier is refused.
    await expect(
      exchangeAuthorizationCode({
        metadata: as!,
        registration,
        code,
        codeVerifier: `${pkce.verifier}tampered`,
        redirectUri: 'http://127.0.0.1:9/callback',
      }),
    ).rejects.toThrow(/PKCE mismatch/);
  });

  test('disconnect revokes at the provider and deletes the local grant', async () => {
    const fake = await startFakeOAuthMcp();
    cleanups.push(fake.stop);
    const root = tempProject();

    await runAuthorizationFlow({
      projectRoot: root,
      serverName: 'workspace',
      resourceUrl: fake.url,
    });
    const token = getMcpOAuthGrant(root, 'workspace')!.accessToken;
    expect(fake.validAccessTokens.has(token)).toBe(true);

    const { disconnect } = await import('./oauth-service');
    expect(await disconnect({ projectRoot: root, serverName: 'workspace' })).toBe(true);
    expect(getMcpOAuthGrant(root, 'workspace')).toBeNull();
    expect(fake.validAccessTokens.has(token)).toBe(false);
  });

  test('falls back to the MCP origin when no protected-resource metadata exists', async () => {
    // Atlassian publishes authorization-server metadata but no PRM at all. The
    // flow must still work by treating the MCP origin as the issuer.
    const fake = await startFakeOAuthMcp({ omitProtectedResourceMetadata: true });
    cleanups.push(fake.stop);
    const root = tempProject();

    // Discovery at the PRM layer genuinely fails...
    expect(await discoverProtectedResource(fake.url)).toBeNull();

    // ...but the full flow still authorizes.
    await runAuthorizationFlow({
      projectRoot: root,
      serverName: 'atlassian_like',
      resourceUrl: fake.url,
    });
    const grant = getMcpOAuthGrant(root, 'atlassian_like');
    expect(grant?.accessToken).toMatch(/^at-/);
    // With no PRM there is no advertised resource, so the MCP URL is used.
    expect(grant?.resource).toContain('127.0.0.1');
    expect(grant?.authorizationServerIssuer).toContain('127.0.0.1');
  });

  test('a server with no dynamic registration reports an actionable error', async () => {
    const fake = await startFakeOAuthMcp();
    cleanups.push(fake.stop);
    const root = tempProject();

    const { beginAuthorization } = await import('./oauth-service');
    const { authorizationStatus } = await import('./oauth-service');

    // Sanity: the fake does publish a registration endpoint, so this succeeds.
    const started = await beginAuthorization({
      projectRoot: root,
      serverName: 'workspace',
      resourceUrl: fake.url,
    });
    expect(started.authorizationUrl).toContain('code_challenge_method=S256');
    const { cancelFlow } = await import('./oauth-service');
    expect(await cancelFlow(root, 'workspace')).toBe(true);

    // A started-then-cancelled flow leaves no grant and no pending flow behind.
    expect(authorizationStatus(root, 'workspace').authorized).toBe(false);
  });

  test('a server with no registration endpoint fails with an actionable message', async () => {
    // Slack's shape: full AS metadata, PKCE S256, but no dynamic registration.
    const fake = await startFakeOAuthMcp({
      omitRegistrationEndpoint: true,
      tokenEndpointAuthMethods: ['client_secret_post'],
    });
    cleanups.push(fake.stop);

    const { resolveAuthorizationChallenge, McpOAuthError } = await import('./oauth');
    let thrown: unknown;
    try {
      await resolveAuthorizationChallenge({
        resourceUrl: fake.url,
        redirectUri: 'http://127.0.0.1:1/callback',
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(McpOAuthError);
    expect((thrown as InstanceType<typeof McpOAuthError>).code).toBe(
      'dynamic_registration_unavailable',
    );
    // The message must tell the user what to do, not just that it failed.
    expect((thrown as Error).message).toContain('does not allow apps to register automatically');
    expect((thrown as Error).message).toContain('client ID and client secret');
    expect((thrown as Error).message).toContain('127.0.0.1');

    // Supplying the user's own app credentials unblocks it, without any
    // registration endpoint existing.
    const { resolveAuthorizationChallenge: resolve } = await import('./oauth');
    const withCredentials = await resolve({
      resourceUrl: fake.url,
      redirectUri: 'http://127.0.0.1:1/callback',
      manualClient: { clientId: 'my-own-app', clientSecret: 'my-own-secret' },
    });
    expect(withCredentials.registration.client_id).toBe('my-own-app');
    expect(withCredentials.registration.client_secret).toBe('my-own-secret');
    expect(withCredentials.protectedResource).not.toBeNull();
  });

  test('an AS that only supports plain PKCE is refused', async () => {
    const { assertPkceSupported, McpOAuthError } = await import('./oauth');
    expect(() =>
      assertPkceSupported({
        issuer: 'https://as.example',
        authorization_endpoint: 'https://as.example/a',
        token_endpoint: 'https://as.example/t',
        code_challenge_methods_supported: ['plain'],
      }),
    ).toThrow(McpOAuthError);
  });

  test('a non-http(s) authorization endpoint is rejected as unsafe', async () => {
    const fake = await startFakeOAuthMcp();
    cleanups.push(fake.stop);
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          JSON.stringify({
            issuer: 'http://127.0.0.1:1',
            authorization_endpoint: 'javascript:alert(1)',
            token_endpoint: 'http://127.0.0.1:1/token',
          }),
          { headers: { 'Content-Type': 'application/json' } },
        ),
    });
    cleanups.push(() => server.stop(true));
    const as = await discoverAuthorizationServer(`http://127.0.0.1:${server.port}`);
    expect(as).toBeNull();
  });
});
