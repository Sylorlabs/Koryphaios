---
name: webhook-integration
description: Engineer webhook producers and consumers with authenticity, idempotency, ordering, retries, replay, observability, and lifecycle discipline. Use when the request specifically requires webhook, webhook signature, webhook event, callback endpoint; prefer a narrower child only when its boundary is established.
---

# Webhook Integration

## Responsibility

Define event identity/schema/version, signature/authentication, replay window, delivery retry schedule, ordering guarantees, endpoint ownership, acknowledgement timing, and durable processing. Acknowledge only after the system reaches the provider-required durable boundary.

Verification focus: Test valid/invalid signatures, duplicate/reordered events, retries, timeouts, endpoint downtime, old schema versions, replay attacks, and reconciliation with the provider source of truth.

Failure boundaries: Do not perform long work before acknowledging when the provider contract discourages it, trust source IP alone, parse signatures after mutating raw bodies, or assume exactly-once delivery.

## Hierarchy and routing

- Broader skills: integration-implementation.
- No narrower bundled child is declared.
- Cross-cutting facets: application-security.
- Required skills: verification.

## Decision rules

- Verify authenticity exactly as the provider specifies, including raw-body requirements, signature header format, secret rotation, and replay tolerance. Do not substitute source IP for a cryptographic contract unless the provider explicitly defines it that way.
- Give every delivered event a stable identity and make processing idempotent because providers can retry and delivery can duplicate.
- Treat ordering as provider-specific. If the provider does not guarantee order, derive state from event versions, timestamps, object retrieval, or another authoritative source rather than arrival sequence.
- Choose the acknowledgement boundary from the provider retry contract and the application's durability requirement. If long work would trigger retries, durably enqueue or record first, then acknowledge when that satisfies the contract.
- Keep schema/version compatibility and replay handling explicit so older or resent events cannot silently corrupt newer state.

## Observable checks

- Verify a known-valid signed payload, then reject changed bodies, wrong secrets, stale signatures outside the configured tolerance, and missing signature metadata where applicable.
- Deliver the same event more than once and prove only the intended durable side effect occurs.
- Reorder related events and verify state is reconciled according to the provider contract rather than arrival order.
- Simulate endpoint timeout or downtime and observe retry plus recovery behavior using provider-supported test facilities when available.
- Compare local state with the provider's authoritative object or reconciliation API after delayed, duplicate, or failed processing.

## Completion evidence

- Provider-specific authenticity, acknowledgement, retry, and ordering contract.
- Signature, duplicate, reorder, timeout/downtime, and reconciliation results actually exercised.
- Explicit unknowns for provider production retry timing or account-specific configuration not observed.

Use [the maintained source map](references/sources.md) for version-sensitive facts and source conflicts.
