# Remote targets and capabilities

Status: Milestone 1 route and bridge admission contract

## Product contract

The UI should present one target model for local desktops, linked devices,
collaboration hosts, and remote instances. A target reports what it can do and
why an action is unavailable. The UI must never infer routing from a synthetic
session ID, URL prefix, or local-versus-remote guess.

Transport and authorization remain separate. A normalized target descriptor is
metadata and dispatch context; it does not replace encrypted device authority,
collaboration tiers, remote-instance policy, or MCP grants.

## Current inventory

| Surface         | Transport               | Existing authority                           | Current limitation                                                |
| --------------- | ----------------------- | -------------------------------------------- | ----------------------------------------------------------------- |
| Linked device   | Encrypted device RPC    | Device link/revocation and target dispatcher | Frontend projects target IDs into synthetic `linked-*` IDs        |
| Collaboration   | Relay                   | Host policy, role, and tier                  | Guest prompt approval is not a general tool-permission route      |
| Remote provider | Relay/provider protocol | Provider host policy and sandbox             | Inference target and tool execution target can differ             |
| Remote instance | Collaboration host      | Headless profile and broad execution         | Questions, approvals, cancellation, and reviews are not projected |
| MCP bridge      | Local HTTP/stdio bridge | Session role, grant, and ToolRegistry        | No general target identity in the bridge request                  |

## Response-routing finding

Linked-device questions and reviews already use target-side RPC operations. A
linked-device `permission.request`, however, is inserted into the controller's
normal pending-permission list and `respondToPermission()` sends the response
through the controller WebSocket. The synthetic target session is not a local
session, so the controller rejects the response instead of settling the target
approval queue.

This is a correctness bug, not an abstraction preference. The bounded fix is:

1. add a user-only target operation for permission responses;
2. include the target-native session ID and permission ID;
3. validate the option against the target approval queue;
4. route linked responses through device RPC;
5. keep the request pending in the controller until target success;
6. preserve local WebSocket behavior for local sessions.

## Target and capability direction

The first shared metadata seam now lives in `shared/src/remote-target.ts`.
It defines `ExecutionTarget`, the explicit capability state vocabulary,
`RemoteRouteDescriptor`, and operation/target lifecycle states. Target
workbench admission now consumes its method-aware route descriptors from both
the frontend and backend; provider, authentication, device-link, and
session-collection routes remain local-only. These types are descriptive
contracts only; existing linked-device, relay, and remote-instance authority
checks remain the enforcement layer.

The eventual shared contract should distinguish target identity from execution
authority:

```ts
type ExecutionTarget =
  | { kind: 'local'; backendId: string }
  | { kind: 'linked-device'; deviceId: string; sessionId: string }
  | { kind: 'remote-instance'; instanceId: string; sessionId: string }
  | { kind: 'collaboration'; collaborationId: string; tierId: string };
```

Capabilities should carry a state and reason, rather than only a boolean:
`available`, `unavailable`, `unsupported`, `offline`,
`permission_required`, `approval_required`, `not_configured`, `stale`,
`busy`, and `expired`.

Initial capability names should cover sessions, prompt submission, streaming,
cancellation, questions, approvals, reviews, workspace navigation, source
control, Notes, Memory, Goals, Checklists, Skills, processes, terminals,
providers, models, attachments, MCP, computer use, voice, images, video,
billing, and device administration.

## Protocol migration invariants

- target-native session IDs are transport data, not display labels;
- mutations retain one stable command ID across reconnects;
- a lost mutation response becomes `outcome_uncertain`, not a new mutation;
- pending questions, approvals, and reviews survive reconnect;
- stream gaps trigger an authoritative snapshot recovery;
- remote paths and credentials do not cross the target boundary unnecessarily;
- MCP target calls mint and revoke local grants on the target.

The current MCP bridge is explicitly local-target-only. Signed catalog and
execute requests carry `{ kind: 'local', backendId }`, and the receiving
backend rejects missing signed targets, linked-device targets, remote-instance
targets, collaboration targets, and a different backend ID. A target-side MCP
transport is required before any non-local target can be admitted.

## Phased implementation

1. Characterize and fix linked permission routing.
2. Introduce shared target/capability metadata without changing authority.
3. Replace route-prefix allowlists with descriptors consumed by each transport.
4. Add protocol v2 command IDs, operation IDs, cursors, replay, cancellation,
   and explicit uncertain outcomes.
5. Project feature capability state into desktop and mobile UI.
6. Replace remote-instance YOLO compensation after approvals and reviews exist.
