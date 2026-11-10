# Source map

`experimentation-ab-testing` is individually authored for V5; empirical qualification is tracked separately in the audit/evaluation ledger. Sources bound methodological or version-sensitive guidance, but qualification still requires paired same-model skill/no skill runs, deterministic checks, and independent blind evaluation.

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: broader statistical-inference.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **NIST/SEMATECH e-Handbook**: https://www.itl.nist.gov/div898/handbook/
  - Scope: NIST/SEMATECH statistical methods handbook as available 2026-09-05.
  - Use: Experimental design, randomization, measurement, uncertainty, and statistical-analysis foundations.
  - Verified: 2026-09-05; refresh after 365 days.
- **Microsoft Research: Diagnosing Sample Ratio Mismatch in Online Controlled Experiments**: https://www.microsoft.com/en-us/research/publication/diagnosing-sample-ratio-mismatch-in-online-controlled-experiments-a-taxonomy-and-rules-of-thumb-for-practitioners/
  - Scope: Microsoft Experimentation Platform SRM paper and publication record as available 2026-09-05.
  - Use: Trustworthiness checks, SRM as a symptom of assignment/execution/logging/analysis defects, and diagnosis before effect interpretation.
  - Verified: 2026-09-05; refresh after 180 days.
- **Microsoft Research: Online Experimentation at Microsoft**: https://www.microsoft.com/en-us/research/publication/online-experimentation-at-microsoft/
  - Scope: Microsoft Research publication record as available 2026-09-05.
  - Use: Practical online controlled-experiment architecture, causal decision framing, and experimentation operating lessons.
  - Verified: 2026-09-05; refresh after 180 days.
- **Agent Skills specification**: https://agentskills.io/specification
  - Scope: Agent Skills specification as available 2026-09-05.
  - Use: Portable discovery metadata and progressive disclosure for this package.
  - Verified: 2026-11-03; refresh after 90 days.
- **OpenAI public skill-creator reference**: https://github.com/openai/skills/blob/main/skills/.system/skill-creator/SKILL.md
  - Scope: OpenAI skill-creator guidance on `main` as inspected 2026-11-03.
  - Use: Narrow triggers, explicit exclusions, progressive disclosure, and behavior-based skill evaluation.
  - Verified: 2026-11-03; refresh after 60 days.

## Interpretation rules

- Prefer the primary official/spec/reference source over community conventions when they conflict.
- Resolve the actual product, language, runtime, provider, platform, protocol, or standard version before applying details that can drift.
- Treat examples as examples, not proof that the current repository/runtime behaves the same way.
- Preserve unknowns and source conflicts explicitly; do not merge incompatible guidance into a false universal rule.
- Keep operational checks in the real target environment whenever the claim depends on runtime behavior.
