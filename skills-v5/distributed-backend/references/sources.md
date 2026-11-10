# Source map

## Applied curation, 2026-10-17

[Handling Overload](https://sre.google/sre-book/handling-overload/) and the [AWS Builder's Library retry guidance](https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/) were inspected for retry ownership, backoff, jitter, and dependency overload. Adopt bounded retries at an identified owner, not illustrative limits from either source. The child retains its partial failure, conflict, and reconciliation responsibilities. Fault-model claims still need executed evidence.

`distributed-backend` is an individually authored V5 skill package. These maintained sources bound factual and version-sensitive guidance; they do not prove behavior in a target repository. Empirical qualification is tracked separately by authorized evaluators. No package-local check below is a qualification run, paired skill/no skill comparison, or blind review, and none is claimed as one.

## Qualification basis

- Hierarchy: broader backend-engineering; narrower children event-driven-architecture, stream-processing.
- Routing: public and held out cases cover concrete partition, fencing, retry, idempotency, replay, and recovery requests as well as near-neighbor, compound, and historical-decoy boundaries.
- Full-task evaluation: two individual scenarios require operation-level consistency and authority models, injected failure or simulation evidence, duplicate and unknown-outcome handling, retention boundaries, and recovery traces. Paired execution and blind judging remain evaluator-owned and are not package-local evidence.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **Google SRE Handling Overload**: https://sre.google/sre-book/handling-overload/
  - Scope: Handling Overload chapter, including retry ownership and overload response guidance as available 2026-09-06
  - Use: Retry ownership and overload boundaries. Illustrative limits are not universal defaults.
  - Verified: 2026-09-06; refresh after 365 days.

- **Google SRE book**: https://sre.google/sre-book/table-of-contents/
  - Scope: Google Site Reliability Engineering book as available 2026-09-04
  - Use: Reliability, monitoring, incident response, capacity, release, and distributed-systems operating practices.
  - Verified: 2026-09-04; refresh after 365 days.

- **AWS Builder's Library**: https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/
  - Scope: Timeouts, retries, backoff, jitter, idempotent side effects, and retry amplification guidance as available 2026-10-17
  - Use: Retry ownership and overload boundaries. The article's example limits are not universal defaults.
  - Verified: 2026-10-17; refresh after 180 days.

- **IETF RFC 9110**: https://www.rfc-editor.org/rfc/rfc9110.html
  - Scope: HTTP Semantics, Sections 2.4, 9.2.2, and 13, June 2022
  - Use: The distinction between idempotent request semantics, conditional requests, and application-specific effect guarantees.
  - Verified: 2026-10-17; refresh after 365 days.

- **Raft project and paper**: https://raft.github.io/raft.pdf
  - Scope: In Search of an Understandable Consensus Algorithm, extended version, as published by the authors
  - Use: Consensus, replicated-state-machine safety, majority progress assumptions, and the boundary between a consensus algorithm and an application effect.
  - Verified: 2026-10-17; refresh after 365 days.

- **etcd API guarantees**: https://etcd.io/docs/v3.5/learning/api_guarantees/
  - Scope: etcd v3.5 API ordering and consistency guarantees documentation
  - Use: An implementation-specific example of linearizable and serializable reads, revision identity, and the need to separate documented store guarantees from application guarantees.
  - Verified: 2026-10-17; refresh after 180 days.

## Interpretation rules

- Prefer the primary official/spec/reference source over community conventions when they conflict.
- Resolve the actual product, language, runtime, provider, platform, protocol, or standard version before applying details that can drift.
- Treat examples as examples, not proof that the current repository/runtime behaves the same way.
- Preserve unknowns and source conflicts explicitly; do not merge incompatible guidance into a false universal rule.
- Keep operational checks in the real target environment whenever the claim depends on runtime behavior.
- A source can support a design rule without proving the target's implementation, topology, clock behavior, durability, or recovery. Label those as inferred, simulated, unavailable, or runtime-observed.
