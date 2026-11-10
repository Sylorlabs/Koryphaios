---
name: in-process-backend
description: Engineer stateful application cores, libraries, game simulations, and local modules that do not require a service boundary. Use when the request specifically requires in-process, application core, game simulation, library backend.
---

# In Process Backend

## Responsibility and boundary

Confirm that the current request is an application core, library backend, game simulation, or other same process module before adding a service boundary. State the decision in terms of the live request, not a quoted issue, an incidental server file, or a fixture name. If the task is actually a local daemon, network service, distributed coordination problem, compiler or runtime implementation, or runtime setup only, route that responsibility to the relevant sibling or to `backend-engineering`.

Before changing code, record the operating contract:

- caller and supported entrypoint;
- host runtime and deployment topology;
- state authority and what survives restart;
- owned and borrowed resources;
- observable success, cancellation, failure, timeout, and retry results;
- the commit or linearization point for each invariant;
- whether the requested evidence is a real host run, a controlled simulation, or unavailable.

Prefer direct calls and explicit data flow when they satisfy isolation and reliability requirements. Avoid service frameworks, REST, database servers, queues, containers, and distributed coordination unless a real boundary demands them. Do not invent an interface merely to make a substitution seam. Keep domain behavior independent from presentation and platform adapters while preserving the actual host contract.

## Hierarchy and routing

- Broader skills: `backend-engineering`.
- No narrower bundled child is declared.

## Lifecycle and ownership at the host boundary

Distinguish resources a module creates from resources it borrows. Name the lifetime owner, disposal path, and cancellation or join order. A long lived owner must not accidentally retain state scoped to the request; an injected shared resource must not be disposed by an arbitrary consumer. Check the actual host or container contract rather than assuming injection transfers ownership.

Exercise failed initialization after partial allocation, nested or concurrent calls when supported, and teardown during active work. Verify completed work cannot mutate a closed owner, borrowed resources remain usable by their owner, and sequential consumers do not inherit unintended mutable state. Use host runtime tests to expose initialization order and cleanup errors that isolated function tests miss.

Use a lifecycle record for each long lived owner: `created`, `starting`, `ready`, `closing`, `closed`, and `failed` as applicable. Define which calls are admitted in each state, who owns each transition, and whether close drains accepted work or rejects it. If initialization allocates several resources, unwind them in reverse ownership order after a partial failure. Teardown must stop new work, cancel or complete accepted work according to contract, join workers and callbacks, dispose timers and listeners, and only then mark the owner closed. A closed owner must reject late callbacks and late writes, including callbacks that were already queued before listener removal.

Use [the lifecycle contract](references/lifecycle-contract.md) to write a compact ownership table, state machine, schedule matrix, and evidence receipt. It is an authoring aid, not proof that a runtime exercised those transitions.

## State and task contracts

Separate logical acceptance, in flight ownership, external effect, durable recording, and caller acknowledgment. A useful job or mutation model may include `accepted`, `queued`, `claimed`, `running`, `effect-applied`, `durably-recorded`, `completed`, `cancelled`, `retryable`, and `unknown`; use only the states the actual contract needs. For every transition specify the owner, allowed predecessor, durable identity, observable result, and recovery action. Do not collapse an ambiguous timeout into failure when the effect may have committed.

Write task contracts around invariants rather than implementation nouns. Require the actual caller path, stable logical identity, supported old behavior, failure injection boundary, cleanup observation, and recovery on the same entity. If a fixture uses a map, fake clock, phase driver, or simulated restart, require the resulting evidence to say `simulated`; it cannot be silently promoted to SQLite durability, OS thread scheduling, process crash recovery, or production behavior.

### Shared async work and cancellation

For coalesced work, separate each caller's cancellation from the owned underlying operation. Cancelling one waiter must not abort work still needed by another; cancellation of the last waiter or an owner deadline must settle the shared operation's public promise and release its registry slot. **Aborting an `AbortController` alone does not settle a loader that ignores `AbortSignal`.** Bound the operation independently (for example, by racing the loader against an abort or deadline rejection), detach promptly, and guard against an abandoned loader writing a late result or producing an unhandled rejection. Bound both completed cached entries and active per key refresh bookkeeping under high cardinality churn. Dispose timers and listeners when settled. Keep loader failure, caller cancellation, owner timeout, and capacity refusal distinguishable when applying stale fallback; a timeout or cancellation is not a successful refresh failure that authorizes stale data.

Verify with a deliberately non cooperative loader whose promise never resolves: cancel its last waiter, confirm a new call for that key starts fresh work, and exercise the independently injected timeout or recovery path. Also verify one cancelled waiter does not disrupt other waiters, timeout does not serve stale data, and ordinary loader failure serves stale data only when explicitly requested and still within its stale window. A test with only abort aware loaders is insufficient evidence of bounded refresh lifetime.

For synchronous code, check reentrancy at every callback or injected dependency boundary. For asynchronous code, draw the competing schedules explicitly and identify the linearization point. A promise, `await`, or timer does not order independent operations. Test sequential control, both conflicting orders, cancellation or close during the check to effect gap, and useful fresh work after recovery. Bound admission, active operations, retained entries, timers, and dependency calls separately.

## Failure, recovery, and source provenance

Inject failures immediately before and after claim, effect, durable commit, acknowledgment, callback delivery, timeout, and close boundaries. Recreate a fresh owner against the authoritative state and prove what is retried, reconciled, cancelled, or left `unknown`. Check that retries preserve logical identity and do not repeat non idempotent effects. After recovery, run a new operation on the same entity to expose leaked locks, poisoned state, retained cancellation, or stale generations.

Use authoritative or reference sources for portable semantics, and keep host specific claims tied to host runtime evidence. Record the source URL, scope, revision or version, verification date, refresh policy, and what the source does not establish. A source map supports a decision; it does not prove that this repository's host, database, scheduler, or provider behaved that way. When sources conflict, prefer the more authoritative current source and preserve the conflict in the evidence record until the affected behavior is exercised.

Direct calls are not a security sandbox. Escalate to `backend-engineering` when crash containment, privilege, deployment, or lifecycle requirements require a different topology. A measured performance comparison is needed only for a performance claim, not as a prerequisite for keeping an otherwise suitable module in process.

## Completion evidence

- Boundary and selected specialist rationale
- Ownership and state transition model with the authoritative commit point
- Host runtime initialization, reentrancy, interruption, and cleanup results for the affected lifecycle
- Concurrency schedule and failure or recovery results, including a fresh post recovery operation
- Source provenance for version sensitive facts
- Explicit `simulated`, `unavailable`, `inferred`, `stale`, or `unresolved` labels where runtime proof is absent

Use [the maintained source map](references/sources.md) for version sensitive facts and source conflicts.
