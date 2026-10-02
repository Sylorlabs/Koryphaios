---
name: performance-verification
description: Verify a change against an explicit performance claim or budget using comparable measurements. Use when latency, throughput, resource use, startup, or frame time determines acceptance or release readiness; use performance-testing for benchmark design and performance-debugging for bottleneck diagnosis.
---

# Performance Verification

Performance verification answers a decision question: **does the observed system satisfy the declared performance contract under the declared workload and environment?** It owns the evidence-to-verdict gate. It does not own invention of a benchmark program when no acceptance claim exists, and it does not turn a failing gate into a root-cause investigation unless the user also asks for diagnosis.

## Establish the performance contract first

Before measuring, record the claim in terms that can be falsified:

- **Workload identity:** operation mix, arrival rate or concurrency, request/record sizes, dataset cardinality and state, cache state, think time, burst/steady shape, and test duration.
- **Environment identity:** candidate and baseline build or commit, build mode, runtime/compiler and important dependency versions, OS/kernel where material, hardware or VM shape, CPU/memory limits, power/frequency policy where material, storage/network class, and load-generator placement/capacity.
- **Measured state:** separate setup and warmup from measured samples. Treat cold-start or cold-cache behavior as its own metric when the claim includes it; otherwise do not mix it into steady-state distributions.
- **Gate metrics:** use the declared metrics and thresholds. For request-oriented systems this commonly includes p50/p95/p99 latency (or the explicitly declared percentiles), throughput/traffic, error rate, and resource utilization/saturation. For batch, UI, mobile, or embedded work, use the declared equivalents such as wall time, items/sec, frame time, startup time, energy, peak/retained memory, or device resources.
- **Correctness under load:** preserve functional invariants while measuring. A faster response with wrong, stale, dropped, duplicated, or incomplete output fails verification even if every timing threshold passes.

Do not invent a missing budget merely to produce a binary result. If the acceptance threshold, workload, or environment identity needed for the claim is absent and cannot be established from supplied artifacts, return `INCONCLUSIVE` for that claim and state exactly what evidence is missing.

## Run comparable measurements

Use the repository-supported harness when one already exists. Keep warmup/setup evidence visible, but exclude it from measured steady-state statistics unless the contract says otherwise. Use representative data and concurrency; a single-user toy dataset cannot prove a multi-user production gate.

Repeat measured runs enough to expose noise and report the per-run values plus a declared aggregate and variance measure. Do not cherry-pick the best run. If the harness supports interleaving or randomized ordering of candidate and baseline repetitions, prefer it when drift in machine state could bias a comparison.

For a baseline comparison, require material equivalence of workload, data, concurrency, environment, and measurement procedure. A baseline from a different instance class, build mode, runtime, dataset, cache state, or load profile cannot establish a relative speedup. It may still be useful context, but label the comparative claim inconclusive unless an equivalent baseline is available.

Capture enough resource evidence to distinguish a product result from a saturated test rig. At minimum inspect the resources that can cap the claimed metric: application CPU/memory, queues or scheduler saturation, storage/network where relevant, and load-generator capacity. Resource evidence supports the validity of the gate; causal profiling belongs to `performance-debugging`.

## Decide the gate

Map every declared claim to an observable metric and threshold, then issue one of three bounded outcomes:

- `PASS`: all required thresholds and correctness invariants pass across the declared comparison rule.
- `FAIL`: at least one required threshold or correctness invariant fails. Do not average away a percentile, error, or resource budget that the contract declares independently.
- `INCONCLUSIVE`: required evidence is not comparable, representative, or available enough to judge the claim.

Report workload/environment identity, warmup versus measured state, p50/p95/p99 or the declared metric set, throughput/traffic, errors, relevant resources, repeat-run variance, baseline comparability, correctness results, and the exact reason for the verdict. Preserve raw artifacts when the harness emits them.

## Boundary with adjacent performance skills

- `performance-testing` owns designing or extending reusable benchmarks, load profiles, generators, and test strategy when the main request is how to measure.
- `performance-debugging` owns explaining why an observed metric regressed, profiling the bottleneck, changing code, and proving the causal fix.
- `performance-verification` may execute an existing benchmark or load test, but its output is the acceptance verdict against a declared claim.

When a request combines these concerns, keep the evidence boundaries explicit: establish the gate here, let testing own harness design, and let debugging own diagnosis/remediation.

## Concrete scenarios

**API release gate.** The release contract is 400 requests/sec at concurrency 40 on a fixed 1-million-record dataset, after a 2-minute warmup, with three 5-minute measured runs. Required gates are p95 <= 180 ms, p99 <= 350 ms, error rate < 0.5%, delivered throughput >= 395 requests/sec, no application CPU budget violation, and response correctness under load. Record the exact candidate/baseline builds and host limits. A candidate that meets p95 and throughput but records p99 values above 350 ms fails; do not hide the tail breach inside an average.

**Batch export gate.** A streaming exporter must process the fixed 20 GiB corpus at >= 180 MiB/s, improve throughput by >= 20% over an equivalent prior release, keep peak RSS <= 1.5 GiB, produce zero failed records, and match the reference output hash. Run the declared warmup separately, repeat the measured corpus five times at concurrency 8, and compare only with the baseline collected on the same host/runtime/build mode and corpus. A faster candidate that exceeds the memory budget fails even when the relative throughput claim passes.

Read [references/sources.md](references/sources.md) when selecting measurement semantics, percentile/gate behavior, repeat-run handling, or resource-validity checks.
