---
name: deterministic-contract-testing
description: Build deterministic unit, schema, transition, and compatibility tests with controlled time and explicit oracles. Use when fixed examples or regressions establish behavior; use property-fuzz-differential-testing for generated exploration and integration-fault-testing for real component boundaries.
---

# Deterministic Contract Testing

Own the smallest repeatable test boundary that can falsify a concrete behavioral contract. A useful deterministic test fixes the relevant input and state, exercises a supported public or local contract, and has an oracle that distinguishes the intended behavior from a plausible defect. Keep the parent `testing-engineering` discipline responsible for whole-suite strategy and boundary selection across testing layers. Treat a synthetic fixture as a controlled test surface, not as evidence that the corresponding deployed service, database, broker, process, or provider qualifies.

## Build the contract case

1. **Recover the observable contract.** Identify the public result, error taxonomy, serialized form, schema rule, compatibility promise, or state transition that must remain true. State the defect the case should catch before choosing assertions.
2. **Partition the behavior.** Choose representative examples for materially different equivalence classes. Include boundary values such as empty versus absent versus null, minimum/maximum and just inside/just outside values, exact threshold equality, malformed or unknown enum values, Unicode or locale-sensitive values when relevant, and old/new versions covered by a compatibility promise.
3. **Make nondeterminism explicit.** Inject or otherwise control the clock, time zone, random source, generated identifiers, environment, and ordering when they affect the contract. Prefer a fixed/advancing clock to sleeps or assertions against wall time. For pseudorandom behavior, use an injected deterministic source or a documented algorithm plus seed; record the runtime/version when an exact sequence matters. Do not pretend an operating system entropy source or unspecified PRNG is reproducible.
4. **Choose a behavioral oracle.** Assert externally meaningful values, errors, state, or serialized data. Prefer public APIs and state verification over private helper calls or collaborator call order. Assert an interaction only when that interaction is itself the contract. Avoid opaque whole-object snapshots when a smaller semantic assertion explains the protected rule.
5. **Exercise transitions and compatibility deliberately.** For state machines, cover legal transitions, forbidden transitions, terminal states, idempotent repeats, and observable side effects. For schemas and wire formats, pin the dialect/protocol version and distinguish syntax validity from the application compatibility promise. Test both a valid old example that must keep working and an almost invalid example that must stay rejected when compatibility is material.
6. **Prove the regression can fail.** When practical, run the new case against the known bad revision or a focused controlled mutation. A boundary test for `>=` should fail if the comparison is changed back to `>`; a strict-schema test should fail if the relevant constraint is removed. Treat mutation as evidence that the oracle detects the targeted fault, not as a universal score target; equivalent or irrelevant mutants do not prove missing coverage.
7. **Run reproducibly and preserve evidence.** Run the focused test using the repository-supported command, rerun when needed to expose hidden dependence on global state, and record the relevant runtime, clock/seed fixture, clean fixture identity, command, and result. A retry until green loop is not evidence of determinism.

## Oracle patterns

- **Pure or narrow unit:** exact return value, canonical error, or state change for a representative input partition.
- **Parser/serializer:** semantic decoded value, canonical encoding when promised, and explicit malformed-input rejection; use round trips only when round-trip equivalence is actually the contract.
- **Schema:** acceptance and rejection under the declared schema dialect, plus compatibility examples from versions the product promises to support.
- **State machine:** `(state, event) -> next state + effects`, including illegal and repeated events.
- **Local API/contract adapter:** status/result/error shape and semantic payload at the in process boundary. If correctness depends on a real server, database, broker, filesystem, or process behavior, move that claim to `integration-fault-testing`.

## Evidence boundary

- **Deterministic fixture evidence:** a materialized local fixture, controlled clock or nonce source, fixed examples, public-result assertions, mutation red/green result, and repeated focused command establish only the contract exercised inside that fixture. Record the fixture identity, source/runtime version, command, and whether each result was observed or unavailable.
- **Real qualification evidence:** a deployed or repository-owned target, real dependency or process boundary when the claim needs one, paired same model skill/no skill execution, and independent blind evaluation are separate requirements. A local scorer, synthetic materializer, passing starter check, or authored routing case cannot substitute for them.
- **Keep claims partitioned:** say `synthetic/local boundary` for fixture results and `unavailable: real qualification not run` when those broader checks were not performed. Do not report a deterministic fixture as broker, database, network, provider, end to end, paired, or blind review evidence.

## Deliverable contract

Return a compact case matrix mapping each contract partition to its input, oracle, expected result, and protected defect. Include the exact focused command and result, runtime identity, controlled fixture identity, and any mutation red/green or repeatability result. For a local only fixture, include an explicit boundary disclosure and list the real-runtime or qualification evidence that remains unavailable; do not manufacture those artifacts.

## Specialist boundaries

- Use `property-fuzz-differential-testing` when the evidence depends on generated inputs, broad input-space exploration, shrinking, metamorphic properties, or comparison against another implementation. A fixed seed that reproduces one discovered counterexample can become a deterministic regression here after discovery.
- Use `integration-fault-testing` when the risk lives in a real component boundary, transport, database engine, process lifecycle, restart/recovery path, or injected infrastructure fault. A mock of that boundary does not establish real integration behavior.
- Use `deterministic-debugging` when the defect is repeatable but its cause is still unknown; locate the first causal divergence before turning the minimized reproducer into a regression test.
- Use `verification` or `functional-verification` when tests already exist and the primary task is to decide whether a completed change is actually correct through fresh acceptance evidence rather than to design new durable coverage.

## Stop and evidence conditions

Stop when every material contract in scope has a falsifiable case, relevant boundaries are represented, nondeterministic inputs are controlled at a faithful seam, the focused suite passes reproducibly, and the evidence record distinguishes observed fixture results from unavailable real-runtime or qualification results. Escalate instead of adding mocks when the remaining claim requires a real dependency or generated input space.

Return a contract-to-case mapping, exact test command/results, clock/seed/runtime identity when relevant, and red/green or mutation evidence for regressions when practical. Label any simulated boundary explicitly and keep completion claims no broader than the behavior the deterministic tests exercised.

Use [the maintained source map](references/sources.md) for versioned schema/API rules, clock and PRNG behavior, and the provenance behind the testing patterns above.
