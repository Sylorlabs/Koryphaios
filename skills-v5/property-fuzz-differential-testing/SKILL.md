---
name: property-fuzz-differential-testing
description: Explore input and operation spaces with property, fuzz, differential, model, or metamorphic tests and reproducible shrinking. Use when generated cases, invariant checks, or independent implementations supply the oracle; use deterministic-contract-testing for fixed examples alone.
---

# Property Fuzz Differential Testing

Own generated-space exploration. Turn a large value/state space into an explicit domain, falsifiable properties, and an oracle capable of exposing failures that fixed examples are unlikely to cover. `testing-engineering` still owns the overall layer/coverage strategy.

## Operating contract

1. **Define the domain before the generator.** Separate semantically valid, intentionally invalid, ambiguous, and out-of-scope values. Encode grammar/state preconditions plus size, depth, memory, time, and concurrency ceilings. Prefer structure-aware generation for structured inputs; raw bytes fit only when bytes are the real production contract. Validate the classification after the complete value is composed: independently invalid fragments can concatenate into a valid token, escape, encoding, or state sequence. An invalid-domain generator must prove its final output still violates the intended predicate. High discard rates usually mean the generator is wrong.
2. **State a falsifiable property and equivalence.** Examples include round trip, idempotence/canonicalization, conservation, monotonicity/order, inverse operations, model/state-machine invariants, or agreement between implementations. Say whether equality is byte, semantic, normalized, error-class, or state/effect equivalence.
3. **Use an oracle whose independence is justified.** Differential testing is informative only when compared implementations are sufficiently independent; disagreement is not proof that either side is correct. When exact outputs are unavailable, use a small executable model, specification-backed implementation, justified metamorphic relation, or complementary independent oracle. Preserve unresolved disagreements as evidence.
4. **Make replay and shrinking part of the proof.** Record framework/runtime identity and the failing input plus seed/reproduction token where meaningful. Keep the target deterministic per input; ambient time, entropy, mutable shared state, and race-sensitive ordering can invalidate replay. Shrink while preserving the same domain and failing predicate. Say “shrunk” or “locally minimal” unless global minimality was actually established.
5. **Bound and report the search honestly.** Set explicit case/time/input/depth/resource limits. Coverage shows reached code, not correctness or exhaustiveness; a plateau is not proof of completeness. Report important unreachable partitions, generator bias, discards, timeouts/OOM, missing sanitizers, and nondeterminism.
6. **Keep discoveries durable.** Preserve useful seed corpora when supported and promote minimized failures (or stable semantic equivalents) into the ordinary regression path. A framework cache or opaque replay artifact must not be the only durable proof when upgrades can invalidate it.

## Campaign patterns

- **Property/stateful testing:** derive generators from the domain model, bias boundaries/recursive structure, generate commands only when preconditions hold, compare observable state with a small model, and shrink values plus command sequences without making them invalid.
- **Coverage-guided fuzzing:** keep the target fast and deterministic; seed small representative valid/malformed inputs; use dictionaries or structure-aware mutation when syntax gates block depth; retain crash inputs and useful corpus entries deliberately.
- **Differential/metamorphic testing:** pin compared versions/configuration, normalize only contract-permitted differences, and triangulate disagreements when practical. A relation such as `decode(encode(x)) == x` is an oracle only if it is actually a product invariant.

## Specialist boundaries

- `deterministic-contract-testing`: fixed examples, exact boundary/schema matrices, and durable regressions promoted from minimized counterexamples. A fixed seed does not turn broad generated exploration into a fixed-example test.
- `integration-fault-testing`: real database/broker/filesystem/process/network/provider lifecycle, restart, concurrency, or injected dependency faults. Generated payloads can compose with it but do not prove the live component boundary.
- `testing-engineering`: parent that decides whether this exploration belongs in the overall strategy. Do not turn every test task into fuzzing.
- `debugging`: when a stable generated failure exists but causality is unknown, preserve/minimize the reproducer here, then diagnose the cause before assigning blame.

Return the generated domain/limits, properties and oracle rationale, framework/runtime plus seed/reproduction evidence, shrunk counterexamples, corpus/regression additions, exact campaign results, and explicit coverage/oracle limitations.

Use [the maintained source map](references/sources.md) when framework behavior, seed/replay semantics, corpus handling, fuzz-target requirements, or oracle practice is version-sensitive.
