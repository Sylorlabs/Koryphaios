---
name: reliability-verification
description: Verify that a completed system preserves defined service, durability, degradation, and recovery contracts under representative interruption, restart, replay, dependency loss, overload, or sustained operation. Use when the task calls for a reliability test, fault recovery, soak test, resilience verification, or outage-recovery evidence.
---

# Reliability Verification

Reliability evidence starts from an explicit contract: what must remain available or durable, what may degrade, what recovery objective applies, and which failure domain is in scope. Exercise controlled failures in an isolated environment unless the user explicitly supplies an approved production experiment with safety controls.

## Verification workflow

1. **Define steady state and invariants.** Record workload, capacity, health signals, durability/ordering/idempotency rules, availability/degradation expectations, RTO/RPO or other recovery thresholds, and exact success metrics before disturbing the system.
2. **Choose representative disturbances.** Test failures justified by the architecture: process restart, dependency timeout/unavailability, connection reset, delayed response, broker/database restart, duplicate delivery/replay, loss of one replica, resource pressure, or abrupt load change. Do not inject arbitrary chaos merely to create activity.
3. **Observe during the event.** Measure useful work, errors, latency, queue depth/backlog, retry amplification, rejected/degraded responses, resource saturation, health signals, and correctness of durable state. Confirm noncritical dependency loss does not become an accidental critical dependency.
4. **Verify recovery, not only survival.** Remove the disturbance and measure time to stable service, backlog drain, cache/warmup behavior, duplicate/lost work, state convergence, cleanup, and whether manual intervention was required. A service that remains degraded indefinitely has not passed recovery.
5. **Test restart and replay semantics.** For stateful workers, distinguish delivery labels from observed behavior. Restart around acknowledgement or commit boundaries and verify idempotency/deduplication rather than assuming exactly-once semantics.
6. **Add sustained evidence when the claim requires it.** Soak long enough to expose resource retention, queue growth, lease/token expiry, periodic jobs, or cumulative drift, with stable workload and periodic invariant checks. Do not extrapolate a short smoke run into a long-duration claim.
7. **Report a bounded verdict.** Attach the disturbance matrix, timeline, recovery metrics, state-integrity checks, and untested failure domains. Distinguish infrastructure/test-harness failure from product failure.

`integration-fault-testing` can design reusable lower-level failure fixtures; `performance-verification` owns quantitative capacity/latency budgets; `incident-response` owns live incident handling. Reliability verification integrates the evidence needed to decide whether the declared resilience/recovery contract holds.

Use [the maintained source map](references/sources.md) for current reliability-testing and recovery guidance.
