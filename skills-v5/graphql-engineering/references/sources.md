# Source map

This map anchors portable GraphQL decisions in the September 2025 specification. Resolver batching, federation, transport, and cost controls remain implementation concerns. Verify their exact behavior in the selected server stack.

## Qualification and evidence boundary

This package is individually authored. Package checks establish structure, source provenance, routing behavior, local links, and bounded evaluator controls. They do not create paired same model task results, independent blind judgments, production traffic measurements, or promotion credit. Keep those claims separate until the current revision has the required evidence.

The skill hierarchy is `api-contract-design` as the broader contract owner. `grpc-protobuf` owns protobuf wire compatibility. `http-rest-engineering` owns HTTP behavior when GraphQL execution is not material. `backend-engineering` owns backend architecture independent of GraphQL. `authorization-security` owns authorization policy, while this skill owns GraphQL enforcement paths and their execution evidence. `verification` owns evidence review when the task only verifies an already defined implementation.

## Adopted principles

- Nullability is executable schema semantics. A field error can propagate null through a non null boundary, so nullability changes affect clients and failure behavior.
- Input and output nullability have different compatibility effects. A required input without a default can reject a previously valid request. A weaker output guarantee changes successful response values. Review list containers and list items separately.
- The specification defines a breaking change as one that can make a previously valid request invalid. Deprecation is the built in signal for schema elements intended for retirement.
- Enum input accepts enum values, not string literals. Enum additions and removals still need client compatibility review because generated clients can model enums exhaustively.
- Validation and execution are distinct phases. A schema valid document can still produce field errors during execution.
- Execution errors retain partial data when nullable boundaries allow it. Preserve response paths and safe stable error codes, and keep internal causes out of caller visible messages.
- GraphQL over HTTP adds request and response media types and transport rules. It does not replace GraphQL validation or execution semantics. A transport response with partial execution data is still a GraphQL result that callers must inspect.

## Conditional or non adopted recipes

- DataLoader style batching, persisted queries, federation, cursor pagination, depth limits, alias limits, list limits, rate limits, and cost analyzers are stack specific recipes, not GraphQL specification requirements.
- Cursor pagination is useful when stable continuation is required, but no specific Relay shape is mandated unless the existing API already adopts it.
- Authorization architecture is not defined by the GraphQL specification. Enforce the repository's policy at the data, action, edge, node, field, and mutation boundaries that actually execute.
- OWASP guidance supports resource limits, access checks at edges and nodes, batching attack controls, and safe production errors. It does not supply universal numeric limits or authorize disabling introspection for every public service.

## Verification scope

Verify schema compatibility, validation, variable coercion, execution errors, null propagation, pagination stability, resolver fan out, authorization paths, query limits, and response error exposure in the actual server implementation. The specifications establish protocol and execution semantics. They do not prove server specific batching, cost, authorization, cache scope, subgraph behavior, client parsing, or production performance.

For a performance claim, retain the workload shape, item count, distinct keys, batch sizes, backend calls, cache hits, latency sample count, and measurement window. A depth check, delayed mock, schema diff, or one successful unit test cannot prove production safety or improvement.

## Maintained sources

- **GraphQL specification root:** https://spec.graphql.org/
  - Scope: current specification navigation as available 2026-09-04.
  - Use: primary entry point for language, type system, validation, execution, introspection, and response semantics.
  - Verified: 2026-09-04; refresh after 90 days.
- **GraphQL Specification, September 2025:** https://spec.graphql.org/September2025/
  - Scope: September 2025 edition.
  - Use: input and output types, non null and required arguments, enum input, deprecation, validation, execution, null propagation, and response errors.
  - Verified: 2026-09-06; refresh after 90 days.
- **GraphQL over HTTP:** https://graphql.github.io/graphql-over-http/draft/
  - Scope: current working draft inspected 2026-10-17.
  - Use: HTTP request shape, media types, validation and execution boundaries, partial responses, status guidance, and transport security considerations.
  - Verified: 2026-10-17; refresh after 30 days.
- **OWASP GraphQL Cheat Sheet:** https://cheatsheetseries.owasp.org/cheatsheets/GraphQL_Cheat_Sheet.html
  - Scope: current cheat sheet inspected 2026-10-17.
  - Use: input validation, query resource limits, access control at edges and nodes, batching attack controls, introspection decisions, and error exposure.
  - Verified: 2026-10-17; refresh after 120 days.
- **GraphQL DataLoader reference implementation:** https://github.com/graphql/dataloader
  - Scope: main branch README inspected 2026-10-17.
  - Use: request local cache lifetime, event loop batch scheduling, key order alignment, per key errors, overlapping loads, and explicit cache clearing.
  - Verified: 2026-10-17; refresh after 90 days.

## Interpretation rules

- Prefer the official specification or protocol source over community conventions when they conflict.
- Resolve the installed server, executor, transport, federation, and loader versions before applying details that can drift.
- Treat examples as examples, not proof that the current repository or runtime behaves the same way.
- Preserve source conflicts and unknowns explicitly. Do not merge incompatible guidance into a false universal rule.
- Keep operational checks in the real target environment whenever the claim depends on a database, remote subgraph, HTTP intermediary, client runtime, or production traffic.
