// The OAuth HTTP surface on /api/v1/mcp-servers.
//
// These are thin handlers, but they are the only way the settings UI can reach
// the flow, so a typo here makes the whole feature unreachable while every unit
// test below it still passes. Each test drives a real Elysia app against a real
// on-disk project root and a real OAuth-protected fake server.

import { describe, expect, test, afterEach, mock } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import * as actualContext from '../../context';
import { startFakeOAuthMcp, type FakeOAuthMcp } from '../../mcp/testing/fake-oauth-mcp';
import { getMcpOAuthGrant } from '../../mcp/oauth-secrets';
import { localAuth } from '../../auth/local-auth';
import { buildLocalBearerToken } from '../../auth/local-route-auth';

// Imported after mock.module() so the routes see the stubbed context.
const { mcpServerRoutes } = await import('./mcp-servers');

// The service layer reads the ambient Koryphaios context for its MCP manager.
// These routes only need config + secret reads, so a minimal stub is enough and
// keeps the test from booting the whole application. The stub must be installed
// before the routes are imported, since server-service binds getContext
// statically and ES module namespaces cannot be patched afterwards.
const contextStub = {
  mcpManager: {
    getClient: () => undefined,
    listServers: () => [],
    reloadServer: async () => undefined,
  },
  tools: {},
};

mock.module('../../context', () => ({
  ...actualContext,
  getContext: () => contextStub,
}));

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    await Promise.resolve(fn?.()).catch(() => {});
  }
});

function tempProject(mcpServers?: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), 'kory-mcp-oauth-routes-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  if (mcpServers) {
    writeFileSync(join(root, 'koryphaios.json'), JSON.stringify({ mcpServers }, null, 2), 'utf-8');
  }
  return root;
}

function token(): string {
  return buildLocalBearerToken(localAuth.createSession(['mcp:test:manager']));
}

interface CallOptions {
  method?: string;
  path: string;
  root: string;
  body?: unknown;
  auth?: boolean;
}

