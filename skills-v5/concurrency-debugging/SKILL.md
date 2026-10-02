---
name: concurrency-debugging
description: Debug races, deadlocks, lost updates, ordering, cancellation, and shared-state failures by reconstructing actors and happens-before relationships. Use when behavior depends on thread, task, callback, or async interleaving rather than one deterministic input path.
---

# Concurrency Debugging

Model actors, shared resources, ownership, synchronization, cancellation, and teardown before changing code. Capture or force useful schedules with barriers, deterministic schedulers, stress loops, race detectors, traces, or lock diagnostics as appropriate to the runtime.

Express the suspected defect as an ordering or ownership invariant, then produce evidence that rules schedules in or out. A run that happens not to reproduce a race is not evidence of correctness. Avoid arbitrary sleeps as synchronization or as proof that a fix works.

Before changing the synchronization or state transition, drive the original implementation through the smallest controlled schedule that is supposed to expose the defect and record the observed actors, reads, writes, revisions, waits, and final state. When more than one completion order matters, exercise each required order before the fix and distinguish an observed failure from an order that remains correct. Do not replace missing pre fix execution with a reconstructed narrative when the fixture or runtime can actually drive the schedule.

After the repair, turn the controlled schedule into maintained regressions and rerun every relevant alternate order plus a nonoverlapping control. When the task or evidence contract asks for stress evidence, add a bounded repeated schedule or the runtime appropriate race detector in addition to deterministic regressions. Report stress or detector evidence as unavailable when the environment cannot support it instead of silently substituting one deterministic run.

For deadlocks, record the wait-for relationship and lock/resource ordering. For lost updates or double completion, identify the contested transition and define which actor owns the terminal state. Preserve a causal schedule as a regression when possible, and add stress/race-detector evidence when it materially increases confidence.

Use parent `debugging` for the overall root-cause/fix/regression structure. Route fully deterministic single-path defects to `deterministic-debugging`, cross-service causal reconstruction to `distributed-debugging`, and resource/latency measurement to `performance-debugging`.

Use [the maintained source map](references/sources.md) for evidence limits and tool guidance.
