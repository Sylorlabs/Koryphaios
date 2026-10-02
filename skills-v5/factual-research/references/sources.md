# Source map

`factual-research` is individually authored for V5; empirical qualification is tracked separately in the audit/evaluation ledger. These sources bound its discrete claim-verification workflow, source-authority model, recency/version reasoning, contradiction handling, and skill/eval design. Refresh current-product, policy, statistical, or standards sources at task time before relying on version-sensitive behavior.

## Factual-research method sources

- **OpenAI model guidance: web search and research**: https://developers.openai.com/api/docs/guides/latest-model
  - Type: `official-docs`
  - Scope: current OpenAI guidance for web research, freshness-sensitive browsing, source use, and citation placement as available 2026-09-04.
  - Verified: 2026-09-04; refresh after 30 days.
  - Provenance: original OpenAI documentation; paraphrased, not copied.
  - Relevance: supports browsing for unstable/current facts, using citations for web-derived claims, comparing dates for news/current events, and preferring stronger sources for key claims.

- **Library of Congress: Search Strategies**: https://guides.loc.gov/student-resources/search-strategies
  - Type: `official-docs`
  - Scope: Library of Congress research/search guidance; page last updated 2022-01-05 and still available 2026-09-04.
  - Verified: 2026-09-04; refresh after 180 days.
  - Provenance: original Library of Congress guide; paraphrased.
  - Relevance: supports deliberate search strategy, source evaluation, and treating research results as evidence to assess rather than answers to accept automatically.

- **Library of Congress: Finding Quotations / Full-text Searching**: https://guides.loc.gov/quotations/full-text-searching
  - Type: `official-docs`
  - Scope: Library of Congress quotation-verification and open-web searching guidance, last updated 2026-07-09.
  - Verified: 2026-09-04; refresh after 180 days.
  - Provenance: original Library of Congress guide; paraphrased.
  - Relevance: supports tracing claims to original documents and recognizing that open-web repetition can propagate incorrect attribution.

## Skill-authoring and portability sources

- **Agent Skills specification**: https://agentskills.io/specification
  - Type: `spec`
  - Scope: Agent Skills format and progressive-disclosure requirements as available 2026-09-04.
  - Verified: 2026-09-04; refresh after 90 days.
  - Provenance: open Agent Skills specification; no text copied into this package.
  - Relevance: `name`/`description` are discovery metadata; detailed instructions belong in `SKILL.md`; focused references should load only when needed.

- **Agent Skills best practices**: https://agentskills.io/skill-creation/best-practices
  - Type: `official-docs`
  - Scope: Agent Skills authoring guidance as available 2026-09-04.
  - Verified: 2026-09-04; refresh after 90 days.
  - Provenance: open Agent Skills documentation; paraphrased.
  - Relevance: concise stepwise instructions, moderate detail, and explicit on-demand reference loading are preferred to exhaustive always-loaded prose.

- **OpenAI skill creator reference skill**: https://github.com/openai/skills/blob/main/skills/.system/skill-creator/SKILL.md
  - Type: `reference-implementation`
  - Scope: OpenAI's public skill-creator guidance on `main` as inspected 2026-09-04.
  - Verified: 2026-09-04; refresh after 60 days.
  - Provenance: OpenAI public repository; pattern comparison only.
  - Relevance: puts all trigger conditions in the description, keeps the body focused on execution, and validates skill structure after edits.

- **Anthropic: Equipping agents for the real world with Agent Skills**: https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills
  - Type: `official-docs`
  - Scope: Anthropic Agent Skills architecture and progressive-disclosure guidance as available 2026-09-04.
  - Verified: 2026-09-04; refresh after 90 days.
  - Provenance: original Anthropic engineering article; paraphrased.
  - Relevance: corroborates the metadata -> `SKILL.md` -> referenced-resource disclosure model used here.

- **Cursor: Rules**: https://prod.cursor.com/docs/rules
  - Type: `official-docs`
  - Scope: Cursor rule authoring guidance as available 2026-09-04.
  - Verified: 2026-09-04; refresh after 90 days.
  - Provenance: original Cursor documentation; pattern comparison only.
  - Relevance: corroborates focused, actionable, scoped instructions, concrete examples/references, and splitting large guidance into composable files.

- **PracticalSwan research Agent Skill**: https://github.com/PracticalSwan/agent-skills/blob/main/research/SKILL.md
  - Type: `community-pattern`
  - Scope: community research skill version visible on 2026-09-04 (repository reported MIT licensing and an August 2026 update).
  - Verified: 2026-09-04; refresh after 30 days.
  - License: MIT.
  - Provenance: consulted only for operational comparison; no text copied.
  - Relevance: useful community corroboration for primary-source preference, claim-level citation, and bounded fallback when delegation/tooling is unavailable. It is not treated as authority for factual claims.

## Stewardship conclusions

- Trigger precision belongs in the description because that metadata is available before the body is loaded.
- The skill should stay narrow: discrete claim verification with explicit time/version scope, not generic research orchestration.
- Currentness, source ownership, date/effective-date checks, contradiction handling, and claim-level citations are core execution rules.
- Detailed evidence mechanics belong in an on-demand reference rather than expanding `SKILL.md`.
- Community material may inform workflow ergonomics but does not outrank official or primary sources.

## Conflict and freshness rules

- Prefer the exact source that owns the claim over commentary about it.
- Prefer current/effective guidance over superseded guidance; record both when the historical transition explains a conflict.
- For technical facts, bind the answer to the actual product/version/runtime when that changes the result.
- For policies, laws, schedules, prices, officeholders, supported versions, and similar unstable facts, refresh evidence at task time rather than relying on this stewardship source map.
