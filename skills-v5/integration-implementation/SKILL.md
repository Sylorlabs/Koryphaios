---
name: integration-implementation
description: Connect components or external systems through explicit contracts and failure boundaries. Use when the request specifically requires integrate, adapter, provider connection; prefer a narrower child only when its boundary is established.
---

# Integration Implementation

## Responsibility

Confirm both sides, isolate translation, identity, lifecycle, retries, timeouts, cancellation, versioning, idempotency, and partial failure. Preserve provider-reported truth, keep unknown values unknown, and test drift and degraded dependencies.

## Hierarchy and routing

- Broader skills: implementation.
- Narrower children: email-delivery, payment-integration, webhook-integration.
- Required skills: verification.

## Map meaning before transport

Trace a representative request or event from caller to provider and back. Record stable identities, units, null versus missing values, ordering, version negotiation, ownership, and authoritative state. Keep translation in the adapter and preserve provider errors rather than converting an unknown result into an empty success. Check existing consumers before changing a mapping.

## Resolve partial outcomes

A timeout does not establish whether a side effect committed. Use the provider's idempotency or status/reconciliation contract before replaying an ambiguous mutation. Bound the total deadline and retry count, identify the retry-owning layer, and inspect SDK retries before adding another loop. Backoff and jitter can spread transient retries; they do not make a non-idempotent operation safe or repair a permanent validation/authorization error.

Cancellation stops local waiting only when that is all the provider supports. State whether remote work is canceled, still running, or requires later reconciliation. Define how late results, duplicate deliveries, expired credentials, and incompatible payload versions affect durable state.

## Commit page progress atomically

For paginated pulls, one page's durable mutations and its checkpoint advance are a single commit invariant: commit them together, and advance the checkpoint only after that commit succeeds. On failure, neither the page nor its checkpoint is partially accepted; restart from the last committed checkpoint and make replay safe with provider idempotency or local upsert/deduplication. Keep the checkpoint in durable shared state; an invocation-local `Map` may optimize work but is never the source of truth.

## Verify the seam

Exercise success, malformed or changed payloads, denied access, timeout after a possible commit, duplicate input, cancellation, and recovery where relevant. Use contract fixtures for reproducibility and a configured sandbox or authorized integration environment for real transport and provider behavior. Identify mocked or unavailable boundaries explicitly. Payment, email, and webhook lifecycle rules belong to their narrower children; `verification` owns the final completion verdict.

## Completion evidence

- Versioned boundary mapping, identity/authority contract, and preserved provider errors
- Observed retry, partial-commit reconciliation, compatibility, and cancellation behavior
- Tested environment and remaining external-service evidence gaps

Use [the maintained source map](references/sources.md) for version-sensitive facts and source conflicts.
