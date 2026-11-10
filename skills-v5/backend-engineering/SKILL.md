---
name: backend-engineering
description: Engineer backend state, concurrency, jobs, persistence, and recovery without prescribing a stack. Use when implementing backend behavior, server architecture, jobs, sync checkpoints, local services, or compiler daemons. Use specialists for work confined to API contracts, protocols, language syntax, email delivery, or verifying completed systems.
---

# Backend Engineering

## Responsibility

Own the state, computation, policy, and coordination behind an operation that consumers can see. Treat backend as a responsibility boundary, not a mandate for a server, SQL database, queue, REST API, or cloud deployment. Start with the repository's running path and maintained contracts: who calls the operation, what the caller observes, what state survives restart, and who can change it. Establish the actual runtime, deployment, trust, consistency, concurrency, latency, throughput, and failure constraints before choosing technology.

For an implementation request, trace the existing entrypoint through state transitions, durable storage, external effects, and the response. Inspect tests and adapters before changing contracts or storage. Prefer the smallest change at the owning boundary; preserve data that users own and current caller behavior unless the request requires a migration.

### Boundary and identity record

Before choosing a repair, record the runtime and topology that the evidence actually supports: the consumer and trust boundary, the state and effect owners, the persistence lifetime, the dispatch path, and whether workers can overlap. A synchronous fixture within one process with maps and an array is a modeled state machine. It is not evidence of a broker, durable storage, lease fencing, or parallel claim isolation.

Treat request identity as an operating contract, not as a payload hash. State the key namespace, retention horizon, and the outcome for both equivalent and different payloads. The first accepted payload owns the authoritative record. A retry with the same key may return the existing supported result, but it must not replace the stored payload or silently accept a second intent. If the existing public contract has no conflict response, preserve that response and document that the first payload wins rather than inventing a status.

Separate evidence labels in the result: `observed` for an executed boundary, `modeled` or `simulated` for an injected fixture transition, and `unavailable`, `inferred`, or `stale` when the runtime cannot establish the claim. Sequential calls do not establish concurrency, and reusing one mutable object does not establish durable restart.

## Hierarchy and routing

- This is the root for backend responsibility. Narrower children: `bun-deno-runtime`, `compiler-runtime-backend`, `distributed-backend`, `in-process-backend`, `linux-systems`, `local-service-backend`, `mongodb-engineering`, `network-service-backend`, `nodejs-runtime`, `redis-engineering`, `relational-data-modeling`, `search-indexing`, `vector-search-systems`.
- Choose a child when evidence establishes its distinct boundary: a core in the same process, a supervised local daemon, a network service, a coordination problem across multiple nodes, a compiler/runtime, or specific storage/runtime semantics. Keep state and consumer invariants at the root across those boundaries. Do not introduce a new service to justify choosing a child.
- Select for the **current requested work**, including backend behavior in a task that is otherwise full stack. A quoted issue, previous conversation, or incidental server code does not activate this skill if the live request is solely API contract design, a protocol (GraphQL/gRPC/HTTP), engineering confined to the C or C++ language, or email delivery. Those are adjacent specialties; compose them when their independent work is requested. Preserving an existing API is still part of a backend change.
- Adjacent owners include `api-contract-design`, `http-rest-engineering`, `graphql-engineering`, `grpc-protobuf`, `c-cpp-systems-engineering`, and `email-delivery`. `reliability-verification` owns verification of a completed resilience contract; `concurrency-debugging` owns investigation of an unexplained race. Compose them when the request also changes backend behavior.

## Professional practice

1. **Locate authority.** Identify consumers, contract tests, deployment, trust zones, state owners, persistence lifetime, and the authoritative commit point. Record whether duplicate or stale inputs and concurrent workers are possible.
2. **State invariants.** Describe allowed transitions, identity and uniqueness, ordering, compatibility, and what a caller must observe after success, denial, cancellation, interruption, and retry. Map each write or external action to its durable evidence of completion.
3. **Choose proportionate boundaries.** Reuse the current process and storage model unless isolation, scale, privilege, ownership, or lifecycle requirements demand another. Choose transaction, messaging, transport, and retry policies from available guarantees rather than preferred frameworks.
4. **Implement through the full path.** Enforce ownership and state changes at the authoritative boundary, with bounded concurrency, retries, cancellation, timeouts, and resources as required. Actions across stores have no single atomic commit by default; define safe replay, reconciliation, or compensation instead of promising execution exactly once.
5. **Verify at the consumer boundary.** Exercise the unchanged supported request/response shape and material error paths, then race duplicate work and restart at the actual commit/acknowledgment boundary. Add maintained regression coverage for changed transitions and report the concrete results.

### State and resource decisions

- A transaction name does not establish isolation. Protect each invariant across every writer, including administrative and recovery paths; a mutex in one process cannot serialize another process. For conditional updates, conflicting writes, derived state, or storage evolution, read [state authority and concurrency](references/state-concurrency.md).
- Bound admission, active work, waiting work, retained state, and dependency calls separately. Choose retry ownership, retryable errors, attempt and elapsed budgets, backoff with jitter, and poison work disposition. A timeout or lost response can mean an unknown effect, not a failed effect; reconcile before repeating an unsafe action.
- Cancellation and shutdown need a durable handoff or a safe stop boundary, not just an abort signal. Release owned timers, connections, locks, and temporary artifacts on failure. When storage changes, verify realistic old state, interrupted migration, and the supported rollback or forward recovery path.

### Recovery decisions that alter implementation

- Separate **accepted**, **claimed**, **effect applied**, **durably recorded**, and **acknowledged** states. A successful handler response, queue delivery, upload, or retry is not proof that every durable effect committed.
- Determine which effects can be repeated, which are guarded by a durable uniqueness claim, and which require an explicit reconciliation path. A flag held in memory, a retry delay, and an idempotent entity upsert cannot prevent duplicate side effects that are not idempotent after a crash.
- For queues, worker claims, or external object effects, read [durable jobs and side effects](references/durable-jobs.md). For paginated feeds, opaque cursors, or resumed local sync, read [checkpoints that replay safely](references/replay-checkpoints.md). Load only the relevant reference.
- Preserve existing status codes, response fields, error identities, and supported old callers. Change a public contract only when the task justifies it, and test the old behavior beside the new one.

### Completion evidence

- **System boundary contract:** actual runtime and topology, consumer and trust boundary, state authority, concurrency and consistency model, and concrete specialist boundary when relevant.
- **Failure and recovery verification:** maintained success and failure path tests; when durable work changes, fault/replay tests across the effect and checkpoint or acknowledgement, including a restart from a fresh instance. Assert logical effects and stored identities, not just a successful retried response.
- State any untested failure boundary, missing runtime, simulated fault, inferred guarantee, or fact that is version sensitive as such. Scope resource, capacity, and observability claims to what was measured. Do not claim complete reliability from a healthy endpoint or a happy path.

Routing verdicts, hierarchy scoring, and paired candidate/baseline provenance belong to the evaluator. Report the requested behavior and observed results rather than inventing evaluation artifacts or qualification claims.

Use [the maintained source map](references/sources.md) when behavior that is version sensitive or source conflicts affect a decision.
