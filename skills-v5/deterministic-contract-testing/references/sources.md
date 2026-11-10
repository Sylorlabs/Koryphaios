# Source map

`deterministic-contract-testing` is individually authored. Qualification still depends on clean routing plus paired same-model skill/no skill full task runs and independent blind evaluation; source quality alone is not a promotion result.

## Evidence and qualification boundary

- The package-local check at [`../evals/README.md`](../evals/README.md) validates authored package structure, routing decisions, registered synthetic fixtures, and scorer negative controls. It does not invoke a model, run paired skill/no skill tasks, conduct a blind review, or write qualification evidence.
- A `fixture://` starting state is deterministic test material. It can establish a local oracle, mutation response, and repeatability only for the materialized code and declared seams. It cannot establish behavior of a real broker, database, network, filesystem, process, provider, deployed service, or production runtime unless that boundary is actually exercised.
- The task records must retain explicit `synthetic/local`, `observed`, `unavailable`, and `unexecuted` labels. Paired full-task execution and independent blind evaluation remain separate qualification artifacts; authored cases and local scorer checks are readiness evidence, not promotion results.

## Authoritative and first-party sources

### Software Engineering at Google: Unit Testing

- URL: https://abseil.io/resources/swe-book/html/ch12.html
- Type: `official-docs`
- Scope: online Unit Testing chapter as available 2026-09-05.
- Applied pattern: narrow tests should remain deterministic and maintainable; exercise behavior through public APIs; prefer assertions on observable state/behavior over private implementation details; keep tests focused enough that failures explain the broken contract.
- Boundary: Google's organizational conventions are not universal ratios or framework requirements. Kory adopts the behavioral and maintainability principles, not a prescribed test-count mix.
- Refresh: 180 days.

### Software Engineering at Google: Test Doubles

- URL: https://abseil.io/resources/swe-book/html/ch13.html
- Type: `official-docs`
- Scope: online Test Doubles chapter as available 2026-09-05.
- Applied pattern: use test seams deliberately, prefer real implementations when practical, keep fakes faithful, and avoid unnecessary interaction assertions that couple a test to implementation details.
- Boundary: a test double can make a deterministic unit test practical, but it cannot prove the real dependency has the same behavior. Escalate fidelity-sensitive claims to `integration-fault-testing`.
- Refresh: 180 days.

### JSON Schema: Specification

- URL: https://json-schema.org/specification
- Type: `spec`
- Scope: Draft 2020-12 is identified by the JSON Schema project as the current published specification on 2026-09-05.
- Applied pattern: pin the schema dialect before deciding expected validation behavior; test valid and invalid examples against the actual dialect and vocabulary in use; do not merge rules from different drafts into one oracle.
- Boundary: schema conformance does not establish application semantics or HTTP behavior by itself.
- Refresh: 180 days or on publication of a new current draft.

### OpenAPI Initiative: OpenAPI Specification 3.2.0

- URL: https://spec.openapis.org/oas/v3.2.0.html
- Type: `spec`
- Scope: OAS 3.2.0, published 2025-09-19 and verified as the current published version on 2026-09-05.
- Applied pattern: API contract tests must use the repository's actual OAS feature version and declared schemas, operations, responses, and serialization rules. Version-pinned examples are stronger than assuming `latest` semantics.
- Boundary: if a repository declares OAS 3.1.x or another version, that declared contract wins for the task. A local schema/description test does not prove a deployed provider or transport behaves correctly.
- Refresh: 90 days or on an OAS release.

### Oracle: Java SE 25 `java.time.Clock`

- URL: https://docs.oracle.com/en/java/javase/25/docs/api/java.base/java/time/Clock.html
- Type: `official-docs`
- Scope: Java SE 25 / JDK 25 API.
- Applied pattern: a clock can be passed into time-dependent code so tests use controlled instants and zones; fixed and offset clocks make exact boundary cases testable without sleeping or depending on wall time.
- Boundary: this is a concrete platform mechanism, not a mandate to use Java or a class named `Clock`. Other runtimes should use their supported equivalent seam.
- Refresh: 180 days or when targeting a different Java release.

### Python: `random` module

- URL: https://docs.python.org/3/library/random.html
- Type: `official-docs`
- Scope: Python 3.14.7 documentation as available 2026-09-05.
- Applied pattern: a compatible pseudorandom generator can reproduce a sequence from the same seed, while OS-backed `SystemRandom` is not reproducible; exact-sequence assertions must preserve the relevant runtime/algorithm contract rather than assuming every random source is seed-stable forever.
- Boundary: seeded PRNGs are a determinism mechanism, not proof of statistical correctness. Broad generated exploration belongs to `property-fuzz-differential-testing`.
- Refresh: 90 days or when the target Python release changes.

### NISTIR 8397: Guidelines on Minimum Standards for Developer Verification of Software

- URL: https://csrc.nist.gov/pubs/ir/8397/final
- Type: `spec`
- Scope: final publication, October 2021; publication page rechecked 2026-09-05.
- Applied pattern: historical regression cases and fuzzing are complementary developer-verification techniques. A known defect should become a durable regression where practical, while broad unknown-input exploration remains a distinct technique.
- Boundary: Kory uses this source to support complementary evidence selection, not to require every listed technique for every repository task.
- Refresh: 365 days or on supersession.

## Strong community patterns

### Stryker Mutator: Mutation Testing

- URL: https://stryker-mutator.io/docs/
- Type: `community-pattern`
- Scope: documentation as available 2026-09-05.
- Applied pattern: deliberately change production behavior and check whether the test suite detects the change. For a focused regression, a killed relevant mutant is concrete evidence that the oracle distinguishes the targeted defect class.
- Boundary: mutation scores are not a universal quality target. Surviving mutants need interpretation, and equivalent/irrelevant mutants do not automatically imply a missing product contract.
- Refresh: 90 days.

### Martin Fowler: Mocks Aren't Stubs

- URL: https://martinfowler.com/articles/mocksArentStubs.html
- Type: `community-pattern`
- Scope: article published 2007-01-02; rechecked 2026-09-05.
- Applied pattern: distinguish test doubles and state verification from interaction verification; interaction expectations can be appropriate when the interaction is the observable contract, but otherwise can couple a test to implementation choices.
- Boundary: terminology and style are community conventions. Repository contracts and first-party platform behavior remain authoritative.
- Refresh: 365 days.

## Interpretation and conflict rules

- The repository's supported runtime, schema dialect, API version, public contract, and existing test conventions are task ground truth. External sources do not override them.
- Resolve version-sensitive behavior before writing the oracle. Do not use OpenAPI 3.2.0 semantics for a repository that explicitly targets 3.1.x, or Draft 2020-12 JSON Schema semantics for an older declared dialect.
- A deterministic test controls relevant nondeterminism; it does not erase behavior. If controlling a dependency changes the claim being tested, move outward to the real boundary.
- A fixed seed is useful only with a reproducibility contract for the chosen generator/runtime. Preserve the minimized generated counterexample as a fixed regression when exact future seed replay is not guaranteed.
- Prefer behavioral outputs and state to collaborator call order unless the interaction itself is the contract.
- Mutation evidence is strongest when the mutation models the actual or plausible defect the regression claims to prevent. Do not chase a mutation percentage detached from product risk.
- When a source describes a platform mechanism or a testing pattern, apply only the supported runtime and contract in the target repository. A controlled fake or in-process fixture may make a claim repeatable, but it does not upgrade the claim to real-boundary qualification.

See the package-local [evaluation boundary and checks](../evals/README.md) for the exact offline command and the evidence that remains unavailable until a separate qualification run.
