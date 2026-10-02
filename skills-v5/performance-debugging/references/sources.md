# Source map

`performance-debugging` is individually authored. Promotion still requires clean routing, paired same-model skill/no-skill full-task evidence, independent blind evaluation, and regression closure.

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: broader debugging, performance-testing; narrower children database-performance, gpu-compute.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held-out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no-skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **Google SRE: Effective Troubleshooting**: https://sre.google/sre-book/effective-troubleshooting/
  - Scope: chapter as available 2026-09-04.
  - Use: profiling and evidence-led narrowing from visible latency/resource symptoms to a causal bottleneck.
  - Verified: 2026-09-04; refresh after 180 days.

- **Google SRE: Monitoring Distributed Systems**: https://sre.google/sre-book/monitoring-distributed-systems/
  - Scope: chapter as available 2026-09-04.
  - Use: latency distributions, traffic, errors, saturation, and the fact that systems can degrade before nominal 100% utilization.
  - Verified: 2026-09-04; refresh after 180 days.

## Interpretation rules

- Compare equivalent builds/workloads/configurations and record warm-up, data, concurrency, and resource envelopes before calling a difference a regression.
- Use distributions/percentiles and repeated runs where variance matters; averages alone can hide tail regressions.
- Profile/account before optimizing. A hot function is not automatically causal if the system is queueing, blocked on I/O, or saturated elsewhere.
- Distinguish allocation/high-water memory from retained live growth after completed work before declaring a leak.
- Preserve correctness checks and report uncertainty/variance; faster but semantically different behavior is not a valid improvement.
