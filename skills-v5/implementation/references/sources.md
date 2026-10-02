# Source map

`implementation` is individually authored, but qualification still depends on routing, paired same-model skill/no-skill task evidence, independent blind evaluation, and regression closure.

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: root responsibility; narrower children c-cpp-systems-engineering, container-engineering, csharp-dotnet-engineering, feature-implementation, game-development, go-engineering, integration-implementation, java-jvm-engineering, kotlin-engineering, llm-application-engineering, php-engineering, python-engineering, refactor-implementation, robotics-control, ruby-engineering, rust-engineering, swift-engineering, typescript-javascript-engineering.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held-out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no-skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **IEEE Computer Society: SWEBOK**: https://www.computer.org/education/bodies-of-knowledge/software-engineering
  - Scope: SWEBOK v4 landing guidance as available 2026-09-04.
  - Use: software construction, testing, maintenance, and lifecycle boundaries.
  - Authority: primary professional body-of-knowledge source for the general software-engineering concepts it covers.
  - Verified: 2026-09-04; refresh after 180 days.

- **Google Engineering Practices: Small CLs**: https://google.github.io/eng-practices/review/developer/small-cls.html
  - Scope: Google engineering-practice guidance as available 2026-09-04.
  - Use: evidence for focused, self-contained changes, keeping related tests with changed behavior, separating substantial refactors, and preserving rollback/reviewability.
  - Authority: strong community/industry practice, not a universal rule and never authority over repository-local instructions.
  - Verified: 2026-09-04; refresh after 180 days.

## Interpretation rules

- Repository instructions, existing contracts, and the requested acceptance criteria determine the actual implementation boundary.
- Prefer a maintained primary source for version-sensitive platform or language facts; the general sources above do not override product-specific documentation.
- Treat the small-change principle conceptually, not as a line-count quota.
- Use runtime or test evidence when the claim is behavioral; a plausible-looking diff is not proof of correctness.
