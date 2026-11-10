---
name: performance-debugging
description: Debug latency, throughput, memory, allocation, energy, frame, or resource regressions with controlled measurement and profiling. Use when observed performance changed or violates a budget and the bottleneck or retained resource is not yet established.
---

# Performance Debugging

Reproduce the symptom under a controlled representative workload before optimizing. Record the target metric, percentile or distribution, workload shape, dataset/state, warm-up, build/runtime/configuration, hardware/resource envelope, and a comparable baseline. A benchmark that changes several of these at once cannot establish a regression.

Profile or account for the dominant resource before changing code. Separate startup from steady state and distinguish CPU, allocation/GC, memory retention, lock/contention, I/O, network/dependency time, queueing, saturation, caching, and cleanup. For latency, examine distributions and tails rather than relying only on averages. For leaks, distinguish high-water allocation from retained/live growth after completed work.

Form a falsifiable bottleneck hypothesis from the profile, make the narrow correction, then compare equivalent before/after runs with enough repetitions to expose variance. Preserve correctness checks; a faster result that changes semantics is not a performance fix.

Keep measurement provenance attached to every claimed number: workload/configuration identity, warm-up and repetition count, metric definition, runtime/resource envelope, and the retained benchmark or profile receipt. Distinguish evaluator- or harness-owned measurements from observations run by the current task. Do not fill an unavailable profile, allocation probe, or post-fix retest with plausible numbers, and do not claim a percentile when the retained sample set is empty. A source diff plus a later independent benchmark can support the implementation, but it does not turn unexecuted candidate measurements into observed results.

When the system is near capacity, relate latency/throughput changes to traffic and saturation rather than attributing the symptom to a hot function in isolation. When performance depends on an external database/service, use the relevant domain skill for its internal evidence while this skill owns the end-to-end measurement and causal comparison.

Use parent `debugging` for overall root-cause/fix/regression discipline and `performance-testing` for designing reusable benchmark/load infrastructure when there is no current regression to diagnose. Route races/deadlocks to `concurrency-debugging` and correctness failures spanning services to `distributed-debugging`.

Use [the maintained source map](references/sources.md) for performance signals and troubleshooting evidence.
