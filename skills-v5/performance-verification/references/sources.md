# Source map

`performance-verification` is individually authored as a verdict/gate skill; empirical qualification is tracked separately in the audit/evaluation ledger. Its sources support measurement semantics and evidence validity; they do not replace the repository's own workload, budgets, correctness contract, or environment identity.

## Maintained authoritative sources

### Google SRE: Monitoring Distributed Systems

- Source: https://sre.google/sre-book/monitoring-distributed-systems/
- Scope: online SRE Book chapter as verified 2026-09-05.
- Use here: service-level evidence should cover latency, traffic, errors, and saturation. Successful and failed requests can have materially different latency and should not be merged in a way that hides failures.
- Boundary: this is monitoring guidance, not a universal benchmark protocol and not permission to substitute SLOs for the user's declared release budgets.

### Grafana k6 2.2.x: Thresholds

- Source: https://grafana.com/docs/k6/latest/using-k6/thresholds/
- Scope: k6 documentation current on 2026-09-05; k6 2.2.0 was the current released line and 2.3.0 was scheduled for later in September 2026.
- Use here: k6 thresholds formalize pass/fail criteria over measured metrics, including percentile latency and error-rate conditions. This directly supports the distinction between measuring a workload and judging a declared gate.
- Boundary: k6 syntax is tool-specific. The skill uses the gate semantics even when the repository uses another harness.

### Google Benchmark v1.9.5: User Guide

- Source: https://github.com/google/benchmark/blob/v1.9.5/docs/user_guide.md
- Revision: `v1.9.5`.
- Use here: explicit warmup time is discarded before reported measurements; repeated runs can report mean, median, standard deviation, and coefficient of variation; randomized interleaving can reduce bias from changing system state.
- Boundary: Google Benchmark is a microbenchmark library. Its warmup/repetition controls are strong evidence for measurement hygiene, not a reason to force microbenchmark methodology onto end-to-end service, UI, device, or batch gates.

## Practitioner pattern

### Brendan Gregg: USE Method

- Source: https://www.brendangregg.com/usemethod.html
- Scope: practitioner methodology as verified 2026-09-05.
- Use here: for resources that could cap the measured result, check utilization, saturation, and errors. This is especially valuable for detecting a saturated application host, storage/network path, or load generator that would invalidate a performance comparison.
- Boundary: USE is primarily an investigation/checklist method. It does not define acceptance thresholds unless the product contract already declares them, and detailed bottleneck diagnosis remains `performance-debugging`.

## Interpretation and precedence

1. The user's/repository's declared workload, environment, correctness invariants, metric definitions, and budgets control the verdict.
2. Prefer versioned official or reference-implementation behavior for harness-specific mechanics.
3. Use community patterns to expose measurement validity risks, not to invent missing budgets or universal resource limits.
4. A setup phase is not automatically a warmup phase. Treat samples as warmup only when the benchmark protocol declares them non-measured and excludes them from the gate statistics.
5. Do not compare baselines across materially different hardware/VM shape, build mode, runtime, dataset/cache state, concurrency, or load profile and then claim a causal speedup.
6. Preserve uncertainty. If a threshold, representative workload, equivalent baseline, or correctness oracle needed for a claim is unavailable, that claim is `INCONCLUSIVE`, not silently passed.
