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

## Authenticate before you remember

An inbound event is untrusted until its signature over the raw body verifies against the current secret, and its timestamp falls inside the accepted replay window. Run both checks before deduplication, before canonical reconciliation, and before any durable write. A dedupe store that records an unauthenticated payload lets a forged delivery claim an identifier the genuine event will need later, so the real event is then discarded as a duplicate.

Reject on the raw bytes, never a re serialised body. A stale timestamp and an invalid signature are both rejections, and each carries its own reason in the result so an operator can tell a forged delivery from a delayed one. Only an authenticated identifier enters the dedupe store; a repeated authenticated delivery does nothing further and is neither an acceptance nor a rejection. Rotate secrets so that a previous secret stays acceptable for the overlap window.

## Recover a gap from canonical state

When a delivery is missed, a cursor is skipped, or ordering cannot be trusted, recover from the provider's canonical collection: read the authoritative list from the last position that is still valid and reconcile the local rows against it. Replaying increments from a local cache, or trusting that every identifier arrived, reproduces the gap and can silently drop the events that fell inside it.

Reconciliation must be safe to repeat and must run even when no event arrived, because a quiet period is exactly when a missed delivery stays invisible. The canonical value is authoritative for the final state once the collection read succeeds, so an accepted event updates a row and the reconciliation then confirms or corrects it. Report whether reconciliation ran, and do not report a reconciled state from a cached or unreadable collection.

Compare by stable provider identity, mark absent rows as removed only when the provider says the collection is complete, and advance the checkpoint after the reconciled page commits. Treat the local cache as an accelerator that a full read can always rebuild.

## Commit page progress atomically

For paginated pulls, one page's durable mutations and its checkpoint advance are a single commit invariant: commit them together, and advance the checkpoint only after that commit succeeds. On failure, neither the page nor its checkpoint is partially accepted; restart from the last committed checkpoint and make replay safe with provider idempotency or local upsert/deduplication. Keep the checkpoint in durable shared state; an invocation-local `Map` may optimize work but is never the source of truth.

## Verify the seam

Exercise success, malformed or changed payloads, denied access, timeout after a possible commit, duplicate input, cancellation, and recovery where relevant. Use contract fixtures for reproducibility and a configured sandbox or authorized integration environment for real transport and provider behavior. Identify mocked or unavailable boundaries explicitly. Payment, email, and webhook lifecycle rules belong to their narrower children; `verification` owns the final completion verdict.

## Completion evidence

- Versioned boundary mapping, identity/authority contract, and preserved provider errors
- Observed retry, partial-commit reconciliation, compatibility, and cancellation behavior
- Tested environment and remaining external-service evidence gaps

Use [the maintained source map](references/sources.md) for version-sensitive facts and source conflicts.
