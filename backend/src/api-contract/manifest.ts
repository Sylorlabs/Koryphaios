// Route manifest: enumerates every route the real Elysia app registers.
//
// The source of truth is the Elysia application built from `API_ROUTE_PLUGINS`
// (the same plugins `server.ts` mounts). Each route carries the schemas Elysia
// already enforces at runtime (params / query / body / response hooks, which
// are TypeBox objects and therefore JSON Schema), plus an optional zod response
// schema from `validation/api-responses.ts`.

import { loadApiRoutePlugins } from './route-plugins';
import { API_RESPONSE_SCHEMAS } from '../validation/api-responses';
import { z } from 'zod';

export const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
export type HttpMethod = Uppercase<(typeof HTTP_METHODS)[number]>;

/**
 * How a route authenticates the caller, read from the route's own guard source:
 * - `local-bearer`: `requireLocalRouteAuth` (the local session bearer token).
 * - `bridge-grant`: `authenticateBridgeRoute`, a signed bridge grant or the local bearer.
 * - `route-bearer`: the handler reads the `Authorization` header itself.
 * - `none`: no guard detected. Only public routes should end up here.
 */
export type AuthRequirement = 'local-bearer' | 'bridge-grant' | 'route-bearer' | 'none';

export type JsonSchema = Record<string, unknown>;

export interface ManifestRoute {
  /** `METHOD /openapi/path`, e.g. `GET /api/sessions/{id}`. The stable identity of a route. */
  readonly key: string;
  readonly method: HttpMethod;
  /** Path in OpenAPI form (`{param}`). */
  readonly path: string;
  /** Path parameter names, in path order. */
  readonly pathParams: readonly string[];
  readonly auth: AuthRequirement;
  /** The plugin (`server.ts` `.use` name) that registered the route. */
  readonly plugin: string;
  readonly params?: JsonSchema;
  readonly query?: JsonSchema;
  readonly body?: JsonSchema;
  readonly response?: JsonSchema;
  /** Where `response` came from, when present. */
  readonly responseSource?: 'zod' | 'elysia';
}

interface ElysiaHookSet {
  beforeHandle?: Array<{ fn?: unknown } | unknown>;
  params?: unknown;
  query?: unknown;
  body?: unknown;
  response?: unknown;
}

interface ElysiaRouteLike {
  method: string;
  path: string;
  handler: unknown;
  hooks: ElysiaHookSet;
}

const METHOD_SET = new Set<string>(HTTP_METHODS.map((m) => m.toUpperCase()));

/**
 * Elysia path to OpenAPI path. `:name` becomes `{name}`. A trailing slash is
 * dropped: Elysia runs with `strictPath: false`, so `/api/sessions/` and
 * `/api/sessions` reach the same handler and the contract names it once.
 */
export function toOpenApiPath(elysiaPath: string): string {
  const withParams = elysiaPath.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '{$1}');
  return withParams.length > 1 ? withParams.replace(/\/+$/, '') : withParams;
}

export function pathParamNames(openApiPath: string): string[] {
  return [...openApiPath.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!);
}

/** JSON-clone a TypeBox/zod schema into plain JSON Schema (drops TypeBox symbol keys). */
export function plainSchema(value: unknown): JsonSchema | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  if (Object.keys(value as object).length === 0) return undefined;
  const cloned = JSON.parse(JSON.stringify(value)) as JsonSchema;
  if (Object.keys(cloned).length === 0) return undefined;
  delete cloned['$schema'];
  return cloned;
}

export function zodToJsonSchema(schema: z.ZodType): JsonSchema {
  const json = z.toJSONSchema(schema, { io: 'output', unrepresentable: 'any' }) as JsonSchema;
  delete json['$schema'];
  return json;
}

function guardSource(route: ElysiaRouteLike): string {
  const hooks = (route.hooks.beforeHandle ?? []).map((h) =>
    typeof h === 'function' ? h.toString() : String((h as { fn?: unknown })?.fn ?? ''),
  );
  return [...hooks, String(route.handler)].join('\n');
}

export function classifyAuth(source: string): AuthRequirement {
  if (/authenticateBridgeRoute\(/.test(source)) return 'bridge-grant';
  if (/requireLocalRouteAuth\(/.test(source)) return 'local-bearer';
  if (/headers\.get\(\s*['"]authorization['"]\s*\)/i.test(source)) return 'route-bearer';
  return 'none';
}

/**
 * Builds the manifest from a fresh Elysia app. Callers must set up the process
 * environment (test database, secrets) before calling, because importing the
 * route modules opens the database module.
 */
export async function buildRouteManifest(
  responseSchemas: Record<string, z.ZodType> = API_RESPONSE_SCHEMAS,
): Promise<ManifestRoute[]> {
  const { Elysia } = await import('elysia');
  const plugins = await loadApiRoutePlugins();
  // Each plugin is mounted on its own so a route can be attributed to it.
  const routes: Array<ElysiaRouteLike & { plugin: string }> = [];
  for (const { name, plugin } of plugins) {
    const mounted = new Elysia().use(plugin as never) as unknown as { routes: ElysiaRouteLike[] };
    for (const route of mounted.routes) routes.push({ ...route, plugin: name });
  }

  const manifest: ManifestRoute[] = [];
  const seen = new Set<string>();
  for (const route of routes) {
    const method = route.method.toUpperCase();
    if (!METHOD_SET.has(method)) continue;
    const openApiPath = toOpenApiPath(route.path);
    const key = `${method} ${openApiPath}`;
    if (seen.has(key)) throw new Error(`Duplicate route in manifest: ${key} (${route.plugin})`);
    seen.add(key);

    const zodSchema = responseSchemas[key];
    const elysiaResponse = plainSchema(route.hooks.response);
    const response = zodSchema ? zodToJsonSchema(zodSchema) : elysiaResponse;
    manifest.push({
      key,
      method: method as HttpMethod,
      path: openApiPath,
      pathParams: pathParamNames(openApiPath),
      auth: classifyAuth(guardSource(route)),
      plugin: route.plugin,
      params: plainSchema(route.hooks.params),
      query: plainSchema(route.hooks.query),
      body: plainSchema(route.hooks.body),
      ...(response ? { response } : {}),
      ...(response ? { responseSource: zodSchema ? 'zod' : 'elysia' } : {}),
    });
  }

  return manifest.sort((a, b) =>
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
}
