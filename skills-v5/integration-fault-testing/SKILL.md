---
name: integration-fault-testing
description: Test real component boundaries under faults, retries, lifecycle changes, and recovery. Use when integration tests must assert durable effects across a database, queue, process, filesystem, or transport; use reliability-verification for resilience verdicts and deterministic-contract-testing for in-process contracts.
---

# Integration Fault Testing

Prove how collaborating components behave when a real boundary fails, recovers, or produces an ambiguous outcome. Keep the boundary under test real whenever practical: the actual database engine, queue broker, child process, filesystem semantics, wire protocol, or service adapter. Replace only the remote party whose behavior cannot be safely controlled, and make that substitute protocol-faithful.

## Test design

1. **Name the integration contract.** Record the caller, dependency, protocol or storage boundary, runtime versions, ownership of durable state, and the externally observable success/failure effects. Distinguish an operation that is safe to retry from one that can duplicate a side effect.
2. **Control lifecycle explicitly.** Start dependencies in isolated disposable state, wait for actual readiness rather than process creation, and clean up data, processes, networks, and fault rules even when the test aborts. Record container/runtime identities that can change behavior.
3. **Inject one interpretable fault at a time.** Prefer bounded latency, timeout, connection reset, dependency stop/restart, truncated response, duplicate delivery, or loss immediately before/after a commit or acknowledgement boundary. Record exactly where the fault was inserted and whether it affects upstream, downstream, or both directions.
4. **Observe the real boundary.** Assert the client-visible result plus durable state through an independent path. For mutations, inspect committed rows/messages/files and important non-effects; a thrown exception or HTTP status alone is not an oracle.
5. **Exercise ambiguity and replay deliberately.** When a caller can lose the response after the dependency committed, rerun with the same request identity and prove the documented idempotency or deduplication behavior. Bound retries and verify that a dependency outage does not create an unbounded retry storm.
6. **Prove recovery.** Remove the injected fault, wait for dependency readiness, and demonstrate that the same integration can perform useful work again without leaked locks, poisoned connections, stranded transactions, or stale test state.

## Evidence

For each case preserve a boundary/fault matrix containing starting state, injected fault, expected caller result, expected durable state, retry/recovery expectation, and observed evidence. Label simulations precisely; a TCP proxy fault proves behavior at that proxied boundary, not physical device/network resilience.

## Boundaries

- `testing-engineering` owns the overall testing strategy and suite architecture.
- `deterministic-contract-testing` owns deterministic unit/example/schema/state-machine contracts that do not require a real collaborating component.
- `reliability-verification` owns system-level steady-state, degradation, recovery-time, soak, and resilience verdicts. This skill may supply integration-level failure evidence to that verdict.
- `integration-implementation` owns building the integration itself; this skill tests an existing or proposed boundary and its failure semantics.
- Product-specific integrations such as payments still require their domain skill for provider rules; this skill owns the controlled integration-failure experiment.

Use [the maintained source map](references/sources.md) for the fault-injection, lifecycle, retry, and transport guidance behind this workflow.
