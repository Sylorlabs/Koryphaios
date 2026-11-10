# Legacy retirement and compatibility boundaries

Status: Milestone 0 inventory and migration policy

## Standard

Legacy code may remain only when it has an owner, a test, a migration purpose,
and a removal condition. Every path must be migrated, isolated behind a
compatibility boundary, or removed. Historical readers and protocol fallbacks
are not the same thing as active product surfaces.

## Immediate Team Access correction

The collaboration host now refuses to start without the configured relay in
`backend/src/collaboration/manager.ts`. The settings UI still has an old
fallback branch that displays a local six-character join code when
`activeCollab.relayEnabled` is false. That branch is misleading because the
active host contract is relay-backed.

The safe UI behavior is:

- when relay is ready, show invite links and the native join code;
- when relay is unavailable, show no join code and no copy action;
- explain that the user can configure the relay, use Linked Devices, or keep a
  local-only workspace;
- preserve historical collaboration rows and schema columns for compatibility.

This is a presentation fix. It must not merge collaboration authorization with
linked-device authorization.

## Current legacy inventory

| Area          | Current evidence                                                       | Boundary/action                                                 |
| ------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------- |
| Team Access   | `SettingsDrawer.svelte` renders a local-code fallback                  | Remove the code display; retain relay-backed flow               |
| Git routes    | `routes/v1/git.ts` and `server/handlers/git.ts` overlap                | Make chat Git service/v1 authority; adapt old route temporarily |
| Settings      | Canonical and legacy critic/permission fields coexist                  | Read/map old fields, write canonical fields only                |
| Saved objects | Filesystem projects and imported briefs share recent-item concepts     | Separate references before identity authority is added          |
| Connections   | Devices, chats, model sharing, and instances are adjacent but distinct | Unify information architecture, not authorization               |
| Protocols     | MCP and historical credential/session readers remain needed            | Keep with explicit compatibility tests and expiry conditions    |

## Canonical settings policy

Canonical fields are `criticMode`, `interactionMode`, `permissionMode`, and
`agentExecutionMode`. Legacy fields such as `enableCritic`,
`criticGateEnabled`, and the old plan permission value may be read and mapped
deterministically for one compatibility release. New writes must use canonical
fields only. Static guards should prevent reintroduction.

## Git migration policy

1. Measure active callers of old routes.
2. Complete missing chat-scoped operations in `chat-git-service.ts`.
3. Migrate frontend callers to canonical routes.
4. Make old handlers thin adapters with deprecation headers and telemetry.
5. Remove unreachable handlers after the compatibility window.

Initial revision-selection endpoints remain until all callers are proven to use
the replacement path.

## Verification requirements

Add focused checks for:

- no-relay Team Access rendering;
- legacy settings read/migration and canonical-only writes;
- old Git route response compatibility and deprecation headers;
- imported briefs never becoming filesystem project authority;
- static guards for deprecated settings writes and legacy frontend routes.

Do not delete old database columns or historical rows until supported client
versions and migration behavior have been measured.
