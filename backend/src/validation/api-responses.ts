// Response schemas for the routes the mobile client calls most often.
//
// Keyed by manifest key (`METHOD /openapi/path`). The generator turns each
// schema into OpenAPI `responses.200` and a typed client result. Routes not
// listed here keep an `unknown` response until a schema is added.
//
// Levels of precision: the envelope (`ok`, `data`) and the fields the mobile
// client reads are typed exactly. Service payloads whose full shape lives in a
// domain module are `z.looseObject`, so the contract types what clients depend
// on and passes everything else through unchanged. `route-responses.test.ts`
// checks a subset of these against the live handlers.

import { z } from 'zod';

const okEnvelope = <T extends z.ZodType>(data: T) => z.object({ ok: z.literal(true), data });

const Session = z.looseObject({
  id: z.string(),
  title: z.string().optional(),
  createdAt: z.number().optional(),
  updatedAt: z.number().optional(),
});

const Health = z.object({
  id: z.string(),
  version: z.string(),
  uptime: z.number(),
  pid: z.number(),
  compat: z.object({
    minFrontend: z.string(),
    currentFrontend: z.string(),
    bundleHash: z.string().nullable(),
    bundleHashEnforced: z.boolean(),
    serverStartedAt: z.number(),
  }),
});

const AgentSettings = z.looseObject({
  computerUseRevision: z.string().optional(),
});

export const API_RESPONSE_SCHEMAS: Record<string, z.ZodType> = {
  'GET /api/health': z.object({ ok: z.literal(true), data: Health }),
  'GET /api/appearance': okEnvelope(z.looseObject({})),
  'PUT /api/appearance': okEnvelope(z.looseObject({})),
  'GET /api/sessions': z.object({
    ok: z.literal(true),
    data: z.array(Session),
    runStates: z.array(z.unknown()),
  }),
  'POST /api/sessions': okEnvelope(Session),
  'PATCH /api/sessions/{id}': z.object({ ok: z.literal(true), operationId: z.string() }),
  'DELETE /api/sessions/{id}': z.looseObject({ ok: z.literal(true) }),
  'GET /api/agent/settings': okEnvelope(AgentSettings),
  'PUT /api/agent/settings': okEnvelope(AgentSettings),
  'GET /api/v1/mcp-servers': okEnvelope(z.array(z.looseObject({ name: z.string() }))),
  'POST /api/v1/mcp-servers': okEnvelope(z.looseObject({ name: z.string() })),
  'GET /api/memory/sessions/{id}': okEnvelope(z.looseObject({ path: z.string() })),
  'GET /api/workspace/state': okEnvelope(z.looseObject({})),
  'GET /api/providers/status': okEnvelope(z.array(z.looseObject({ name: z.string() }))),
  'GET /api/memory/settings': okEnvelope(z.looseObject({})),
  'GET /api/notes/settings': okEnvelope(z.looseObject({})),
  'GET /api/voice/settings': okEnvelope(z.looseObject({})),
  'GET /api/desktop-ui': okEnvelope(z.looseObject({})),
  'GET /api/memory/universal': okEnvelope(z.looseObject({ path: z.string() })),
  'GET /api/goals': okEnvelope(z.array(z.looseObject({ id: z.string() }))),
};
