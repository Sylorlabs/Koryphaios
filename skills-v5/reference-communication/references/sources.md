# Source map

`reference-communication` is individually authored for V5; empirical qualification is tracked separately in the audit/evaluation ledger. These sources bound versioned source-of-truth handling, schema/reference semantics, lookup-oriented documentation, and skill/eval design. Target-system facts still require the exact API/schema/parser/runtime version being documented.

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: broader documents-communication; narrower children contract-analysis.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held-out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no-skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **PlainLanguage.gov guidelines**: https://www.plainlanguage.gov/guidelines/
  - Type: `official-docs`
  - Scope: U.S. federal plain-language guidance as available 2026-09-05.
  - Use: Audience-centered structure, wording, and readability guidance.
  - Verified: 2026-09-05; refresh after 180 days.

- **OpenAPI Specification**: https://spec.openapis.org/oas/
  - Type: `spec`
  - Scope: published OpenAPI Specification versions through v3.2.0 as listed 2026-09-05.
  - Use: versioned API-definition semantics and source precedence; the official site states specification text prevails if schemas and specification text disagree.
  - Verified: 2026-09-05; refresh after 90 days.

- **JSON Schema specification**: https://json-schema.org/specification
  - Type: `spec`
  - Scope: latest released JSON Schema dialect 2020-12 as listed 2026-09-05.
  - Use: schema/dialect/version awareness, validation-keyword semantics, and explicit dialect boundaries for schema-derived reference material.
  - Verified: 2026-09-05; refresh after 180 days.

- **Google developer documentation style guide**: https://developers.google.com/style
  - Type: `official-docs`
  - Scope: Google developer-documentation guidance as available 2026-09-05.
  - Use: precise, consistent technical terminology and reader-oriented lookup wording, subordinate to project-specific style.
  - Verified: 2026-09-05; refresh after 90 days.

- **Diátaxis**: https://diataxis.fr/
  - Type: `community-pattern`
  - Scope: Diátaxis documentation architecture as available 2026-09-05.
  - Use: community pattern distinguishing reference as information-oriented lookup material from tutorials/how-to/explanation.
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

- Establish the exact reference surface/version and authoritative source hierarchy before documenting items.
- Enumerate source units before writing so coverage omissions are measurable.
- Preserve exact names, types, required/default semantics, constraints, lifecycle, compatibility, errors, and permissions when applicable.
- Validate examples against the target schema/parser/API/CLI when practical; label illustrative examples explicitly.
- Split or annotate materially different versions rather than merging them into false universal behavior.
