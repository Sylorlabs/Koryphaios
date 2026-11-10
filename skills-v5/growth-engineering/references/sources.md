# Source map

## Applied curation, 2026-09-06

The [Microsoft Experimentation Platform SRM article](https://www.microsoft.com/en-us/research/articles/diagnosing-sample-ratio-mismatch-in-a-b-testing/), published 2020-09-14, was inspected. Adopt diagnosis of assignment, execution, logging, and analysis selection problems before trusting a growth experiment. Do not copy Microsoft's numerical threshold as a universal setting or use ratio correction to conceal missing participants. The skill applies those distinctions to exposure and downstream value; referral architecture and experiment tooling remain conditional. Refresh within 365 days; no experiment was run by reading this source.

`growth-engineering` is an individually authored V5 skill package; empirical qualification is tracked separately in the audit/evaluation ledger. These maintained sources bound factual and version-sensitive guidance; qualification is tested with hierarchy-aware held out routing, paired same-model skill/no skill tasks, and independent blind evaluation.

## Qualification basis

- Hierarchy: broader product-analytics.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **Google Analytics developer documentation**: https://developers.google.com/analytics
  - Scope: Google Analytics developer documentation as available 2026-10-19
  - Use: Event, measurement, reporting, and analytics implementation reference.
  - Verified: 2026-10-19; refresh after 45 days.
- **NIST/SEMATECH e-Handbook**: https://www.itl.nist.gov/div898/handbook/
  - Scope: NIST/SEMATECH statistical methods handbook as available 2026-09-04
  - Use: Statistical analysis, experimental design, exploratory analysis, and measurement reference.
  - Verified: 2026-09-04; refresh after 365 days.

## Interpretation rules

- Prefer the primary official/spec/reference source over community conventions when they conflict.
- Resolve the actual product, language, runtime, provider, platform, protocol, or standard version before applying details that can drift.
- Treat examples as examples, not proof that the current repository/runtime behaves the same way.
- Preserve unknowns and source conflicts explicitly; do not merge incompatible guidance into a false universal rule.
- Keep operational checks in the real target environment whenever the claim depends on runtime behavior.
