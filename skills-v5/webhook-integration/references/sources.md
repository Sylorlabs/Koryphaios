# Source map

## Adopted principles

- Webhook authenticity must follow the provider's exact signing contract. Stripe specifically requires the raw request body, signature header, and endpoint secret for signature verification.
- Duplicate delivery and retry are normal webhook conditions, so consumers need stable event identity and idempotent durable processing.
- Ordering and acknowledgement are provider-specific contracts and must be read from exact provider documentation rather than assumed from generic webhook folklore.
- Replay rejection, duplicate suppression, and durable idempotency are different guarantees. A timestamp tolerance can reject old signed deliveries, while a duplicate set kept only in memory demonstrates behavior for one process lifetime; durable safety under at least once delivery needs persisted event and side effect state or durable handoff evidence.
- Treat a narrow endpoint repair as one slice of the operating contract. Provider facts that are outside the immediate bug still stay explicit as known, simulated, unavailable, or unresolved rather than disappearing from the completion claim.
- Completion evidence must surface that contract inventory and the status of reorder, retry/timeout, downtime recovery, schema-version, restart-durability, and reconciliation checks. A locally passing receiver regression suite does not make omitted provider lifecycle evidence implicitly complete.

## Conditional recipes

- Stripe is retained as a concrete source for signed-webhook mechanics, but Stripe's headers, retry behavior, and tooling are not universal webhook standards.
- Queue-first acknowledgement, database-first acknowledgement, replay windows, reconciliation polling, and schema registries are conditional implementation patterns.
- Durable inbox or event ledger rows, uniqueness constraints, transactional side effect recording, and durable queue handoff are topology dependent ways to establish idempotency across restarts. Do not infer that property from a cache or `Set` local to one process.

## Verification scope

Provider documentation establishes its signing and delivery contract. It does not prove the application's raw-body preservation, idempotency, queue durability, timeout behavior, local state reconciliation, or another provider's semantics. Verify those at the actual endpoint and provider boundary.

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: broader integration-implementation.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **Stripe webhook signatures**: https://docs.stripe.com/webhooks/signature
  - Scope: Stripe webhook documentation checked 2026-09-06.
  - Use: raw request body, signature header, endpoint secret, and verification failures.
- **Stripe webhooks**: https://docs.stripe.com/webhooks
  - Scope: Stripe webhook documentation checked 2026-10-03.
  - Use: Stripe-specific event delivery, retries, endpoint behavior, and testing guidance.
