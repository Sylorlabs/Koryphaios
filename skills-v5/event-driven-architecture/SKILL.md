---
name: event-driven-architecture
description: Design event-driven systems with clear event semantics, ownership, ordering, delivery, schema evolution, replay, and side-effect boundaries. Use when the request specifically requires event driven architecture, domain event, message broker architecture, event bus; prefer a narrower child only when its boundary is established.
---

# Event Driven Architecture

## Responsibility

Distinguish commands, domain events, integration events, notifications, and change-data streams. Define producer ownership, event identity, schema, ordering scope, delivery guarantee, idempotency, outbox/inbox, replay, retention, dead-letter policy, and consumer side effects.

## Transferable decisions

- Name the message role first. A command asks an owner to act; an event states that something happened; a notification tells a recipient about state; a change-data record mirrors storage change. Different roles imply different ownership and coupling.
- Define event identity, producer ownership, schema version, ordering scope, retention, and replay meaning before selecting broker features.
- Treat delivery guarantees as end-to-end properties. Broker delivery does not by itself make a side effect exactly once; consumer idempotency or reconciliation must cover redelivery.
- Publish only from a recoverable boundary with authoritative state. An outbox is one option when database commit and event publication cannot be atomic, not a universal architecture requirement.
- Scope ordering to the business invariant that needs it. Global ordering is usually stronger and more expensive than per-entity or per-partition ordering.

## Observable checks

- Deliver the same event twice and verify the consumer's externally visible effect is duplicate-safe or explicitly reconciled.
- Delay and reorder events within and across the declared ordering scope, then verify state converges according to the contract.
- Introduce an unknown additive field and an older supported schema version to verify consumer compatibility behavior.
- Replay a bounded historical range and confirm replay does not bypass normal idempotency, authorization, or side-effect controls.
- Inject a poison event and verify retry, quarantine or dead-letter handling, operator visibility, and recovery without blocking unrelated traffic beyond the intended scope.

## Failure boundaries

Do not use events to hide synchronous dependencies, publish before authoritative state commits without a recovery model, or let consumers depend on undocumented producer database fields. Do not claim exactly-once business effects from a broker setting alone.

## Hierarchy and routing

- Broader skills: distributed-backend.
- No narrower bundled child is declared.
- Required skills: verification, reliability-verification.

Route here for event semantics, producer and consumer ownership, asynchronous coupling, delivery, replay, and side-effect boundaries. Route continuous keyed state and event-time window computation to `stream-processing`, and route request/response APIs to the relevant API child.

## Completion evidence

- Declared message roles, identities, ownership, ordering scopes, delivery assumptions, and replay semantics.
- Duplicate, delay, reorder, schema-evolution, poison, and replay results for representative consumers.
- Evidence that producer publication and authoritative state have a recoverable boundary.
- Consumer idempotency or reconciliation evidence for externally visible side effects.

Use [the maintained source map](references/sources.md) for version-sensitive facts and source conflicts.
