# Source map

`deterministic-debugging` is individually authored. Promotion still requires clean routing, paired same model skill/no skill full task evidence, independent blind evaluation, and regression closure.

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: broader debugging.
- Routing: five positive, five near neighbor negative, three compound/ambiguous, and three adversarial held out cases through the real resolver.
- Full task evaluation: two individual scenarios with eight falsifiable checks, same model skill/no skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Evidence and registration boundary

- The maintained Google SRE chapter is the methodological source for controlled reproduction, reduction, and hypothesis testing. It does not establish a parser, cache, runtime, or application-specific contract; those contracts must come from the supplied fixture, repository source, or an observed runtime result.
- `references/evaluation-contract.md` records the package local scenario identities and the currently registered deterministic materializer/scorer identities. It is harness provenance, not qualification evidence: paired runs, regression closure, and independent blind review must still be observed separately.
- A missing runtime, failed command, inferred starting result, or simulated transition must be labeled as unavailable, failed, inferred, or simulated. Never turn the package contract or scorer registration into a claim that a model run passed.

## Maintained sources

- **Google SRE: Effective Troubleshooting**: https://sre.google/sre-book/effective-troubleshooting/
  - Scope: chapter as available 2026-09-04.
  - Use: controlled reproduction, simplifying/reducing the failing path, hypothesis testing, and tracing symptoms toward causal mechanisms.
  - Verified: 2026-09-04; refresh after 180 days.

## Interpretation rules

- Preserve the exact deterministic reproduction before editing so the causal claim can be tested against the starting revision.
- Reduce inputs and paths only while the same behavior remains observable.
- Prefer the first proven divergence from the contract over downstream symptoms.
- A regression should protect the behavior or invariant, not merely the implementation line that changed.
- A negative path check must observe the documented failure behavior and a following valid operation where recovery is part of the contract; a control that never crosses the failure boundary is not recovery evidence.
- Specialist selection remains scoped: a deterministic replay of an interleaving stays concurrency work, and local parsing of a captured cross-service payload does not erase distributed causality.
