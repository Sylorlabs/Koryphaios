---
name: payment-integration
description: Engineer payment integrations with explicit money, idempotency, authorization, capture, refunds, disputes, ledgers, webhooks, and reconciliation. Use when the request specifically requires payment integration, payment processor, checkout payment, payment webhook; prefer a narrower child only when its boundary is established.
---

# Payment Integration

## Responsibility

Model currency/minor units, payment intent/order identity, customer/payment method ownership, authorization/capture, asynchronous states, idempotency keys, refunds, disputes, fees, taxes, and internal ledger/reconciliation. Treat provider state as external evidence, not the sole business ledger.

Verification focus: Use provider test modes for success, decline, authentication, timeout, duplicate submission, delayed webhook, refund/partial refund, states that resemble disputes, and reconciliation against provider reports before production changes.

Failure boundaries: Do not store raw card secrets, compute money in binary floating point, mark paid solely from client redirects, or retry charges without idempotency and checks of provider state.

## Hierarchy and routing

- Broader skills: integration-implementation.
- No narrower bundled child is declared.
- Cross cutting facets: application-security.
- Required skills: verification.

## Decision rules

- Keep money in exact currency aware units and preserve provider object identity across retries, redirects, webhooks, refunds, and reconciliation.
- Make the durable boundary explicit. Persist the logical payment operation, order/payment attempt identity, currency and amount, idempotency key plus request fingerprint, provider identifiers, last authoritative evidence, and retry/reconciliation state. Write the operation before exposing success, and let restart recovery resume from that record rather than infer state from a request or redirect.
- Keep financial facts auditable and immutable. Store integer minor units or another exact currency type with the currency code; retain purchased price/tax/fee snapshots; represent captures, refunds, refund reversals, and disputes as distinct facts linked to the provider. Derive refundable and outstanding amounts from those facts, and reject a partial refund that exceeds the captured amount.
- Model payment state as an asynchronous lifecycle. A client redirect or a single HTTP response is not sufficient evidence that funds are durably paid or settled.
- Treat provider outcomes that are unknown, failed in transport, or unrecognized as pending/reconciliation states unless authoritative provider evidence proves a stronger state. Never default an ambiguous outcome to captured, paid, or settled.
- Use idempotency the provider supports for retriable mutations and bind a key to one logical operation. Reusing a key across different parameters is a correctness error.
- Keep provider state and the internal order or ledger model distinct. Reconcile them explicitly when external events can arrive late, duplicate, or out of order.
- Verify webhook authenticity against the provider's actual signed payload and signing policy before recording an event or changing payment state. Missing, failed, or malformed verification is untrusted, even when its payload claims success. Rejection must not prevent a later verified delivery of the same event ID.
- Treat an authenticated webhook as evidence to record, not as a replacement for provider truth. Deduplicate by stable event identity, tolerate out-of-order delivery, and use the provider's canonical object lookup or report to repair gaps and resolve conflicts. Keep the append-only audit trail separate from the current derived payment state.
- Persisted local payment state is not automatically terminal. Define which states may still advance or be corrected by later authoritative provider events, and make restart/recovery paths continue that reconciliation rather than returning early solely because a local record exists.
- Minimize payment-data scope. Do not store raw card secrets when provider-hosted or tokenized mechanisms meet the requirement.

## Observable checks

- Exercise success, decline, authentication-required, timeout, duplicate submission, and safe retry in the provider's supported test environment.
- Verify webhook-driven state changes independently from client return flows, including delayed and duplicate events.
- Exercise missing, invalid, and malformed webhook verification results plus a verified replay after a rejected delivery; only verified deliveries may enter the audit trail.
- Restart from persisted pending/reconcile and failed/declined states, then apply later authoritative provider events and verify the state machine converges according to the documented transition policy without issuing a duplicate charge.
- Test full and partial refunds plus reconciliation against provider-reported objects or reports when those flows are in scope.
- Test refund reversal and dispute/chargeback evidence separately from the original capture and refund, including a dispute after a refund and the resulting ledger/reconciliation view when those flows are in scope.
- Confirm idempotency behavior by repeating the same logical mutation with the same key and by rejecting accidental key reuse with changed parameters where the provider supports that check.
- Treat settlement timing, dispute behavior, fees, taxes, and production risk controls as unverified until the actual provider/account configuration supplies evidence.

## Completion evidence

- Payment lifecycle and idempotency decision tied to provider semantics.
- Durable payment/order state, exact money representation, immutable financial-event or ledger model, and recovery/reconciliation decision.
- Test-mode results for success, failure, retry, webhook, and refund paths that were actually exercised.
- Reconciliation evidence, including provider object/report identity and event/audit identity, plus explicit production-only unknowns for any unexercised refund, dispute, fee, tax, settlement, or account behavior.

Use [the maintained source map](references/sources.md) for version-sensitive facts and source conflicts.
