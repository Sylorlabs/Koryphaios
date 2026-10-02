# Source map

`instructional-communication` is individually authored for V5; empirical qualification is tracked separately in the audit/evaluation ledger. These sources bound instructional form, procedural wording, placeholder/condition clarity, and skill/eval design. Exact commands, versions, paths, outputs, and recovery behavior still require task-specific repository/runtime/product evidence.

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: broader documents-communication.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held-out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no-skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **PlainLanguage.gov guidelines**: https://www.plainlanguage.gov/guidelines/
  - Type: `official-docs`
  - Scope: U.S. federal plain-language guidance as available 2026-09-05.
  - Use: Audience-centered structure, wording, and readability guidance.
  - Verified: 2026-09-05; refresh after 180 days.

- **Google developer documentation style guide**: https://developers.google.com/style
  - Type: `official-docs`
  - Scope: Google developer documentation guidance as available 2026-09-05.
  - Use: direct reader address, unambiguous procedural language, conditions before actions, consistent terminology, and project-specific style precedence.
  - Verified: 2026-09-05; refresh after 90 days.

- **Google style: placeholders**: https://developers.google.com/style/placeholders
  - Type: `official-docs`
  - Scope: Google placeholder-format guidance as available 2026-09-05.
  - Use: define command/code placeholders when first introduced so executable instructions do not depend on implicit expert knowledge.
  - Verified: 2026-09-05; refresh after 90 days.

- **Diátaxis**: https://diataxis.fr/
  - Type: `community-pattern`
  - Scope: Diátaxis documentation architecture as available 2026-09-05.
  - Use: strong community pattern distinguishing tutorials and how-to guides from reference and explanation according to reader need.
  - Verified: 2026-09-05; refresh after 180 days.

- **Agent Skills specification**: https://agentskills.io/specification
  - Type: `spec`
  - Scope: portable Agent Skills format as available 2026-09-05.
  - Use: discriminating discovery metadata and progressive disclosure.
  - Verified: 2026-09-05; refresh after 90 days.

- **OpenAI skill creator reference**: https://github.com/openai/skills/blob/main/skills/.system/skill-creator/SKILL.md
  - Type: `reference-implementation`
  - Scope: OpenAI public skill-authoring guidance on `main` as inspected 2026-09-05.
  - Use: bounded specialist triggers and behavioral evaluation.
  - Verified: 2026-09-05; refresh after 60 days.

## Interpretation rules

- State prerequisites and observable starting state before executable work.
- Put conditions and warnings before the action they govern; define placeholders on first use.
- Pair consequential actions/stages with observable expected feedback and recovery/escalation paths.
- End with objective completion checks tied to the user's real goal.
- Test the procedure in the intended environment when possible; label untested/version-uncertain instructions explicitly.
