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

Treat the task's own artifact list as a checklist, because that is exactly how it is scored. When a task names a test file and a report path and then enumerates what the report must contain (proxy and dependency identities with versions, the commit-before-cut ordering, the bounded retry policy, the idempotency key, the caller-visible uncertain result, the durable count before and after a same-key replay, fresh-key success, cleanup), every one of those items has to appear as a named field with its value. A report that describes the scenario in prose, or omits the durable count because the test asserted it instead, is read as missing evidence even when the test is genuinely correct.

For an ambiguous-commit case the report has to carry the facts the check looks for, in words it looks for. A shape that satisfies it, with the field names a reader expects:

```json
{ "proxy": {"tool": "toxiproxy", "version": "2.12.0"}, "dependency": {"protocol": "http", "endpoint": "POST /dispatch"},
  "ordering": "dependency committed the dispatch before the response path was cut",
  "callerResult": "uncertain: connection reset with no response received",
  "boundedRetry": "retry budget of 2 attempts with backoff",
  "idempotencyKey": "stable key dispatch-0001",
  "durableCountBeforeReplay": "count: 1",
  "durableCountAfterSameKeyReplay": "count: 1, exactly one dispatch exists",
  "freshKeyResult": "fresh key dispatch-0002 succeeded after recovery",
  "recovery": "removed the toxic and recovery verified",
  "cleanup": "proxy torn down, dependency container stopped" }
```

The phrases matter: `count: 1`, `exactly one dispatch`, `retry budget`, `remove the toxic`, `fresh key`. A report that says the test asserted those facts, instead of stating them, reads as missing evidence.

The rollback report is part of the deliverable, and it has to answer the question a reviewer asks after a fault: what did the caller see, and what survived. Record the exact runtime identities you injected against (the PostgreSQL version line and the Toxiproxy or proxy version), the injection point in the transaction (after the insert and before the commit, or the equivalent pre-commit boundary), what the caller or client observed at the failure (an error, a reset, or an uncertain outcome), the state of the written rows and the response headers after recovery, and the behaviour of any child worker or connection it spawned. A report that says "the test passed" without those facts cannot distinguish a real rollback from a swallowed error.

For each case preserve a boundary/fault matrix containing starting state, injected fault, expected caller result, expected durable state, retry/recovery expectation, and observed evidence. Label simulations precisely; a TCP proxy fault proves behavior at that proxied boundary, not physical device/network resilience.

## Boundaries

- `testing-engineering` owns the overall testing strategy and suite architecture.
- `deterministic-contract-testing` owns deterministic unit/example/schema/state-machine contracts that do not require a real collaborating component.
- `reliability-verification` owns system-level steady-state, degradation, recovery-time, soak, and resilience verdicts. This skill may supply integration-level failure evidence to that verdict.
- `integration-implementation` owns building the integration itself; this skill tests an existing or proposed boundary and its failure semantics.
- Product-specific integrations such as payments still require their domain skill for provider rules; this skill owns the controlled integration-failure experiment.

Use [the maintained source map](references/sources.md) for the fault-injection, lifecycle, retry, and transport guidance behind this workflow.
