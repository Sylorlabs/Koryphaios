// OpenAPI 3.1 document built from the route manifest plus the prose in route-docs.ts.

import { VERSION } from '../constants';
import { ROUTE_DOCS, tagForPlugin } from './route-docs';
import type { ManifestRoute, JsonSchema } from './manifest';

export const API_TITLE = 'Koryphaios API';
export const API_DESCRIPTION = [
  'Koryphaios AI Autonomous Workspace API.',
  '',
  'Koryphaios runs locally and does not manage user accounts. Routes that act on the workspace require the local session bearer token:',
  '',
  '```',
  'Authorization: Bearer <token>',
  '```',
  '',
  'Responses use the envelope `{ "ok": true, "data": ... }` on success and `{ "ok": false, "error": { ... } }` on failure unless the route documents otherwise.',
  '',
  'This document is generated from the running route table. Do not edit `openapi.json` by hand; run `bun run api:generate`.',
].join('\n');
export const API_SERVERS = [
  { url: 'http://localhost:3001', description: 'Local development server' },
];

export type OpenApiDocument = Record<string, unknown>;

/** Stable operationId from a manifest key: `GET /api/sessions/{id}` -> `getApiSessionsById`. */
export function operationIdFor(route: Pick<ManifestRoute, 'method' | 'path'>): string {
  const parts = route.path
    .split('/')
    .filter(Boolean)
    .map((segment) => {
      const param = /^\{(.+)\}$/.exec(segment);
      if (param) return `By${pascal(param[1]!)}`;
      return pascal(segment);
    });
  const method = route.method.toLowerCase();
  return method + parts.join('');
}

function pascal(text: string): string {
  return text
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
}

function propertyNames(schema: JsonSchema | undefined): string[] {
  const props = schema?.['properties'];
  return props && typeof props === 'object' ? Object.keys(props as object) : [];
}

function requiredNames(schema: JsonSchema | undefined): string[] {
  const req = schema?.['required'];
  return Array.isArray(req) ? (req as string[]) : [];
}

function parameterSchema(schema: JsonSchema | undefined, name: string): JsonSchema {
  const props = (schema?.['properties'] ?? {}) as Record<string, JsonSchema>;
  return props[name] ?? { type: 'string' };
}

export function buildOpenApiDocument(routes: readonly ManifestRoute[]): OpenApiDocument {
  const paths: Record<string, Record<string, unknown>> = {};
  const tagNames = new Set<string>();
  const knownKeys = new Set(routes.map((r) => r.key));

  for (const key of Object.keys(ROUTE_DOCS)) {
    if (!knownKeys.has(key)) {
      throw new Error(`route-docs.ts documents ${key}, which the route manifest does not register`);
    }
  }

  const operationIds = new Map<string, string>();
  for (const route of routes) {
    const doc = ROUTE_DOCS[route.key];
    const tag = doc?.tag ?? tagForPlugin(route.plugin);
    tagNames.add(tag);
    const operationId = operationIdFor(route);
    const previous = operationIds.get(operationId);
    if (previous)
      throw new Error(
        `operationId ${operationId} is produced by both ${previous} and ${route.key}`,
      );
    operationIds.set(operationId, route.key);

    const parameters: Record<string, unknown>[] = route.pathParams.map((name) => ({
      name,
      in: 'path',
      required: true,
      schema: parameterSchema(route.params, name),
    }));
    for (const name of propertyNames(route.query)) {
      parameters.push({
        name,
        in: 'query',
        required: requiredNames(route.query).includes(name),
        schema: parameterSchema(route.query, name),
      });
    }

    const operation: Record<string, unknown> = {
      operationId,
      tags: [tag],
      summary: doc?.summary ?? `${route.method} ${route.path}`,
      ...(doc?.description ? { description: doc.description } : {}),
      'x-koryphaios-auth': route.auth,
      ...(parameters.length ? { parameters } : {}),
    };

    if (route.body) {
      operation['requestBody'] = {
        required: requiredNames(route.body).length > 0,
        content: { 'application/json': { schema: route.body } },
      };
    }

    const success: Record<string, unknown> = { description: 'Successful response' };
    if (route.response) {
      success['content'] = { 'application/json': { schema: route.response } };
    }
    operation['responses'] = {
      '200': success,
      default: {
        description: 'Error response',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } } },
      },
    };

    if (
      route.auth === 'local-bearer' ||
      route.auth === 'bridge-grant' ||
      route.auth === 'route-bearer'
    ) {
      operation['security'] = [{ bearerAuth: [] }];
    } else {
      operation['security'] = [];
    }

    paths[route.path] ??= {};
    paths[route.path]![route.method.toLowerCase()] = operation;
  }

  const sortedTags = [...tagNames].sort();

  return {
    openapi: '3.1.0',
    info: {
      title: API_TITLE,
      version: VERSION,
      description: API_DESCRIPTION,
    },
    servers: API_SERVERS,
    tags: sortedTags.map((name) => ({ name })),
    paths,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: 'Local session bearer token (see docs/api-contract.md).',
        },
      },
      schemas: {
        ErrorEnvelope: {
          type: 'object',
          required: ['ok', 'error'],
          properties: {
            ok: { const: false },
            // Framework errors carry { name, message, details }; a few handlers
            // answer with a bare message string (e.g. 'Unauthorized').
            error: {
              anyOf: [
                { type: 'string' },
                {
                  type: 'object',
                  required: ['name', 'message'],
                  properties: {
                    name: { type: 'string' },
                    message: { type: 'string' },
                    details: {},
                  },
                },
              ],
            },
          },
        },
      },
    },
  };
}
