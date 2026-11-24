import { beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.NODE_ENV = 'test';
process.env.SESSION_TOKEN_SECRET =
  process.env.SESSION_TOKEN_SECRET ?? 'test_only_not_for_production_aaaaaaaaaa';
const scratch = mkdtempSync(join(tmpdir(), 'kory-api-manifest-'));
process.env.DATABASE_URL = `sqlite://${join(scratch, 'manifest.sqlite')}`;

const { buildRouteManifest, toOpenApiPath, classifyAuth, pathParamNames } =
  await import('./manifest');
const { buildOpenApiDocument, operationIdFor } = await import('./openapi');
const { ROUTE_DOCS, RETIRED_OPERATION_DOCS } = await import('./route-docs');

let routes: Awaited<ReturnType<typeof buildRouteManifest>>;

beforeAll(async () => {
  routes = await buildRouteManifest();
});

describe('route manifest', () => {
  test('enumerates the full registered surface, uniquely and sorted', () => {
    expect(routes.length).toBeGreaterThan(300);
    const keys = routes.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
    const sorted = [...routes].sort((a, b) =>
      a.path === b.path
        ? a.method < b.method
          ? -1
          : a.method > b.method
            ? 1
            : 0
        : a.path < b.path
          ? -1
          : 1,
    );
    expect(routes.map((r) => r.key)).toEqual(sorted.map((r) => r.key));
  });

  test('paths are OpenAPI form with no trailing slash and params listed', () => {
    const detail = routes.find((r) => r.key === 'GET /api/sessions/{id}');
    expect(detail?.pathParams).toEqual(['id']);
    expect(routes.some((r) => r.path.endsWith('/') && r.path !== '/')).toBe(false);
    expect(routes.some((r) => /:[a-z]/i.test(r.path))).toBe(false);
  });

  test('every route is attributed to a plugin and classified', () => {
    for (const route of routes) {
      expect(route.plugin.length).toBeGreaterThan(0);
      expect(['local-bearer', 'bridge-grant', 'route-bearer', 'none']).toContain(route.auth);
    }
    expect(routes.find((r) => r.key === 'GET /api/sessions')?.auth).toBe('local-bearer');
    expect(routes.find((r) => r.key === 'GET /api/health')?.auth).toBe('none');
  });

  test('request schemas come from the runtime validators', () => {
    const critic = routes.find((r) => r.key === 'POST /api/agent/critic-review');
    expect(critic?.body?.['required']).toEqual(['code', 'filePath']);
  });

  test('operationIds are unique across the surface', () => {
    const ids = routes.map((r) => operationIdFor(r));
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('building the document succeeds and documents only real routes', () => {
    const doc = buildOpenApiDocument(routes) as { paths: Record<string, Record<string, unknown>> };
    const pathCount = Object.values(doc.paths).reduce((n, ops) => n + Object.keys(ops).length, 0);
    expect(pathCount).toBe(routes.length);
    for (const key of Object.keys(ROUTE_DOCS)) expect(routes.map((r) => r.key)).toContain(key);
  });

  test('retired operations are not published', () => {
    const published = new Set(routes.map((r) => r.key));
    for (const op of RETIRED_OPERATION_DOCS) {
      expect(published.has(`${op.method} ${toOpenApiPath(op.path)}`)).toBe(false);
    }
  });
});

describe('path and auth helpers', () => {
  test('toOpenApiPath converts params and drops trailing slashes', () => {
    expect(toOpenApiPath('/api/sessions/:id/feed')).toBe('/api/sessions/{id}/feed');
    expect(toOpenApiPath('/api/sessions/')).toBe('/api/sessions');
    expect(toOpenApiPath('/')).toBe('/');
  });

  test('pathParamNames reads OpenAPI params in order', () => {
    expect(pathParamNames('/a/{x}/b/{y}')).toEqual(['x', 'y']);
  });

  test('classifyAuth recognises each guard', () => {
    expect(classifyAuth('if (!requireLocalRouteAuth(request)) throw')).toBe('local-bearer');
    expect(classifyAuth('authenticateBridgeRoute(request, set, body, "mcp")')).toBe('bridge-grant');
    expect(classifyAuth("request.headers.get('authorization')")).toBe('route-bearer');
    expect(classifyAuth('() => ({ ok: true })')).toBe('none');
  });
});
