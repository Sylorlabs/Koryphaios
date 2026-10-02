# Source map

`distributed-debugging` is individually authored. Promotion still requires clean routing, paired same-model skill/no-skill full-task evidence, independent blind evaluation, and regression closure.

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: broader debugging.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held-out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no-skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **Google SRE: Effective Troubleshooting**: https://sre.google/sre-book/effective-troubleshooting/
  - Scope: chapter as available 2026-09-04.
  - Use: system understanding, hypothesis testing, causal reduction, and evidence-led troubleshooting.
  - Verified: 2026-09-04; refresh after 180 days.

- **W3C: Trace Context Recommendation**: https://www.w3.org/TR/trace-context/
  - Scope: stable W3C Trace Context Recommendation as available 2026-09-04.
  - Use: interoperable propagation of a logical trace identity across distributed components. The skill generalizes the identity principle to queues and non-HTTP protocols; it does not require `traceparent` where the system uses another stable correlation scheme.
  - Verified: 2026-09-04; refresh after 365 days.

## Interpretation rules

- Correlate stable request/message/entity identities and versions before using timestamps to infer sequence.
- Distinguish send, acknowledgement, durable commit, processing, and observation boundaries explicitly.
- Treat retries, duplicates, redelivery, partitions, stale reads, and version skew as concrete hypotheses only when the system contract permits them.
- Missing telemetry is uncertainty, not evidence that a boundary succeeded. Add the minimum correlation/version signal needed to falsify the leading hypotheses.
- Verify retry, replay, idempotency, reconciliation, or rejection of stale state in the recovery path, not only the nominal path after a fix.
