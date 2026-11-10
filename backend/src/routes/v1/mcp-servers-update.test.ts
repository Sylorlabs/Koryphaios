// Regressions for editing existing MCP registrations from clients that cannot
// read secrets or the full stored config. Only disposable project roots are used.
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as actualContext from '../../context';
import { localAuth } from '../../auth/local-auth';
import { buildLocalBearerToken } from '../../auth/local-route-auth';
import { loadProjectMcpServers, syncMcpServersToConfig } from '../../runtime/config';
import { loadMcpEnvSecrets } from '../../security/secret-store';

const manager = {
  listServers: () => [],
  getClient: () => undefined,
  reloadServer: async () => undefined,
};

mock.module('../../context', () => ({
  ...actualContext,
  getContext: () => ({ mcpManager: manager, tools: {} }),
}));

const { mcpServerRoutes } = await import('./mcp-servers');
const roots: string[] = [];

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function project(servers: Record<string, Record<string, unknown>>): string {
  const root = mkdtempSync(join(tmpdir(), 'kory-mcp-edit-'));
  roots.push(root);
  syncMcpServersToConfig(root, servers);
  return root;
}

async function request(root: string, method: string, path: string, body?: unknown, authorized = true) {
  const headers: Record<string, string> = { 'x-koryphaios-project': root };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (authorized) headers.authorization = buildLocalBearerToken(localAuth.createSession(['mcp:edit:test']));
  const response = await mcpServerRoutes.handle(new Request(`http://localhost${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
  return { status: response.status, payload: await response.json() as Record<string, unknown> };
}

describe('editing MCP servers without exposing saved credentials', () => {
  test('omitting stdio fields retains command, args and all environment secrets', async () => {
    const root = project({ local: {
      type: 'stdio', command: 'node', args: ['--workdir', '/tmp/work space'],
      env: { TOKEN: 'secret-on-disk-only', SECOND: 'another-secret' },
    } });
    const result = await request(root, 'PUT', '/api/v1/mcp-servers/local', { type: 'stdio' });
    expect(result.status).toBe(200);
    expect(result.payload.ok).toBe(true);
    const persisted = loadProjectMcpServers(root).local;
    expect(persisted).toMatchObject({
      command: 'node', args: ['--workdir', '/tmp/work space'],
      env: { TOKEN: 'secret-on-disk-only', SECOND: 'another-secret' },
    });
    const raw = readFileSync(join(root, 'koryphaios.json'), 'utf8');
    expect(raw).not.toContain('secret-on-disk-only');
    expect(raw).not.toContain('another-secret');
    expect(loadMcpEnvSecrets(root).local).toEqual({ TOKEN: 'secret-on-disk-only', SECOND: 'another-secret' });
    const visible = await request(root, 'GET', '/api/v1/mcp-servers/local/env');
    expect(visible.payload.data).toMatchObject({ keys: ['TOKEN', 'SECOND'], valuesMasked: true });
    expect(JSON.stringify(visible.payload)).not.toContain('secret-on-disk-only');
  });

  test('updating one env key retains others; blank key value removes only that key', async () => {
    const root = project({ local: {
      type: 'stdio', command: 'bun', args: ['run', 'server.ts'],
      env: { ONE: 'old-value', TWO: 'keep-value' },
    } });
    const replaced = await request(root, 'PUT', '/api/v1/mcp-servers/local', {
      type: 'stdio', env: { ONE: 'new-value' },
    });
    expect(replaced.status).toBe(200);
    expect(loadMcpEnvSecrets(root).local).toEqual({ ONE: 'new-value', TWO: 'keep-value' });
    const removed = await request(root, 'PUT', '/api/v1/mcp-servers/local', {
      type: 'stdio', args: [], env: { ONE: '' },
    });
    expect(removed.status).toBe(200);
    expect(loadMcpEnvSecrets(root).local).toEqual({ TWO: 'keep-value' });
    expect(loadProjectMcpServers(root).local.args).toEqual([]);
  });

  test('SSE URL and headers survive an omitted edit, and individual header changes are scoped', async () => {
    const root = project({ remote: {
      type: 'sse', url: 'https://service.example/mcp',
      headers: { Authorization: 'Bearer keep', 'X-Project': 'old' },
    } });
    const first = await request(root, 'PUT', '/api/v1/mcp-servers/remote', { type: 'sse' });
    expect(first.status).toBe(200);
    const second = await request(root, 'PUT', '/api/v1/mcp-servers/remote', {
      type: 'sse', headers: { 'X-Project': 'new' },
    });
    expect(second.status).toBe(200);
    expect(loadProjectMcpServers(root).remote).toMatchObject({
      url: 'https://service.example/mcp',
      headers: { Authorization: 'Bearer keep', 'X-Project': 'new' },
    });
  });

  test('transport changes require new transport settings and do not wipe existing config when rejected', async () => {
    const root = project({ local: { type: 'stdio', command: 'node', env: { TOKEN: 'keep' } } });
    const invalid = await request(root, 'PUT', '/api/v1/mcp-servers/local', { type: 'sse' });
    expect(invalid.status).toBeGreaterThanOrEqual(400);
    expect(loadProjectMcpServers(root).local).toMatchObject({ type: 'stdio', command: 'node', env: { TOKEN: 'keep' } });
    const switched = await request(root, 'PUT', '/api/v1/mcp-servers/local', {
      type: 'sse', url: 'https://service.example/mcp',
    });
    expect(switched.status).toBe(200);
    expect(loadProjectMcpServers(root).local).toMatchObject({ type: 'sse', url: 'https://service.example/mcp' });
    expect(loadProjectMcpServers(root).local).not.toHaveProperty('command');
    expect(loadMcpEnvSecrets(root).local).toBeUndefined();
  });

  test('does not edit another project or accept unauthenticated updates', async () => {
    const a = project({ local: { type: 'stdio', command: 'node', env: { TOKEN: 'a-value' } } });
    const b = project({ local: { type: 'stdio', command: 'bun', env: { TOKEN: 'b-value' } } });
    const denied = await request(a, 'PUT', '/api/v1/mcp-servers/local', { type: 'stdio' }, false);
    expect(denied.status).toBeGreaterThanOrEqual(400);
    const changed = await request(b, 'PUT', '/api/v1/mcp-servers/local', {
      type: 'stdio', command: 'deno',
    });
    expect(changed.status).toBe(200);
    expect(loadProjectMcpServers(a).local).toMatchObject({ command: 'node', env: { TOKEN: 'a-value' } });
    expect(loadProjectMcpServers(b).local).toMatchObject({ command: 'deno', env: { TOKEN: 'b-value' } });
  });
});
