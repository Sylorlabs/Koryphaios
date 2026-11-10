# Source map

## Adopted principles

- Retriable payment mutations need an idempotency contract tied to one logical operation. Stripe documents stable results for repeated requests with the same idempotency key.
- Payment state is lifecycle state, not a single redirect outcome. Stripe's PaymentIntent documentation makes asynchronous status transitions explicit.
- Webhook authenticity and raw request handling are part of payment-state correctness when webhooks drive fulfillment or reconciliation.

## Conditional recipes

- Stripe PaymentIntents are a Stripe-specific lifecycle mechanism, not a universal payment architecture.
- Stripe currently recommends Checkout Sessions with the Payment Element for many integrations. That recommendation is conditional on Stripe and the product requirements and is not imposed by this skill.
- Provider test mode, hosted checkout, capture strategy, subscription models, and ledger design remain provider and product decisions.

## Verification scope

Provider documentation establishes API semantics and supported test mechanisms. It does not prove merchant-account settings, settlement timing, tax treatment, dispute outcomes, fee configuration, or production fraud behavior. Keep those claims scoped to evidence from the configured account and exercised environment.

The package's current deterministic payment scenarios are synthetic pure-function traces. They exercise a narrow idempotency/reconciliation projection and authenticated-event ordering, but do not by themselves establish durable database transactions, restart recovery, exact-money persistence, provider report reconciliation, refund/dispute lifecycle behavior, or an internal ledger. A passing fixture is evidence only for the stated synthetic contract; production lifecycle claims require the corresponding repository, provider test-mode, and persistence evidence, or must be labeled unavailable.

All four specific URLs below were reopened on 2026-11-07 and registered in `kory.json`; refresh within 60 days. The broader payments landing page was rechecked on 2026-10-03 and remains a discovery source for integration options, payment methods, and build/test entry points. Lifecycle, idempotency, and webhook semantics remain bound to the specific sources below. These API examples are adapted patterns, not a mandate to switch an existing provider or a claim of successful payment execution.

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: broader integration-implementation.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **Stripe payments**: https://docs.stripe.com/payments
  - Scope: Stripe payments landing page inspected 2026-11-03.
  - Use: discovery for online and in-person payment integrations, subscriptions, payment methods, and build/test documentation.

- **Stripe idempotent requests**: https://docs.stripe.com/api/idempotent_requests
  - Scope: Stripe API documentation checked 2026-11-07.
  - Use: retry safety, key reuse, and parameter-consistency semantics.
- **Stripe PaymentIntent lifecycle**: https://docs.stripe.com/payments/paymentintents/lifecycle
  - Scope: Stripe payments documentation checked 2026-11-07.
  - Use: asynchronous payment states and Stripe-specific integration guidance.
- **Stripe webhook signatures**: https://docs.stripe.com/events/manage-webhook-endpoints
  - Scope: Stripe webhook documentation checked 2026-11-07.
  - Use: signature verification and raw request-body requirements.
- **Stripe webhooks**: https://docs.stripe.com/webhooks
  - Scope: Stripe webhook documentation checked 2026-11-07.
  - Use: delivery and event-handling lifecycle reference.
