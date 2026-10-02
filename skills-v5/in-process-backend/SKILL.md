---
name: in-process-backend
description: Engineer stateful application cores, libraries, game simulations, and local modules that do not require a service boundary. Use when the request specifically requires in-process, application core, game simulation, library backend.
---

# In Process Backend

## Responsibility

Confirm that a process or network boundary is unnecessary before adding one. Define module ownership, state transitions, invariants, lifetime, concurrency or reentrancy, cancellation, resource ownership, error propagation, serialization boundaries, and test seams. Keep domain behavior independent from presentation and platform adapters without inventing interfaces that have no second implementation or substitution need.

Prefer direct calls and explicit data flow when they satisfy isolation and reliability requirements. Avoid service frameworks, REST, database servers, queues, containers, and distributed coordination unless a real boundary demands them. Test state machines, invariants, ordering, interruption, persistence adapters if present, and integration with the actual host runtime.

## Hierarchy and routing

- Broader skills: backend-engineering.
- No narrower bundled child is declared.

## Ownership at the host boundary

Distinguish resources a module creates from resources it borrows. Name the lifetime owner, disposal path, and cancellation/join order. A long-lived owner must not accidentally retain request-scoped state; an injected shared resource must not be disposed by an arbitrary consumer. Check the actual host or container contract rather than assuming injection transfers ownership.

Exercise failed initialization after partial allocation, nested or concurrent calls when supported, and teardown during active work. Verify completed work cannot mutate a closed owner, borrowed resources remain usable by their owner, and sequential consumers do not inherit unintended mutable state. Use host-runtime tests to expose initialization-order and cleanup errors that isolated function tests miss.

Direct calls are not a security sandbox. Escalate to `backend-engineering` when crash containment, privilege, deployment, or lifecycle requirements require a different topology. A measured performance comparison is needed only for a performance claim, not as a prerequisite for keeping an otherwise suitable module in-process.

## Completion evidence

- Ownership and state-transition model
- Host-runtime initialization, reentrancy, interruption, and cleanup results for the affected lifecycle

Use [the maintained source map](references/sources.md) for version-sensitive facts and source conflicts.
