# Source map

`performance-testing` owns benchmark/workload design and repeatable measurement evidence. It does not issue the release budget verdict or diagnose the root cause of a measured regression. Formal V5 promotion still requires paired same-model skill/no-skill results and independent blind evaluation.

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: broader testing-engineering; narrower children performance-debugging, performance-verification.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held-out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no-skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **Grafana k6: Open and closed models**: https://grafana.com/docs/k6/latest/using-k6/scenarios/concepts/open-vs-closed/
  - Scope: current documentation available 2026-09-05.
  - Use: workload-model selection and coordinated-omission risk when a closed model reduces offered load as the system slows.
  - Verified: 2026-09-05; refresh after 60 days.
- **Grafana k6: Constant arrival rate**: https://grafana.com/docs/k6/latest/using-k6/scenarios/executors/constant-arrival-rate/
  - Scope: current documentation available 2026-09-05.
  - Use: open-model fixed-rate iteration scheduling, virtual-user capacity, and workload pacing behavior.
  - Verified: 2026-09-05; refresh after 60 days.
- **Grafana k6: Thresholds and built-in metrics**: https://grafana.com/docs/k6/latest/using-k6/thresholds/
  - Scope: current documentation available 2026-09-05.
  - Use: percentile/rate/counter threshold semantics and the distinction between checks and fail-producing thresholds. Thresholds are a tool feature; `performance-testing` may record them but `performance-verification` owns the product/release verdict boundary.
  - Verified: 2026-09-05; refresh after 60 days.
- **Google Benchmark: User Guide**: https://github.com/google/benchmark/blob/main/docs/user_guide.md
  - Scope: user guide available 2026-09-05.
  - Use: minimum measured time, discarded warmup, repetitions, random interleaving, machine metadata, and structured benchmark output for component benchmarks.
  - Verified: 2026-09-05; refresh after 90 days.
- **Google SRE: Monitoring Distributed Systems**: https://sre.google/sre-book/monitoring-distributed-systems/
  - Scope: SRE book guidance available 2026-09-05.
  - Use: latency distributions, traffic, errors, saturation, and the importance of tail latency rather than arithmetic mean alone for skewed service response times.
  - Verified: 2026-09-05; refresh after 365 days.

## Interpretation rules

- Choose workload model from the demand claim. If fixed external arrival demand matters, a closed concurrency loop can hide latency under load by reducing offered traffic.
- Record load-generator limitations and dropped work. A saturated generator invalidates conclusions about the requested service load.
- Separate warmup from measured state and label cold/warm claims explicitly.
- Preserve correctness checks with performance samples. Error responses, partial work, or skipped work must not be interpreted as performance wins.
- Report per-run raw measurements and environment identity. A graph or mean without workload/data/version context is not reusable benchmark evidence.
