---
name: graphql-engineering
description: Engineer GraphQL schemas, resolvers, loaders, errors, authorization, pagination, federation, and evolution. Use when GraphQL types, execution, or resolver behavior are central to the live task.
---

# Graphql Engineering

Complete requested code and tests before optional analysis. If the task requests tests, changing code without changing an executable test file is incomplete. Before finishing, confirm those tests exercise the repaired behavior.

When tests are requested, treat the test diff as a required deliverable. Do not emit the final patch until at least one executable test file has been added or changed and those tests fail against the known broken behavior while passing the repair.

## Responsibility

Design schemas from durable domain semantics and client needs. Keep resolver ownership, batching, nullability, pagination, authorization, deprecation, and federation boundaries explicit. Authorize at data or action boundaries.

## Scope and routing

- Own GraphQL type and field contracts, validation and execution semantics, resolver mapping, request local loading, GraphQL error paths, schema evolution, and GraphQL specific query abuse controls.
- `api-contract-design` owns transport neutral caller semantics such as identity, lifecycle, compatibility, and error policy. Compose it when the GraphQL schema is one representation of a wider public contract.
- `authorization-security` owns the policy for who may read or change each resource. Keep GraphQL edge, node, field, mutation, and resolver enforcement here when that policy is exercised through GraphQL. Do not invent an authorization policy merely because a resolver is present.
- `http-rest-engineering` owns HTTP methods, media types, caching, and status behavior when GraphQL execution is not the material issue. GraphQL over HTTP behavior belongs here only when transport and GraphQL response semantics interact.
- `grpc-protobuf` owns protobuf fields, wire numbers, generated clients, and streaming semantics. `backend-engineering` owns backend architecture that is independent of GraphQL execution.
- Do not select this skill for a documentation heading, historical example, quoted issue, or a verification only request when schema and resolver behavior are already fixed.

## Decisions

1. Choose nullability from domain guarantees and failure semantics. Non null is a client contract.
2. Evolve fields additively where possible. Deprecate with a reason before removal. A change that makes a previously valid request invalid is breaking. Treat supplied persisted queries and migration contracts as immutable compatibility inputs, including `persisted-queries/legacy-mobile.graphql` and `migration-contract.md` when present. Capture their starting bytes, then confirm an exact byte match after implementation. Never rewrite, rename, or append rollout notes to these inputs; create a separate migration plan unless the user explicitly requests changing the inputs. For a scalar to object migration, verify the supplied operation and deprecation metadata through the installed GraphQL executor and introspection when that executor is available. If it is unavailable, record the package/runtime lookup, exact reason, and the unperformed checks as `unavailable`; do not call SDL text inspection or a resolver helper an executor result.
3. Enforce authorization at the business data or action boundary reached by resolvers. Client hiding or a top level guard does not protect nested access. If the migration is read only and the fixture has no authorization policy or mutation, say `not applicable` with the reason and keep any authorization or mutation claim out of the result. If a protected field or mutation is present, exercise its real resolver path, including aliases, fragments, and nested access.
4. Batch repeated backend access when resolver fan out creates N plus 1 work while preserving request specific authorization and cache scope. A single user field migration does not prove batching: classify N plus 1 as `exercised`, `not applicable`, or `unavailable` based on the actual resolver/backend fixture, with call counts and batch keys when exercised.
5. A loader created per request queues keys with one resolver for each pending key, deduplicates before one scheduled batch, then settles every resolver from that shared batch. Never flush only the triggering key or call the backend once per loader call. Use a fresh cache for every request and every subscription event.
6. Define pagination ordering and cursor meaning from stable domain order rather than incidental offsets when concurrent writes can reorder results. For a singular `Query.user` migration, pagination is `not applicable`; for a collection or connection in scope, execute a page boundary insertion/deletion case and report cursor/order evidence.

7. Treat input and output nullability as different contracts. A required input without a default can reject a previously valid request, while a weaker output guarantee changes what a successful response may contain. Review both directions explicitly, including list item and list container nullability.
8. Separate request errors from execution errors. Parse, validation, operation selection, and variable coercion failures prevent execution. A field failure during execution belongs in the response error list and follows the schema's nullable boundary. Preserve error paths and stable safe codes while keeping internal causes out of caller visible messages.
9. Resolve fields from public domain objects or explicit view models. Keep storage joins, table names, ORM records, and service credentials behind the resolver boundary. A resolver may assemble a representation, but it must not expose an arbitrary database graph or infer permission from a client supplied identifier.
10. Apply the authoritative viewer and tenant context at every protected edge, node, field, and mutation. Test aliases, fragments, inline fragments, direct node lookup, and nested access. A root check or UI omission is not an access control boundary. For the nullable avatar fixture, retain the explicit boundary dispositions in `evals/fixtures/nullable-field-evolution/boundary-dispositions.json` and classify each unrelated boundary as exercised, not applicable with a reason, or unavailable with the missing seam.
11. For federation, assign ownership of each field, key, entity lookup, and authorization decision to a named subgraph. Verify composed nullability, entity errors, and downstream fan out at the boundary that actually resolves the field. Do not treat federation directives as proof of authorization or performance.

## Security and performance boundaries

