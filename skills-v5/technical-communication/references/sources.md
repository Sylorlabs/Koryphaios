# Source map

`technical-communication` is individually authored for V5; empirical qualification is tracked separately in the audit/evaluation ledger. These sources bound technical-writing style, document-purpose separation, and skill/eval design. Technical claims in an artifact still require repository/runtime/spec/measurement evidence appropriate to the task.

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: broader documents-communication; narrower children sales-engineering.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **PlainLanguage.gov guidelines**: https://www.plainlanguage.gov/guidelines/
  - Type: `official-docs`
  - Scope: U.S. federal plain-language guidance as available 2026-09-05.
  - Use: Audience-centered structure, wording, and readability guidance.
  - Verified: 2026-09-05; refresh after 180 days.

- **Google developer documentation style guide**: https://developers.google.com/style
  - Type: `official-docs`
  - Scope: Google developer documentation style guide, last updated 2026-04-27 and inspected 2026-09-05.
  - Use: technical-reader clarity/consistency plus the explicit precedence of project-specific style over generic guidance.
  - Verified: 2026-09-05; refresh after 90 days.

- **Microsoft Writing Style Guide**: https://learn.microsoft.com/en-us/style-guide/welcome/
  - Type: `official-docs`
  - Scope: Microsoft public technology-writing style guidance as available 2026-09-05.
  - Use: concise, consistent terminology and reader-centered technical communication.
  - Verified: 2026-09-05; refresh after 180 days.

- **Diátaxis**: https://diataxis.fr/
  - Type: `community-pattern`
  - Scope: Diátaxis documentation architecture as available 2026-09-05.
  - Use: strong community pattern for separating explanation from tutorial/how-to/reference needs; does not override project conventions or primary evidence.
  - Verified: 2026-09-05; refresh after 180 days.

- **Agent Skills specification**: https://agentskills.io/specification
  - Type: `spec`
  - Scope: portable Agent Skills format as available 2026-09-05.
  - Use: discovery metadata and progressive disclosure.
  - Verified: 2026-11-03; refresh after 90 days.

- **OpenAI skill creator reference**: https://github.com/openai/skills/blob/main/skills/.system/skill-creator/SKILL.md
  - Type: `reference-implementation`
  - Scope: OpenAI public skill-authoring guidance on `main` as inspected 2026-11-03.
  - Use: bounded specialist triggers and behavioral evaluation.
  - Verified: 2026-11-03; refresh after 60 days.

## Interpretation rules

- Follow project-specific terminology/templates before generic style guides.
- Separate current, proposed, measured, inferred, and unresolved technical claims.
- Use diagrams only when they materially improve relationships/flow and keep them traceable to the described system.
- Validate examples in the target environment where practical; label pseudocode/illustrations explicitly.
- Keep technical explanation distinct from procedural instruction and lookup reference unless the user explicitly requests a combined artifact.
