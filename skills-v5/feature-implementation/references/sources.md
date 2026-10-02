# Source map

`feature-implementation` is an individually authored V5 skill package. Empirical qualification is tracked separately in the audit and evaluation ledger. These maintained sources bound factual guidance that can change by version. Qualification is tested with routing that understands the hierarchy, held out cases, paired full task runs using the same model for the skill and baseline arms, and independent blind evaluation.

## Qualification basis

- Hierarchy: broader implementation.
- Routing: five positive, five near neighbor negative, three compound or ambiguous, and three adversarial held out cases through the real resolver.
- Full task evaluation: two individual scenarios with six falsifiable checks, paired skill and baseline runs using the same model, regression retention, and blind semantic judging.
- Source discipline: authoritative specifications and reference sources outrank community patterns when they conflict. Runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **SWEBOK**: https://www.computer.org/education/bodies-of-knowledge/software-engineering
  - Scope: IEEE Computer Society SWEBOK landing guidance as available 2026-09-04
  - Use: Software engineering lifecycle, construction, testing, maintenance, and professional practice baseline.
  - Verified: 2026-09-04. Refresh after 180 days.

## Interpretation rules

- Prefer the primary official specification or reference source over community conventions when they conflict.
- Resolve the actual product, language, runtime, provider, platform, protocol, or standard version before applying details that can drift.
- Treat examples as examples, not proof that the current repository/runtime behaves the same way.
- Preserve unknowns and source conflicts explicitly. Do not merge incompatible guidance into a false universal rule.
- Keep operational checks in the real target environment whenever the claim depends on runtime behavior.