- Validate mutation inputs with the narrowest schema types, enums, custom scalar rules, size limits, and semantic checks the domain requires. Validate again at the sink that interprets the value. GraphQL validation does not replace authorization, parameterization, output filtering, or resource limits.
- Distinguish resolver batching from transport query batching. Bound document size, operation count, aliases, list cardinality, depth, estimated field cost, execution time, and downstream calls together. Choose limits from measured workload and caller policy, then exercise the rejected path and the permitted boundary.
- Keep request local loader caches keyed by the complete authorization context or scoped to a request context that cannot cross viewers. Do not use a process singleton for viewer specific values, errors, or in flight promises. A subscription handshake does not own the cache for later events.
- Measure resolver fan out and downstream work for representative nested queries with aliases and fragments. Report input items, distinct keys, batch sizes, backend call count, cache hits, latency samples, and any imposed maximum. A depth check or a single fast unit test does not prove query safety or performance.
- Use stable cursor ordering for changing collections. Define tie breakers, cursor contents, page size limits, and behavior when a record is inserted, deleted, or becomes unauthorized between pages. Do not describe offset pagination as stable without evidence.

## Verification

1. Measure backend calls for representative nested queries and mutations.
2. Add executable regression tests for duplicate keys, simultaneous users, errors for individual keys, and separate subscription events. Verify one batch per scheduling turn, each key once, every waiter settled, and no cache leakage. In particular, distinguish repeated keys inside one resolver fan out from **overlapping loads in flight within the same request context**: hold a backend batch unresolved using a controlled deferred promise, start another resolver/query using that same context and key after the first batch begins, and assert one backend fetch, the same eventual value or per key error for both waiters, and no extra batch. Also test duplicates before the scheduled flush. A sequential cache test or duplicate IDs within a single orders array cannot prove the overlapping load race is correct. Run the same tests against the original broken loader and the repair; they must reject the broken version and pass the repair. If the broken loader still passes, strengthen assertions on backend call counts, distinct IDs, authorized customer values, partial errors, and event cache isolation before completion.
3. Force resolver errors below nullable and non null fields and verify error paths and null propagation. For an optional `User.avatar: Avatar`, a thrown `Avatar.url: String!` resolver must null the `avatar` boundary while preserving the nullable parent `User`; a failure at a non null parent field must bubble to the nearest nullable ancestor. For schema evolution, run the candidate's tests against the repair, then independently restore the old schema and the old resolver; tests must fail for each broken version. Execute the supplied persisted legacy operation rather than replacing it with an equivalent inline query, and include executable assertions for that operation, nullable avatar absence, deprecation metadata, and a resolver failure that preserves the parent with a partial error. If either old version passes, or the persisted operation is never exercised, strengthen the assertions and repeat the negative checks. A passing test that merely mentions these behaviors is insufficient.
4. Reach protected data through aliases, fragments, and nested resolvers to verify authorization cannot be bypassed.
5. Compare schema changes against real client operations, including removed fields, defaults, nullability, and enum evolution.
6. Exercise pagination across a page boundary while inserting a nearby record.

## Full task checks

1. Establish the actual GraphQL server, schema version, execution context factory, transport boundary, persisted operation store, and supported client versions before editing. Record whether each claim is local, simulated, unavailable, inferred, or measured.
2. Capture immutable migration contracts and supplied persisted operations as bytes. Execute the supplied operation through the installed GraphQL executor when available, compare the schema diff with real operations, and restore the original bytes before reporting completion. If no executor is available, record the lookup, reason, and unperformed execution checks explicitly.
3. Exercise validation, variable coercion, successful execution, nullable field failure, non null propagation, aliases, fragments, and introspection deprecation metadata through the actual executor when available. Assert response data, error paths, stable error codes, and absence of sensitive details. Record the executor package and version plus the observed introspection shape. If no executor is installed, label execution and introspection `unavailable` with the lookup and reason. For mutation authorization, N plus 1, pagination, authorization bypass, and query cost limits, record one of `exercised`, `not applicable`, or `unavailable` and explain the fixture boundary; do not infer coverage from a read only avatar query or from static SDL.
4. For loaders, run duplicate keys before flush, overlapping in flight loads in one request, simultaneous viewers, a missing or denied key, a per key error amid successful keys, a second request by the same viewer, and two subscription events. Assert backend calls, distinct ordered keys, viewer identity, settled waiters, partial data, and cache isolation.
5. Run representative abuse and performance checks with the real validation and execution boundary. Exercise size, alias, list, depth, cost, timeout, rate, and pagination limits where configured, and compare fan out and latency against a baseline workload. If the fixture has no configured validator, cost analyzer, collection, or backend workload, mark the corresponding check `not applicable` or `unavailable`, name the missing boundary, and do not claim production safety or latency improvement.
6. Restore each known broken schema, resolver, loader, authorization path, and limit independently when practical. The candidate tests must fail for the targeted defect and pass the repair. A test name, comment, schema regular expression, or mock return value alone is not evidence.
7. Report the schema diff, operations exercised, resolver and backend counts, security paths, performance measurements, exact commands, runtime versions, and unavailable checks. Do not promote a local fixture result into a claim about production traffic, a remote subgraph, or a client runtime that was not exercised.

## Boundaries

Do not expose arbitrary database graphs, make every field nullable, guard only top level resolvers, or change client contracts casually. Query depth is not a substitute for measured resolver cost.

Use `api-contract-design` for transport neutral caller semantics. Compose `authorization-security` when authorization policy or enforcement changes. Compose `verification` for acceptance evidence. Read [the schema contract playbook](references/schema-contract-playbook.md) for evolution and error semantics and [the request batching playbook](references/request-batching-playbook.md) for loader lifecycle and performance checks.

## Completion evidence

Provide the schema diff, representative execution evidence for errors and null propagation or an explicit unavailable record, pagination checks or a not applicable disposition, resolver call counts, authorization bypass checks when protected data is involved, and batching measurements when performance controls changed. Keep mutation, query cost, and production claims bounded by the exercised fixture.

Use [the maintained source map](references/sources.md) for version sensitive facts and source conflicts.
