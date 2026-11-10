# Source map

`testing-engineering` uses these sources for test-boundary, reproducibility, and evidence-design guidance. Framework-specific instructions belong in the relevant language or platform skill.

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: root responsibility; narrower children deterministic-contract-testing, integration-fault-testing, interface-usability-testing, ml-evaluation, performance-testing, property-fuzz-differential-testing, simulation-device-testing.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **IEEE Computer Society: SWEBOK Guide v4, Software Testing knowledge area**: https://www.computer.org/education/bodies-of-knowledge/software-engineering
  - Use: testing fundamentals, levels, techniques, test-related measures, and lifecycle context.
  - Version scope: SWEBOK Guide v4 material available 2026-09-05.
  - Verified: 2026-09-05; refresh after 180 days.

- **Google SRE: Testing for Reliability**: https://sre.google/sre-book/testing-reliability/
  - Use: confidence is claim-specific; unit/integration/system and production evidence serve different purposes; regression cases should preserve discovered failures; reliability testing scales with system risk.
  - Version scope: published SRE Book chapter available 2026-09-05.
  - Verified: 2026-09-05; refresh after 180 days.

- **Software Engineering at Google: Larger Testing / Hermetic Testing**: https://abseil.io/resources/swe-book/html/ch23.html
  - Use: hermeticity, determinism, isolation, faithful fakes, and the tradeoff between larger-test fidelity and stability.
  - Version scope: online book chapter available 2026-09-05.
  - Verified: 2026-09-05; refresh after 180 days.

- **NIST IR 8397: Guidelines on Minimum Standards for Developer Verification of Software**: https://csrc.nist.gov/pubs/ir/8397/final
  - Use: risk-based breadth across automated tests, structural cases, historical regressions, fuzzing, static analysis, and included components; especially relevant when security assurance is part of the test plan.
  - Version scope: NISTIR 8397 final publication.
  - Verified: 2026-09-05; refresh after 180 days.

- **Ham Vocke / Martin Fowler: The Practical Test Pyramid**: https://martinfowler.com/articles/practical-test-pyramid.html
  - Use: community practice for complementary granularity, narrow integration boundaries, avoiding duplicated assertions across layers, and pushing checks downward when a smaller boundary gives equivalent confidence.
  - Version scope: article published 2018-02-26 as available 2026-09-05.
  - Verified: 2026-09-05; refresh after 180 days.

## Interpretation rules

- Treat named test layers as heuristics, not a mandatory ratio. The production risk and observable contract decide the boundary.
- Prefer primary specifications and the repository's actual runtime contract over generic testing folklore when they disagree.
- A mock, fake, simulator, or local service is evidence only to the degree that its contract is faithful to the production boundary being claimed.
- Keep verification of a finished change distinct from designing new tests: `testing-engineering` creates durable executable evidence; `verification` decides whether current evidence is sufficient for a completion claim.
