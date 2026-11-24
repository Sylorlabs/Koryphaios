# API contract

The backend's HTTP surface is described by two generated artifacts, both produced from the
running route table rather than written by hand:

| Artifact                             | What it is                                                        | Who uses it                                              |
| ------------------------------------ | ----------------------------------------------------------------- | -------------------------------------------------------- |
| `openapi.json` (repo root)           | OpenAPI 3.1 document for every registered route                   | Docs, codegen in any language, third-party tooling       |
| `shared/src/api/generated-client.ts` | Typed, fetch-based TypeScript client with no runtime dependencies | The frontend, the mobile app, CLIs written in TypeScript |

The WebSocket protocol is not in OpenAPI. Its event names and payload types are documented in
[WebSocket events](#websocket-events) below and in `shared/src/websocket/`.

## Regenerating

```sh
bun run api:generate   # rewrite openapi.json and shared/src/api/generated-client.ts
bun run api:check      # fail if the committed files differ from a fresh render
```

`api:check` runs in CI as part of the lint job, next to the format check. Any change to a route,
its validators, or `backend/src/validation/api-responses.ts` must be followed by `api:generate`
and a commit of both generated files. The generator never touches `./data`: it points the process
at a throwaway SQLite file before importing the route modules.

## Where the contract comes from

- **Routes:** `backend/src/api-contract/route-plugins.ts` lists the same Elysia plugins that
  `backend/src/server.ts` mounts, in the same order. `route-plugins.test.ts` fails if the two lists
  drift, so a route added to the server cannot be missing from the contract.
- **Request schemas** (params, query, body): the TypeBox schemas each route already validates
  with at runtime. They are JSON Schema, so the contract cannot disagree with the server.
- **Response schemas:** Elysia does not declare response schemas on these routes, so responses are
  `unknown` unless listed in `backend/src/validation/api-responses.ts` (zod). Those are the routes
  the mobile client uses most; see [Typed responses](#typed-responses).
- **Authentication:** each route's guard is read from its source. `local-bearer` means
  `requireLocalRouteAuth` (the local session token); `bridge-grant` means a signed MCP bridge grant
  or the local token; `route-bearer` means the handler reads `Authorization` itself; `none` means
  public. The value is exported as `x-koryphaios-auth` on each operation.
- **Prose:** summaries and descriptions live in `backend/src/api-contract/route-docs.ts`. Each key
  must name a registered route, so renamed routes fail the check instead of leaving stale text.

## Consuming the contract

### Base URL and auth

- Default origin: `http://localhost:3001`. Pass the origin you are talking to as `baseUrl`.
- Most routes require `Authorization: Bearer <token>`, where the token is the local session token.
  Requests without it receive `401`.
- Responses are JSON with an envelope: `{ "ok": true, "data": ... }` on success and
  `{ "ok": false, "error": ... }` on failure. Error `error` is either a message string or
  `{ name, message, details? }`. The generated client returns the full body, envelope included.

### Generated TypeScript client

```ts
import { createKoryApiClient, KoryApiError } from '@koryphaios/shared/src/api/generated-client';

const api = createKoryApiClient({
  baseUrl: 'http://localhost:3001',
  getAuthToken: () => localStorage.getItem('kory-token'), // or a value from your secret store
});

// Typed: params, query and body are checked, and the response is typed where a schema exists.
const appearance = await api.request('GET /api/appearance');

// Operations with required input take it as the second argument.
await api.request('PATCH /api/sessions/{id}', {
  params: { id: sessionId },
  body: { title: 'Plan' },
});

try {
  await api.request('GET /api/sessions/{id}', { params: { id: 'missing' } });
} catch (error) {
  if (error instanceof KoryApiError) console.error(error.status, error.body);
}
```

Keys are `METHOD /openapi/path` exactly as they appear in `openapi.json`. An operation that
takes no input (`input: undefined` in the generated types) is called with the key alone.
Operations with only optional query or body parameters accept an omitted input.

The client takes an injectable `fetch`, so tests and non-browser runtimes can supply their own.

### Other languages and third-party clients

Generate from `openapi.json` with any OpenAPI 3.1 tool. Two things are not visible to a generic
generator and must be handled by hand:

1. **The envelope.** Every success body is `{ ok, data }` (except the few routes that return a
   bare object, such as `/api/health`). Unwrap `data` yourself.
2. **Responses without a schema.** Only the routes in [Typed responses](#typed-responses) carry a
   response schema. Other operations declare an unconstrained response. Treat their bodies as
   untrusted and validate at the boundary you depend on.

### Mobile app

`koryphaios-mobile` keeps a hand-written client in `src/control/remoteClient.ts`. It is not updated
by this change. The intended migration is to replace the request methods with
`createKoryApiClient` and keep only the mobile-specific transport (connection, reconnection).
The contract's typed responses cover the endpoints that client calls most.

## Typed responses

The 20 routes the mobile client calls most often have zod response schemas, which type the
generated client results and the OpenAPI response schemas:

`GET /api/health`, `GET /api/appearance`, `PUT /api/appearance`, `GET /api/sessions`,
`POST /api/sessions`, `PATCH /api/sessions/{id}`, `DELETE /api/sessions/{id}`,
`GET /api/agent/settings`, `PUT /api/agent/settings`, `GET /api/v1/mcp-servers`,
`POST /api/v1/mcp-servers`, `GET /api/memory/sessions/{id}`, `GET /api/workspace/state`,
`GET /api/providers/status`, `GET /api/memory/settings`, `GET /api/notes/settings`,
`GET /api/voice/settings`, `GET /api/desktop-ui`, `GET /api/memory/universal`, `GET /api/goals`.

Precision: the envelope and the fields clients read are typed exactly. Domain payloads whose full
shape lives in a service module are `looseObject`, so unknown fields pass through and are typed as
present-but-unspecified. `route-responses.test.ts` validates the health response against the live
handler; extend that test when adding a schema.

## Coverage

|                                       | Count |
| ------------------------------------- | ----- |
| Registered operations                 | 396   |
| Paths                                 | 331   |
| Operations with a request body schema | 152   |
| Operations with a response schema     | 20    |

The authoritative numbers come from `openapi.json`.

## Migration from the hand-written `openapi.yaml`

The old file documented 11 operations on paths that existed, 9 schemas and 10 operations on the
`/api/v1/keys`, `/api/v1/audit` and `/api/v1/credentials` paths that the backend does not register,
and some shared components. The file was also malformed: its second `components:` block silently
replaced the first, and the `/api/v1/*` operations were nested under `components.schemas`.

What moved:

- **The 9 documented operations that exist** keep their summaries and descriptions in `route-docs.ts`.
  Their paths are unchanged. `GET /api/sessions` is now `/api/sessions` (the trailing slash the
  framework used internally is dropped; the server serves both forms).
- **The 12 operations for routes that do not exist** (`/api/agents/status`, `/api/agents/cancel`,
  the `/api/v1/keys*`, `/api/v1/audit*` and `/api/v1/credentials/*` operations) are not published.
  Their prose is kept in `RETIRED_OPERATION_DOCS` in `route-docs.ts`, with the reason each is not
  implemented, so the text is not lost. Implementing one means moving its entry to `ROUTE_DOCS`.
- **The `Session`, `ProviderStatus` and `AgentStatus` schemas** were hand-written approximations.
  The actual shapes are now derived from the routes. Where a precise shape is needed, see
  [Typed responses](#typed-responses).
- **`CredentialMetadata`, `ApiKeyMetadata` and the shared `responses` block** described endpoints
  that do not exist. They are superseded by the generated error envelope (`ErrorEnvelope`).
- **Auth:** the old `BearerAuth` JWT description is replaced by the local session token, which is
  what the backend actually validates (`KORYPHAIOS_AUTH_MODE=token` JWT mode is not in the route
  code).

## WebSocket events

WebSocket messages use the `WSMessage` envelope from `shared/src/websocket/WSEvents.ts`:

```ts
interface WSMessage<T> {
  type: WSEventType; // event name, listed below
  payload: T; // see the payload column
  timestamp: number;
  sessionId?: string; // required for session-scoped events (SESSION_SCOPED_EVENT_TYPES)
  agentId?: string;
  eventId?: string; // durable per-session ordering metadata
  epoch?: number;
  sequence?: number;
  parentSequence?: number;
  replayed?: boolean; // true when the server replays a persisted event
}
```

Session-scoped events without a `sessionId` are dropped by both the server and the frontend. The
payload types are defined in `shared/src/websocket/WSPayloads.ts`. `shared/src/websocket/WSEventPayloads.ts`
maps each event name to its payload type, and the compiler checks that every event is present.
Events marked `unknown` do not yet have a named payload type. Their shape is defined by the
emitting code, not the contract.

| Event                              | Payload                             |
| ---------------------------------- | ----------------------------------- |
| `device.event`                     | `unknown`                           |
| `agent.spawned`                    | `AgentSpawnedPayload`               |
| `agent.status`                     | `AgentStatusPayload`                |
| `agent.completed`                  | `unknown`                           |
| `agent.error`                      | `unknown`                           |
| `agent.thread_message`             | `AgentThreadMessagePayload`         |
| `agent.updated`                    | `AgentUpdatedPayload`               |
| `agent.message`                    | `AgentMessageEventPayload`          |
| `agent.steering_queue`             | `AgentSteeringQueuePayload`         |
| `agent.heartbeat`                  | `AgentHeartbeatPayload`             |
| `stream.delta`                     | `StreamDeltaPayload`                |
| `stream.thinking`                  | `ThinkingPayload`                   |
| `stream.tool_call`                 | `ToolCallPayload`                   |
| `stream.tool_result`               | `StreamToolResultPayload`           |
| `stream.usage`                     | `StreamUsagePayload`                |
| `stream.complete`                  | `StreamCompletePayload`             |
| `stream.clear_content`             | `StreamClearContentPayload`         |
| `stream.file_delta`                | `StreamFileDeltaPayload`            |
| `stream.file_complete`             | `StreamFileCompletePayload`         |
| `context.detected`                 | `ContextDetectedPayload`            |
| `session.created`                  | `SessionCreatedPayload`             |
| `session.updated`                  | `SessionUpdatedPayload`             |
| `session.deleted`                  | `unknown`                           |
| `session.changes`                  | `KorySessionChangesPayload`         |
| `session.changes_resolved`         | `KorySessionChangesResolvedPayload` |
| `session.accept_changes`           | `unknown`                           |
| `session.user_message`             | `unknown`                           |
| `session.idle`                     | `SessionIdlePayload`                |
| `session.actionable_waits`         | `SessionActionableWaitsPayload`     |
| `session.actionable_waits.request` | `unknown`                           |
| `session.timeline_rewritten`       | `SessionTimelineRewrittenPayload`   |
| `session.replay_skipped`           | `unknown`                           |
| `session.history_pruned`           | `SessionHistoryPrunedPayload`       |
| `run.state`                        | `SessionRunStatePayload`            |
| `turn.provider_completed`          | `TurnProviderCompletedPayload`      |
| `run.settled`                      | `RunSettledPayload`                 |
| `compaction.started`               | `unknown`                           |
| `compaction.progress`              | `CompactionProgressPayload`         |
| `compaction.completed`             | `unknown`                           |
| `compaction.failed`                | `unknown`                           |
| `permission.request`               | `unknown`                           |
| `permission.response`              | `unknown`                           |
| `provider.status`                  | `ProviderStatusPayload`             |
| `provider.rate_limit`              | `RateLimitPayload`                  |
| `system.error`                     | `ErrorPayload`                      |
| `system.notification`              | `NotificationPayload`               |
| `system.info`                      | `unknown`                           |
| `system.config_updated`            | `unknown`                           |
| `process.status`                   | `unknown`                           |
| `process.started`                  | `unknown`                           |
| `process.exited`                   | `unknown`                           |
| `kory.thought`                     | `KoryThoughtPayload`                |
| `kory.routing`                     | `KoryRoutingPayload`                |
| `kory.skill`                       | `KorySkillPayload`                  |
| `kory.verification`                | `KoryVerificationPayload`           |
| `kory.task_breakdown`              | `KoryTaskBreakdownPayload`          |
| `kory.ask_user`                    | `KoryAskUserPayload`                |
| `kory.ask_user_resolved`           | `KoryAskUserResolvedPayload`        |
| `notes.updated`                    | `unknown`                           |
| `workspace.updated`                | `unknown`                           |
| `desktop.ui.updated`               | `unknown`                           |
| `goals.updated`                    | `unknown`                           |
| `checklists.updated`               | `unknown`                           |
| `native.command`                   | `NativeCommandPayload`              |

Remote-protocol envelopes (`RemoteOperationEnvelope`, `RemoteReplayRequest`) are separate from
these events and are defined in the same file.

## Not in this contract

- **MCP endpoints** (`/mcp` and the bridge's stdio servers) follow the MCP specification, not this
  REST contract.
- **Static frontend assets** and the `/api/v1/mcp-bridge` hook endpoints are registered as routes
  and appear in `openapi.json`, but the hook endpoints are internal to CLI integrations.
