---
name: payment-integration
description: Engineer payment integrations with explicit money, idempotency, authorization, capture, refunds, disputes, ledgers, webhooks, and reconciliation. Use when the request specifically requires payment integration, payment processor, checkout payment, payment webhook; prefer a narrower child only when its boundary is established.
---

# Payment Integration

## Responsibility

Model currency/minor units, payment intent/order identity, customer/payment-method ownership, authorization/capture, asynchronous states, idempotency keys, refunds, disputes, fees, taxes, and internal ledger/reconciliation. Treat provider state as external evidence, not the sole business ledger.

Verification focus: Use provider test modes for success, decline, authentication, timeout, duplicate submission, delayed webhook, refund/partial refund, dispute-like states, and reconciliation against provider reports before production changes.

Failure boundaries: Do not store raw card secrets, compute money in binary floating point, mark paid solely from client redirects, or retry charges without idempotency and provider-state checks.

## Hierarchy and routing

- Broader skills: integration-implementation.
- No narrower bundled child is declared.
- Cross-cutting facets: application-security.
- Required skills: verification.

## Decision rules

- Keep money in exact currency-aware units and preserve provider object identity across retries, redirects, webhooks, refunds, and reconciliation.
- Model payment state as an asynchronous lifecycle. A client redirect or a single HTTP response is not sufficient evidence that funds are durably paid or settled.
- Use provider-supported idempotency for retriable mutations and bind a key to one logical operation. Reusing a key across different parameters is a correctness error.
- Keep provider state and the internal order or ledger model distinct. Reconcile them explicitly when external events can arrive late, duplicate, or out of order.
- Minimize payment-data scope. Do not store raw card secrets when provider-hosted or tokenized mechanisms meet the requirement.

## Observable checks

- Exercise success, decline, authentication-required, timeout, duplicate submission, and safe retry in the provider's supported test environment.
- Verify webhook-driven state changes independently from client return flows, including delayed and duplicate events.
- Test full and partial refunds plus reconciliation against provider-reported objects or reports when those flows are in scope.
- Confirm idempotency behavior by repeating the same logical mutation with the same key and by rejecting accidental key reuse with changed parameters where the provider supports that check.
- Treat settlement timing, dispute behavior, fees, taxes, and production risk controls as unverified until the actual provider/account configuration supplies evidence.

## Completion evidence

- Payment lifecycle and idempotency decision tied to provider semantics.
- Test-mode results for success, failure, retry, webhook, and refund paths that were actually exercised.
- Reconciliation evidence plus explicit production-only unknowns.

Use [the maintained source map](references/sources.md) for version-sensitive facts and source conflicts.
