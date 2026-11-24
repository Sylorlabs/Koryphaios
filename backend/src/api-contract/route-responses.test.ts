import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.NODE_ENV = 'test';
process.env.SESSION_TOKEN_SECRET =
  process.env.SESSION_TOKEN_SECRET ?? 'test_only_not_for_production_aaaaaaaaaa';
process.env.DATABASE_URL ??= `sqlite://${join(mkdtempSync(join(tmpdir(), 'kory-api-responses-')), 'r.sqlite')}`;

const { API_RESPONSE_SCHEMAS } = await import('../validation/api-responses');
const { buildRouteManifest } = await import('./manifest');
const { Elysia } = await import('elysia');
const { systemRoutes } = await import('../routes/v1/system');

describe('typed response schemas', () => {
  test('every schema names a route the manifest registers', async () => {
    const keys = new Set((await buildRouteManifest()).map((r) => r.key));
    for (const key of Object.keys(API_RESPONSE_SCHEMAS)) expect(keys.has(key)).toBe(true);
  }, 60_000);

  test('the health response matches the live handler', async () => {
    const app = new Elysia().use(systemRoutes);
    const response = await app.handle(new Request('http://localhost/api/health'));
    expect(response.status).toBe(200);
    const parsed = API_RESPONSE_SCHEMAS['GET /api/health']!.safeParse(await response.json());
    expect(parsed.success).toBe(true);
  });
});
