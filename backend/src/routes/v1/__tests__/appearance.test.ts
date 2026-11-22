import { beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll } from 'bun:test';

process.env.NODE_ENV = 'test';
process.env.SESSION_TOKEN_SECRET =
  process.env.SESSION_TOKEN_SECRET ?? 'test_only_not_for_production_aaaaaaaaaa';
const appearanceDir = mkdtempSync(join(tmpdir(), 'kory-appearance-route-'));
process.env.KORYPHAIOS_APPEARANCE_SETTINGS_PATH = join(appearanceDir, 'appearance.json');

const { appearanceRoutes } = await import('../appearance');
const { localAuth } = await import('../../../auth/local-auth');
const { buildLocalBearerToken } = await import('../../../auth/local-route-auth');

function authHeader(): Record<string, string> {
  return {
    Authorization: buildLocalBearerToken(localAuth.createSession(['*'])),
  };
}

async function request(
  path: string,
  init: RequestInit = {},
): Promise<{ response: Response; body: any }> {
  const response = await appearanceRoutes.handle(
    new Request(`http://localhost${path}`, {
      ...init,
      headers: { ...authHeader(), ...(init.headers ?? {}) },
    }),
  );
  const text = await response.text();
  return { response, body: text.trim() ? JSON.parse(text) : null };
}

const v2Body = {
  version: 2,
  mode: 'system',
  font: 'inter',
  dark: { preset: 'kintsugi', accent: 'gold', secondaryAccent: 'gold' },
  light: { preset: 'kintsugi-light', accent: 'gold', secondaryAccent: 'gold' },
};

afterAll(() => {
  rmSync(appearanceDir, { recursive: true, force: true });
});

describe('appearance routes', () => {
  test('v2 body round-trips through GET', async () => {
    const put = await request('/api/appearance', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(v2Body),
    });
    expect(put.response.status).toBe(200);
    expect(put.body.ok).toBe(true);
    expect(put.body.data.mode).toBe('system');
    expect(put.body.data.light.preset).toBe('kintsugi-light');
    expect(put.body.data.light.accent).toBe('gold');

    const get = await request('/api/appearance');
    expect(get.response.status).toBe(200);
    expect(get.body.data.version).toBe(2);
    expect(get.body.data.mode).toBe('system');
    expect(get.body.data.dark.preset).toBe('kintsugi');
  });

  test('a light preset id like rose-pine-dawn is accepted', async () => {
    const put = await request('/api/appearance', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...v2Body,
        light: { preset: 'rose-pine-dawn', accent: 'rose', secondaryAccent: 'violet' },
      }),
    });
    expect(put.response.status).toBe(200);
    expect(put.body.data.light.preset).toBe('rose-pine-dawn');
  });

  test('legacy v1 body is still accepted', async () => {
    const put = await request('/api/appearance', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        preset: 'system',
        accent: 'gold',
        secondaryAccent: 'cyan',
        font: 'inter',
      }),
    });
    expect(put.response.status).toBe(200);
    expect(put.body.ok).toBe(true);
    expect(put.body.data.preset).toBe('system');
  });

  test('an invalid mode is rejected', async () => {
    const put = await request('/api/appearance', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...v2Body, mode: 'sometimes' }),
    });
    expect(put.response.status).toBeGreaterThanOrEqual(400);
    expect(put.response.status).toBeLessThan(500);
  });
});
