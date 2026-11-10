# Source map

## Aggregation evidence

- **Histograms and summaries**: https://prometheus.io/docs/practices/histograms/
  - Opened 2026-09-06; refresh within 90 days. Adopt the distinction between aggregatable histogram observations and non-aggregatable precomputed summary quantiles.
  - Adapt this measurement constraint to operational data regardless of telemetry stack. Keep the observation population, time window, and histogram resolution explicit before combining distributions.
  - Reject averaging instance percentiles to claim a fleet percentile. Do not require Prometheus, copy its example buckets, or imply that a histogram estimate has unlimited precision.

Data analysis owns interpretation; `observability-sre` owns changes to the measurement system and `finops-cloud-cost` specializes billing/allocation. No live operational improvement or skill efficacy is established by this content review.

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: broader data-analysis; narrower children finops-cloud-cost.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **NIST/SEMATECH e-Handbook**: https://www.itl.nist.gov/div898/handbook/
  - Scope: NIST/SEMATECH statistical methods handbook as available 2026-09-04
  - Use: statistical-method reference discovery; select a relevant chapter before relying on a specific inferential method.
  - Verified: 2026-09-04; refresh after 365 days.
- **Google SRE book**: https://sre.google/sre-book/table-of-contents/
  - Scope: Google Site Reliability Engineering book as available 2026-09-04
  - Use: operational reference discovery; the table of contents alone does not establish a metric's meaning or aggregation validity.
  - Verified: 2026-09-04; refresh after 365 days.
