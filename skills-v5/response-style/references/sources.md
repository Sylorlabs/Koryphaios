# Source map

`response-style` is a portable, user-invoked presentation contract. The active user's explicit instructions are the authority for their preferred voice. General writing guides support clarity and structure, but they do not override a user's requested tone, required artifact format, exact source material, or domain-specific communication contract.

## Qualification basis

- Package authorship is separate from empirical qualification. This package contains no claim of same-model uplift, blind-review approval, activation, or promotion.
- Invocation is explicit. A host may pin the skill for a user, or a user may invoke it directly. Mere text that mentions "response style" does not activate it.
- Hierarchy: broader `documents-communication`; near neighbors include `dash-free-writing`, `executive-communication`, `instructional-communication`, `reference-communication`, and `technical-communication`.
- Routing coverage: five positive, five near-neighbor negative, three ambiguous, and three adversarial held out cases.
- Full-task coverage: two individually authored synthetic scenarios with observable checks, paired same-model skill/no skill requirements, and an independent blind semantic scorer.

## Maintained sources

- **PlainLanguage.gov guidelines**: https://www.plainlanguage.gov/guidelines/
  - Type: `official-docs`
  - Scope: U.S. federal plain-language guidance as available 2026-09-05.
  - Use: answer organization, direct wording, audience focus, and concise paragraphs.
  - Boundary: guidance for clarity, not a universal personal voice.
  - Verified: 2026-09-05; refresh after 180 days.

- **Microsoft Writing Style Guide**: https://learn.microsoft.com/en-us/style-guide/welcome/
  - Type: `official-docs`
  - Scope: Microsoft public writing style and terminology guidance as available 2026-09-05.
  - Use: reader-centered technical phrasing, concise wording, and terminology consistency.
  - Boundary: vendor house style is supporting evidence, not a requirement for every user or artifact.
  - Verified: 2026-09-05; refresh after 180 days.

- **Agent Skills specification**: https://agentskills.io/specification
  - Type: `spec`
  - Scope: portable Agent Skills format as available 2026-09-05.
  - Use: package structure, discovery metadata, and progressive disclosure.
  - Verified: 2026-11-03; refresh after 90 days.

- **OpenAI skill creator reference**: https://github.com/openai/skills/blob/main/skills/.system/skill-creator/SKILL.md
  - Type: `reference-implementation`
  - Scope: OpenAI public skill-authoring guidance on `main` as inspected 2026-11-03.
  - Use: preserve user intent, keep instructions narrow, distinguish explicit invocation from automatic discovery, and evaluate behavior with realistic cases.
  - Verified: 2026-11-03; refresh after 60 days.

## Interpretation rules

- Apply the active user's current explicit request before standing style preferences.
- Preserve facts, uncertainty, exact technical material, and required artifact structure before optimizing voice.
- Do not turn a personal preference into a general writing rule.
- Keep style composition separate from the adjacent skill's owned responsibility.
- Treat deterministic checks as observable presentation signals, not as proof of semantic quality. Promotion still requires the configured paired execution and independent review gates.
