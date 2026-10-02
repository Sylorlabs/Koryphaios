---
name: graphql-engineering
description: Engineer GraphQL schemas, resolvers, loaders, errors, authorization, pagination, federation, and evolution. Use when GraphQL types or execution are central.
---

# Graphql Engineering

Complete requested code and tests before optional analysis. If the task requests tests, changing code without changing an executable test file is incomplete. Before finishing, confirm those tests exercise the repaired behavior.

When tests are requested, treat the test diff as a required deliverable. Do not emit the final patch until at least one executable test file has been added or changed and those tests fail against the known broken behavior while passing the repair.

## Responsibility

Design schemas from durable domain semantics and client needs. Keep resolver ownership, batching, nullability, pagination, authorization, deprecation, and federation boundaries explicit. Authorize at data or action boundaries.

## Decisions

1. Choose nullability from domain guarantees and failure semantics. Non null is a client contract.
2. Evolve fields additively where possible. Deprecate with a reason before removal. A change that makes a previously valid request invalid is breaking.
3. Enforce authorization at the business data or action boundary reached by resolvers. Client hiding or a top level guard does not protect nested access.
4. Batch repeated backend access when resolver fan out creates N plus 1 work while preserving request specific authorization and cache scope.
5. A loader created per request queues keys with one resolver for each pending key, deduplicates before one scheduled batch, then settles every resolver from that shared batch. Never flush only the triggering key or call the backend once per loader call. Use a fresh cache for every request and every subscription event.
6. Define pagination ordering and cursor meaning from stable domain order rather than incidental offsets when concurrent writes can reorder results.

## Verification

1. Measure backend calls for representative nested queries and mutations.
2. Add executable regression tests for duplicate keys, simultaneous users, errors for individual keys, and separate subscription events. Verify one batch per scheduling turn, each key once, every waiter settled, and no cache leakage. Prove the tests reject a known broken loader and pass the repair.
3. Force resolver errors below nullable and non null fields and verify error paths and null propagation.
4. Reach protected data through aliases, fragments, and nested resolvers to verify authorization cannot be bypassed.
5. Compare schema changes against real client operations, including removed fields, defaults, nullability, and enum evolution.
6. Exercise pagination across a page boundary while inserting a nearby record.

## Boundaries

Do not expose arbitrary database graphs, make every field nullable, guard only top level resolvers, or change client contracts casually. Query depth is not a substitute for measured resolver cost.

Use api contract design for transport neutral caller semantics. Compose authorization security when authorization policy or enforcement changes. Verification is required.

## Completion evidence

Provide the schema diff, representative execution evidence for errors and null propagation, pagination checks, resolver call counts, authorization bypass checks when protected data is involved, and batching measurements when performance controls changed.

Use [the maintained source map](references/sources.md) for version sensitive facts and source conflicts.
