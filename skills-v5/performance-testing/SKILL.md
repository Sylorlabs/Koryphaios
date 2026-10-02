---
name: performance-testing
description: Design reproducible benchmarks with representative workloads, latency distributions, throughput, resource use, and variance. Use when building or running performance tests; use performance-verification for release-budget verdicts and performance-debugging to diagnose regressions.
---

# Performance Testing

Build measurements that another engineer can rerun and interpret. A benchmark is a protocol: workload, environment, dataset, pacing model, warmup, measurement window, correctness oracle, resources, repetition policy, and raw artifacts. A single timing number is not a benchmark.

## Benchmark protocol

1. **Name the user/system consequence.** Decide what is being measured and why: request latency/throughput, startup, frame time, memory, CPU/GPU utilization, energy, queue delay, or a component operation. State whether the claim is cold, warm, burst, sustained, or limit behavior.
2. **Freeze identity.** Record build/commit and optimization mode, hardware/VM/container shape, OS/kernel/runtime, dependency versions, power/performance mode, dataset/cardinality, topology, cache state, and benchmark-tool version. Do not compare results from materially different environments as if they were one baseline.
3. **Choose a workload model that preserves demand.** For service arrival-rate claims, prefer an open workload model when slowing responses must not reduce offered request rate; record scheduled/started/completed and dropped iterations. For closed/concurrency workloads, state that the achieved arrival rate depends on response time.
4. **Separate warmup from measurement.** Warm caches/JITs/pools only when the target claim is warm steady state, and discard warmup samples. Measure cold behavior separately when it matters. Avoid arbitrary sleeps that change an arrival-rate model.
5. **Measure distributions and correctness.** Preserve p50/p95/p99 or the exact relevant distribution, achieved throughput, error rate, and resource/saturation signals. Validate representative responses/state under load; faster wrong responses are failures, not improvements.
6. **Repeat and report variance.** Run independent repetitions when noise or regression size warrants it. Preserve per-run results, median/mean as appropriate, spread/standard deviation or confidence summary, and notable environmental drift. Interleave baseline/candidate runs when long-term machine state can bias a sequential comparison.
7. **Keep raw artifacts.** Save workload configuration, exact command/tool version, machine identity, per-run raw output, and correctness/error evidence. A summarized chart without raw counts and workload identity is insufficient for regression evidence.

## Measurement pitfalls

- Avoid averages alone for skewed latency; tail percentiles can expose user-visible saturation hidden by a mean.
- Watch coordinated omission: if the load generator waits for a slow response before scheduling the next request, it can under-sample the periods users would have experienced under fixed arrival demand.
- Track load-generator saturation too. Dropped iterations, exhausted virtual users, client CPU/network limits, or telemetry backpressure can make the benchmark measure the harness instead of the system under test.
- Microbenchmarks prove a small operation under an artificial harness; label them as such and do not generalize to end-to-end product latency without supporting evidence.

## Boundaries

- `performance-verification` consumes a defined benchmark and explicit budget/baseline rule to issue a pass/fail verdict. This skill designs/runs the measurement protocol and produces the reusable evidence.
- `performance-debugging` explains why a measured regression exists using profiles/traces/counters; do not guess a cause from benchmark output alone.
- `database-performance` owns query plans, indexes, lock/I/O diagnosis, and database-specific tuning after a benchmark localizes the bottleneck there.
- `testing-engineering` owns the broader suite/CI strategy and when benchmarks should run.

Use [the maintained source map](references/sources.md) for open/closed load semantics, current k6 threshold/metric behavior, benchmark warmup/repetition controls, and SRE latency/saturation guidance.
