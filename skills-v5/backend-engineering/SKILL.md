---
name: backend-engineering
description: Engineer state, computation, coordination, persistence, policy, and reliability behind consumers without assuming language, SQL, REST, or cloud topology. Use when the request specifically requires backend engineering, implement backend behavior, design a local service, build a compiler daemon.
---

# Backend Engineering

## Responsibility

Treat backend as a responsibility boundary, not a technology stack. Identify consumers, topology, deployment and trust boundaries, state ownership, consistency and concurrency requirements, failure model, latency and throughput needs, persistence lifetime, protocols, compatibility, observability, recovery, and operational constraints before selecting architecture.

Inspect the repository and runtime before choosing language, database, transport, framework, process model, or deployment platform. In-process modules, local services, embedded loops, compiler runtimes, peer systems, and distributed services require different designs. Select SQL, key-value, files, memory, logs, queues, RPC, REST, or no persistence only from requirements and existing architecture. Define contracts, invariants, idempotency, timeouts, cancellation, backpressure, resource limits, error taxonomy, migrations, and rollback proportional to the system. Verify at the real boundary, including failures and recovery; do not mistake endpoint existence for backend correctness.

## Hierarchy and routing

- This is a graph root for its responsibility.
- Narrower children: bun-deno-runtime, compiler-runtime-backend, distributed-backend, in-process-backend, linux-systems, local-service-backend, mongodb-engineering, network-service-backend, nodejs-runtime, redis-engineering, relational-data-modeling, search-indexing, vector-search-systems.

## Professional practice

### Operating contract

Engineer state, computation, policy, persistence, and coordination behind consumers without topology assumptions.

### Execution sequence

1. Identify consumers, trust, topology, deployment, state ownership, consistency, and quality needs.
2. Trace commands, queries, events, concurrency, failures, and lifecycle end to end.
3. Choose the least complex topology satisfying observed constraints.
4. Implement contracts, policy, observability, cleanup, and recovery at owning boundaries.
5. Verify behavior under representative load, denial, partial failure, restart, and migration.

### Decisions that must be explicit

- In-process, local service, network service, distributed, or compiler/runtime topology.
- State ownership and consistency model.
- Protocol and compatibility boundaries.
- Retry, idempotency, timeout, cancellation, and recovery policy.

### Failure and recovery discipline

- REST, SQL, cloud, or microservices are assumed.
- Duplicate authorities diverge.
- Retries amplify failure or repeat side effects.
- Internal health masks consumer-visible failure.

### Evidence required before completion

Persist regression tests at the consumer boundary for each repaired failure transition. Interrupt before and after durable effects, restore state in a fresh instance, replay duplicate or stale work, and cancel at an admissible boundary. Assert logical effects and cursor or job identity after recovery, not merely a successful retry response. Describe the consumers, state owner, topology and selected specialist boundary alongside these results; label runtime evidence that the available environment cannot produce.

- Topology and state contract.
- Boundary and compatibility tests.
- Failure/recovery and observability results.
- Resource and performance evidence appropriate to claims.

### Anti-misinterpretation boundaries

- Do not add a service without a deployment reason.
- Do not broaden trust for convenience.
- Do not hide unknown provider values behind fallbacks.
- Do not claim durability or concurrency guarantees without tests.

## Completion evidence

- System boundary contract
- Failure and recovery verification

Use [the maintained source map](references/sources.md) for version-sensitive facts and source conflicts.