async function call(
  app: Awaited<typeof import('./mcp-servers')>['mcpServerRoutes'],
  options: CallOptions,
) {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.auth !== false) headers.Authorization = token();
  headers['x-koryphaios-project'] = options.root;

  const resp = await app.handle(
    new Request(`http://localhost${options.path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    }),
  );
  const text = await resp.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = { raw: text };
  }
  return { status: resp.status, json };
}

async function fakeServer(): Promise<FakeOAuthMcp> {
  const fake = await startFakeOAuthMcp();
  cleanups.push(() => fake.stop());
  return fake;
}

/** Walk the full flow through HTTP only: start -> consent -> callback -> complete. */
async function authorizeViaHttp(
  app: Awaited<typeof import('./mcp-servers')>['mcpServerRoutes'],
  root: string,
  fake: FakeOAuthMcp,
  name: string,
  body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const started = await call(app, {
    method: 'POST',
    path: `/api/v1/mcp-servers/${name}/oauth/start`,
    root,
    ...(body ? { body } : {}),
  });
  const url = (started.json.data as { authorizationUrl: string }).authorizationUrl;
  const page = await (await fetch(url, { redirect: 'manual' })).text();
  const callback = /Continue at (http:\/\/127\.0\.0\.1:\d+\/callback\?[^<"]+)/.exec(page);
  if (!callback) {
    // Release the pending flow and its listener; otherwise it blocks the next
    // test and waits out the five-minute consent window.
    await call(app, {
      method: 'POST',
      path: `/api/v1/mcp-servers/${name}/oauth/cancel`,
      root,
    });
    throw new Error(`no loopback redirect produced: ${page.slice(0, 120)}`);
  }
  await fetch(callback[1]!, { redirect: 'manual' });
  const done = await call(app, {
    method: 'POST',
    path: `/api/v1/mcp-servers/${name}/oauth/complete`,
    root,
  });
  return done.json;
}

describe('MCP server OAuth routes', () => {
  test('requires local auth on every OAuth route', async () => {
    const app = mcpServerRoutes;
    const root = tempProject();
    for (const [method, path] of [
      ['POST', '/api/v1/mcp-servers/x/oauth/start'],
      ['POST', '/api/v1/mcp-servers/x/oauth/complete'],
      ['GET', '/api/v1/mcp-servers/x/oauth'],
      ['POST', '/api/v1/mcp-servers/x/oauth/cancel'],
      ['DELETE', '/api/v1/mcp-servers/x/oauth'],
    ] as const) {
      const res = await call(app, { method, path, root, auth: false });
      expect(res.json.ok).toBe(false);
    }
  });

  test('a full authorization round-trips over HTTP and stores a grant', async () => {
    const app = mcpServerRoutes;
    const fake = await fakeServer();
    const root = tempProject({ workspace: { type: 'sse', url: fake.url } });

    const status = await call(app, { path: '/api/v1/mcp-servers/workspace/oauth', root });
    expect(status.json.ok).toBe(true);
    expect(status.json.data).toMatchObject({ authorized: false });

    const done = await authorizeViaHttp(app, root, fake, 'workspace');
    expect(done.ok).toBe(true);

    const grant = getMcpOAuthGrant(root, 'workspace');
    expect(grant?.accessToken).toMatch(/^at-/);
    expect(grant?.scope).toBe('workspace:read');

    const after = await call(app, { path: '/api/v1/mcp-servers/workspace/oauth', root });
    expect((after.json.data as { authorized: boolean }).authorized).toBe(true);
  });

  test('status never returns token material', async () => {
    const app = mcpServerRoutes;
    const fake = await fakeServer();
    const root = tempProject({ workspace: { type: 'sse', url: fake.url } });
    await authorizeViaHttp(app, root, fake, 'workspace');

    const res = await call(app, { path: '/api/v1/mcp-servers/workspace/oauth', root });
    const body = JSON.stringify(res.json);
    const grant = getMcpOAuthGrant(root, 'workspace');
    expect(body).not.toContain(grant!.accessToken);
    expect(body).not.toContain(grant!.refreshToken!);
    expect(body).not.toContain(grant!.clientId);
  });

  test('rejects a start for a stdio server, which never needs OAuth', async () => {
    const app = mcpServerRoutes;
    const root = tempProject({
      local: { type: 'stdio', command: 'npx', args: ['-y', 'some-server'] },
    });
    const res = await call(app, {
      method: 'POST',
      path: '/api/v1/mcp-servers/local/oauth/start',
      root,
    });
    expect(res.json.ok).toBe(false);
    expect(String(res.json.error)).toContain('no URL');
  });

  test('rejects a start for an unknown server', async () => {
    const app = mcpServerRoutes;
    const root = tempProject();
    const res = await call(app, {
      method: 'POST',
      path: '/api/v1/mcp-servers/ghost/oauth/start',
      root,
    });
    expect(res.json.ok).toBe(false);
  });

  test('surfaces an actionable error when the provider has no registration endpoint', async () => {
    const app = mcpServerRoutes;
    // Slack's shape: full AS metadata, no dynamic client registration.
    const fake = await startFakeOAuthMcp({ omitRegistrationEndpoint: true });
    cleanups.push(() => fake.stop());
    const root = tempProject({ slack: { type: 'sse', url: fake.url } });

    const res = await call(app, {
      method: 'POST',
      path: '/api/v1/mcp-servers/slack/oauth/start',
      root,
    });
    expect(res.json.ok).toBe(false);
    expect(res.json.code).toBe('dynamic_registration_unavailable');
    // The message must tell the user what to do, not merely that it failed.
    expect(String(res.json.error)).toContain('does not allow apps to register automatically');
    expect(String(res.json.error)).toContain('client ID and client secret');
    // A failed start must not leave a listener or a grant behind.
    expect(getMcpOAuthGrant(root, 'slack')).toBeNull();
  });

  test("the user's own app credentials unblock a server with no registration endpoint", async () => {
    const app = mcpServerRoutes;
    // Slack's shape: no registration endpoint, so the user must bring an app.
    const fake = await startFakeOAuthMcp({
      omitRegistrationEndpoint: true,
      tokenEndpointAuthMethods: ['client_secret_post'],
    });
    cleanups.push(() => fake.stop());
    const root = tempProject({ slack: { type: 'sse', url: fake.url } });

    // Pre-register the client the way the user's own Slack app would be.
    const clientId = fake.seedClient({ redirectUris: ['http://127.0.0.1:1/callback'] });

    const started = await call(app, {
      method: 'POST',
      path: '/api/v1/mcp-servers/slack/oauth/start',
      root,
      body: { clientId, clientSecret: 'user-supplied-secret' },
    });
    expect(started.json.ok).toBe(true);
    const url = (started.json.data as { authorizationUrl: string }).authorizationUrl;
    expect(url).toContain(`client_id=${clientId}`);
    expect(url).toContain('code_challenge_method=S256');
    expect(url).toContain('state=');
  });

  test('manual client credentials are recorded on the stored grant', async () => {
    const app = mcpServerRoutes;
    // No dynamic registration, so the only way in is the user's own app.
    const fake = await startFakeOAuthMcp({
      omitRegistrationEndpoint: true,
      tokenEndpointAuthMethods: ['client_secret_post'],
    });
    cleanups.push(() => fake.stop());
    const root = tempProject({ slack: { type: 'sse', url: fake.url } });

    // Stand in for the client the user created in the provider's own UI.
    const clientId = fake.seedClient({
      clientSecret: 'my-own-secret',
      redirectUris: ['http://127.0.0.1:1/callback'],
    });

    await authorizeViaHttp(app, root, fake, 'slack', {
      clientId,
      clientSecret: 'my-own-secret',
    });

    const grant = getMcpOAuthGrant(root, 'slack');
    expect(grant?.clientId).toBe(clientId);
    expect(grant?.clientSecret).toBe('my-own-secret');
    expect(grant?.manualClient).toBe(true);
    // A grant that actually works still has to be produced.
    expect(grant?.accessToken).toMatch(/^at-/);
    // A user-supplied app authenticates with the method it was registered for.
    expect(grant?.tokenEndpointAuthMethod).toBe('client_secret_post');
  });

  test('completing without a pending flow reports that nothing is in progress', async () => {
    const app = mcpServerRoutes;
    const fake = await fakeServer();
    const root = tempProject({ workspace: { type: 'sse', url: fake.url } });

    const res = await call(app, {
      method: 'POST',
      path: '/api/v1/mcp-servers/workspace/oauth/complete',
      root,
    });
    expect(res.json.ok).toBe(false);
    expect(String(res.json.error)).toContain('No authorization is in progress');
  });

  test('cancel clears a pending flow so a later complete reports nothing pending', async () => {
    const app = mcpServerRoutes;
    const fake = await fakeServer();
    const root = tempProject({ workspace: { type: 'sse', url: fake.url } });

    const started = await call(app, {
      method: 'POST',
      path: '/api/v1/mcp-servers/workspace/oauth/start',
      root,
    });
    expect(started.json.ok).toBe(true);

    const cancelled = await call(app, {
      method: 'POST',
      path: '/api/v1/mcp-servers/workspace/oauth/cancel',
      root,
    });
    expect((cancelled.json.data as { cancelled: boolean }).cancelled).toBe(true);

    const done = await call(app, {
      method: 'POST',
      path: '/api/v1/mcp-servers/workspace/oauth/complete',
      root,
    });
    expect(done.json.ok).toBe(false);
    expect(getMcpOAuthGrant(root, 'workspace')).toBeNull();
  });

  test('disconnect revokes the grant and reports whether one existed', async () => {
    const app = mcpServerRoutes;
    const fake = await fakeServer();
    const root = tempProject({ workspace: { type: 'sse', url: fake.url } });
    await authorizeViaHttp(app, root, fake, 'workspace');

    const res = await call(app, {
      method: 'DELETE',
      path: '/api/v1/mcp-servers/workspace/oauth',
      root,
    });
    expect((res.json.data as { revoked: boolean }).revoked).toBe(true);
    expect(getMcpOAuthGrant(root, 'workspace')).toBeNull();

    // A second disconnect is a no-op, not an error.
    const again = await call(app, {
      method: 'DELETE',
      path: '/api/v1/mcp-servers/workspace/oauth',
      root,
    });
    expect(again.json.ok).toBe(true);
    expect((again.json.data as { revoked: boolean }).revoked).toBe(false);
  });

  test('works when the project has no koryphaios.json yet', async () => {
    const app = mcpServerRoutes;
    const fake = await fakeServer();
    // mkdir the data dir so the secret store can write, but no config file.
    const root = tempProject();
    mkdirSync(join(root, '.koryphaios'), { recursive: true });

    const res = await call(app, {
      method: 'POST',
      path: '/api/v1/mcp-servers/absent/oauth/start',
      root,
    });
    expect(res.json.ok).toBe(false);
    expect(String(res.json.error)).toContain('no URL');
    expect(fake.url).toContain('127.0.0.1');
  });
});
