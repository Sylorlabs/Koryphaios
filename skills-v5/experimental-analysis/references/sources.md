# Source map

`experimental-analysis` is individually authored for V5; empirical qualification is tracked separately in the audit/evaluation ledger. These sources bound methodological or version-sensitive guidance; qualification still depends on paired same-model skill/no-skill runs, deterministic checks, and independent blind evaluation.

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: broader data-analysis.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held-out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no-skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **NIST/SEMATECH e-Handbook**: https://www.itl.nist.gov/div898/handbook/
  - Scope: NIST/SEMATECH statistical methods handbook as available 2026-09-05.
  - Use: Design-of-experiments objectives, randomization, blocking, factorial/fractional designs, response modeling, and confirmation.
  - Verified: 2026-09-05; refresh after 365 days.
- **What Works Clearinghouse: Handbooks and Other Resources**: https://ies.ed.gov/ncee/wwc/Handbooks
  - Scope: Current WWC Procedures and Standards Handbook index, Version 5.0 listed as current as inspected 2026-09-05.
  - Use: Current authoritative boundary for randomized controlled trials, quasi-experimental designs, regression discontinuity, attrition, baseline equivalence, and evidence-quality review.
  - Verified: 2026-09-05; refresh after 180 days.
- **What Works Clearinghouse Procedures and Standards Handbook, Version 5.0**: https://ies.ed.gov/ncee/wwc/Docs/referenceresources/Final_WWC-HandbookVer5.0-0-508.pdf
  - Scope: WWC Version 5.0 procedures and standards, revised December 2022, as hosted 2026-09-05.
  - Use: Detailed RCT/QED/RDD design definitions, assignment, attrition, confounding, equivalence, and review standards.
  - Verified: 2026-09-05; refresh after 180 days.
- **Agent Skills specification**: https://agentskills.io/specification
  - Scope: Agent Skills specification as available 2026-09-05.
  - Use: Portable discovery metadata and progressive disclosure for this package.
  - Verified: 2026-09-05; refresh after 90 days.
- **OpenAI public skill-creator reference**: https://github.com/openai/skills/blob/main/skills/.system/skill-creator/SKILL.md
  - Scope: OpenAI skill-creator guidance on `main` as inspected 2026-09-05.
  - Use: Narrow activation, explicit boundaries, progressive disclosure, and behavior-based skill evaluation.
  - Verified: 2026-09-05; refresh after 60 days.

## Interpretation rules

- Prefer the primary official/spec/reference source over community conventions when they conflict.
- Resolve the actual product, language, runtime, provider, platform, protocol, or standard version before applying details that can drift.
- Treat examples as examples, not proof that the current repository/runtime behaves the same way.
- Preserve unknowns and source conflicts explicitly; do not merge incompatible guidance into a false universal rule.
- Keep operational checks in the real target environment whenever the claim depends on runtime behavior.
