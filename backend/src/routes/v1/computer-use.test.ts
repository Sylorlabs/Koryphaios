import { describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ComputerPlatformAdapter } from '@koryphaios/shared';

process.env.NODE_ENV = 'test';
process.env.SESSION_TOKEN_SECRET ??= 'test_only_not_for_production_aaaaaaaaaa';
const { localAuth } = await import('../../auth/local-auth');
const { buildLocalBearerToken } = await import('../../auth/local-route-auth');
const { createComputerUseRoutes } = await import('./computer-use');
const { loadAgentSettings, saveAgentSettings } = await import('../../agent-settings');
const { agentSettingsRoutes } = await import('./agent-settings');

function fixture() {
  let discoveries = 0;
  let statuses = 0;
  const adapter: ComputerPlatformAdapter = {
    status: async () => {
      statuses++;
      return { platform: 'test', available: true, capabilities: ['discover'], limitations: [] };
    },
    execute: async () => {
      discoveries++;
      return { targets: [{ appId: 'host.editor', windowId: '1', pid: 1, title: 'Editor' }] };
    },
  };
  return {
    app: new Elysia().use(createComputerUseRoutes(adapter)),
    discoveries: () => discoveries,
    statuses: () => statuses,
  };
}

describe('authenticated computer settings routes', () => {
  it('requires current human revision and prevents stale settings saves from undoing Stop', async () => {
    const f = fixture();
    f.app.use(agentSettingsRoutes);
    const root = mkdtempSync(join(tmpdir(), 'kory-computer-revision-'));
    const auth = localAuth.createSession();
    const headers = {
      authorization: buildLocalBearerToken(auth),
      'x-koryphaios-project': root,
      'content-type': 'application/json',
    };
    const url = 'http://localhost/api/agent/settings';
    try {
      const loaded = await (await f.app.handle(new Request(url, { headers }))).json();
      const patch = {
        computerUse: { ...loaded.data.computerUse, enabled: true },
        computerUseRevision: loaded.data.computerUseRevision,
      };
      const saved = await f.app.handle(
        new Request(url, { method: 'PUT', headers, body: JSON.stringify(patch) }),
      );
      expect(saved.status).toBe(200);
      const savedData = await saved.json();
      expect(loadAgentSettings(root).computerUse.enabled).toBe(true);
      await f.app.handle(
        new Request('http://localhost/api/v1/computer-use/stop', { method: 'POST', headers }),
      );
      const stale = await f.app.handle(
        new Request(url, {
          method: 'PUT',
          headers,
          body: JSON.stringify({
            ...patch,
            computerUseRevision: savedData.data.computerUseRevision,
          }),
        }),
      );
      expect(stale.status).toBe(409);
      expect(loadAgentSettings(root).computerUse.enabled).toBe(false);
      const noRevision = await f.app.handle(
        new Request(url, {
          method: 'PUT',
          headers,
          body: JSON.stringify({ computerUse: patch.computerUse }),
        }),
      );
      expect(noRevision.status).toBe(409);
    } finally {
      localAuth.revokeSession(auth.sessionId);
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('denies unauthenticated status, discovery and stop without touching native APIs', async () => {
    const f = fixture();
    for (const [path, method] of [
      ['status', 'GET'],
      ['apps', 'GET'],
      ['stop', 'POST'],
    ]) {
      const response = await f.app.handle(
        new Request(`http://localhost/api/v1/computer-use/${path}`, { method }),
      );
      expect(response.status).toBe(401);
    }
    expect(f.discoveries()).toBe(0);
    expect(f.statuses()).toBe(0);
  });
  it('status does not scan apps; explicit authenticated discovery works while agent control is disabled', async () => {
    const f = fixture();
    const root = mkdtempSync(join(tmpdir(), 'kory-computer-route-'));
    const auth = localAuth.createSession();
    const headers = { authorization: buildLocalBearerToken(auth), 'x-koryphaios-project': root };
    try {
      const status = await f.app.handle(
        new Request('http://localhost/api/v1/computer-use/status', { headers }),
      );
      expect(status.status).toBe(200);
      expect((await status.json()).data.enabled).toBe(false);
      expect(f.discoveries()).toBe(0);
      const apps = await f.app.handle(
        new Request('http://localhost/api/v1/computer-use/apps', { headers }),
      );
      expect(apps.status).toBe(200);
      expect((await apps.json()).data.targets[0].appId).toBe('host.editor');
      expect(f.discoveries()).toBe(1);
    } finally {
      localAuth.revokeSession(auth.sessionId);
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('stop persists disabled state for the selected project', async () => {
    const f = fixture();
    const root = mkdtempSync(join(tmpdir(), 'kory-computer-route-'));
    const auth = localAuth.createSession();
    try {
      const settings = loadAgentSettings(root);
      settings.computerUse.enabled = true;
      saveAgentSettings(root, settings);
      const response = await f.app.handle(
        new Request('http://localhost/api/v1/computer-use/stop', {
          method: 'POST',
          headers: { authorization: buildLocalBearerToken(auth), 'x-koryphaios-project': root },
        }),
      );
      expect(response.status).toBe(200);
      expect((await response.json()).data.enabled).toBe(false);
      expect(loadAgentSettings(root).computerUse.enabled).toBe(false);
    } finally {
      localAuth.revokeSession(auth.sessionId);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
