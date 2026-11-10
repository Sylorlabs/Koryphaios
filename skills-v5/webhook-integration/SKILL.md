---
name: webhook-integration
description: Engineer webhook producers and consumers with authenticity, idempotency, ordering, retries, replay, observability, and lifecycle discipline. Use when the request specifically requires webhook, webhook signature, webhook event, callback endpoint; prefer a narrower child only when its boundary is established.
---

# Webhook Integration

## Responsibility

Define event identity/schema/version, signature/authentication, replay window, delivery retry schedule, ordering guarantees, endpoint ownership, acknowledgement timing, and durable processing. Acknowledge only after the system reaches the provider-required durable boundary.

Verification focus: Test valid/invalid signatures, duplicate/reordered events, retries, timeouts, endpoint downtime, old schema versions, replay attacks, and reconciliation with the provider source of truth.

Failure boundaries: Do not perform long work before acknowledging when the provider contract discourages it, trust source IP alone, parse signatures after mutating raw bodies, or assume exactly-once delivery.

## Start from the operating contract

A narrow webhook bug is still part of a larger delivery contract. Before editing, inspect the provider evidence and the repository's persistence/queue path, then account for these axes: event identity and schema/version; exact authentication input and secret rotation; replay window; provider or repository transport/input limits such as payload byte limits; at least once and duplicate behavior; retry and ordering guarantees; endpoint ownership; acknowledgement boundary; durable processing/idempotency; and reconciliation source of truth.

For each axis, distinguish facts documented by the provider or observed directly from repository assumptions, simulated behavior, and unavailable or unresolved evidence. Do not invent a retry schedule, ordering guarantee, acknowledgement rule, schema policy, or provider capability because the immediate task does not mention it. If a required axis is unknown, design so that the unknown cannot silently corrupt state and carry the uncertainty into completion evidence.

Treat that inventory as a completion gate, not background reading. Before claiming a webhook repair complete, include a concise operating-contract record in the task result that states what is known and the evidence status for every axis above. A code fix plus signature/duplicate unit tests is incomplete when retry/order, acknowledgement/durability, schema evolution, recovery, or reconciliation evidence is still absent and unmentioned.

## Hierarchy and routing

- Broader skills: integration-implementation.
- No narrower bundled child is declared.
- Cross-cutting facets: application-security.
- Required skills: verification.

## Decision rules

- Verify authenticity exactly as the provider specifies, including raw-body requirements, signature header format, secret rotation, and replay tolerance. Do not substitute source IP for a cryptographic contract unless the provider explicitly defines it that way.
- Preserve provider or repository input limits at the trust boundary. When a payload byte limit, header limit, decompression bound, or similar resource limit is part of the observed contract, enforce it before expensive parsing or business work and add boundary regressions for accepted and rejected inputs. Do not invent limits that are not documented or present in the repository.
- Keep replay rejection and delivery idempotency separate. A signature timestamp window limits which signed deliveries are accepted; it does not deduplicate valid retries.
- Give every delivered event a stable identity and make processing idempotent because providers can retry and delivery can duplicate. Memory local to one process, such as a `Set` or cache, proves only duplicate suppression within that process. When claiming safety across restarts or at least once processing, persist the event identity at the same durable boundary as the side effect or durable queue handoff. If the current fixture/API exposes only local process state, preserve the requested boundary but label durable idempotency as unproven instead of upgrading an in memory test into a production claim.
- Treat ordering as provider-specific. If the provider does not guarantee order, derive state from event versions, timestamps, object retrieval, or another authoritative source rather than arrival sequence.
- Choose the acknowledgement boundary from the provider retry contract and the application's durability requirement. If long work would trigger retries, durably enqueue or record first, then acknowledge when that satisfies the contract.
- Keep schema/version compatibility and replay handling explicit so older or resent events cannot silently corrupt newer state.
- After the immediate defect is covered, spend the remaining verification budget on the highest value lifecycle risk implied by the contract: restart durability, duplicate/reorder behavior, retry/timeout, endpoint recovery, old schema handling, or reconciliation. If the environment cannot exercise that boundary, name the check and mark it unavailable or simulated.
- Cover the lifecycle classes explicitly before completion: reordered deliveries; provider retries; timeout or endpoint downtime; old/new schema versions; restart durability at the side-effect or queue boundary; recovery after failed delivery; and reconciliation against the provider source of truth. Exercise the representative cases the environment can support. For every class that cannot be exercised, record the exact unavailable boundary rather than silently omitting it.

## Observable checks

- Verify a known-valid signed payload, then reject changed bodies, wrong secrets, stale signatures outside the configured tolerance, and missing signature metadata where applicable.
- Exercise any observed transport/input limit at its boundary, including the actual byte representation used by the receiver when payload size is constrained.
- Deliver the same event more than once and prove only the intended side effect occurs. If durability is claimed, repeat across a restart or equivalent persistence boundary; a duplicate test within one process alone is insufficient evidence.
- Reorder related events and verify state is reconciled according to the provider contract rather than arrival order.
- Simulate endpoint timeout or downtime and observe retry plus recovery behavior using provider-supported test facilities when available.
- Compare local state with the provider's authoritative object or reconciliation API after delayed, duplicate, or failed processing.
- Before declaring completion, ensure every operating contract axis is either backed by observable/provider evidence or explicitly labeled unavailable, simulated, inferred, stale, or unresolved.

## Completion evidence

- Provider specific operating contract inventory covering identity/schema/version, authenticity, replay, observed transport/input limits, retries/order, acknowledgement, durability, and reconciliation, with evidence status for each axis.
- Signature, duplicate, reorder, restart/durability, timeout/downtime, and reconciliation results actually exercised, plus explicit unavailable checks.
- Clear distinction between process-local duplicate suppression and durable idempotency, including the acknowledgement boundary that makes a successful response safe.
- Explicit unknowns for provider production retry timing, ordering, schema/version behavior, acknowledgement semantics, or account specific configuration not observed.
- Do not use a generic “tests pass” completion summary as a substitute for this evidence. The final result must make the operating-contract inventory and the exercised/unavailable lifecycle checks visible enough that a reviewer can distinguish the fixed receiver behavior from still-unverified production delivery semantics.

Use [the maintained source map](references/sources.md) for version-sensitive facts and source conflicts.
