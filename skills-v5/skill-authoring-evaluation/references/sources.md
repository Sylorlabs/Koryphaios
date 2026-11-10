# Source map

Use sources in this order when the guidance conflicts:

1. The current Agent Skills specification for portable package structure and `SKILL.md` metadata.
2. Current official provider or framework documentation for product specific behavior.
3. Maintainer reference implementations for operational packaging patterns.
4. Community packages only for demonstrated workflow patterns, edge cases, or examples.

## Verification record

- Agent Skills specification: verified 2026-09-01. Recheck within 60 days or immediately after a published specification revision.
- OpenAI `skill-creator`: current `openai/skills` main file content retrieved 2026-10-02. Current commit identity was not verified; the historical 2026-09-01 revision is `49f948faa9258a0c61caceaf225e179651397431`. The retrieved guidance retains concise discovery, risk proportional specificity, progressive resources, validation, and iteration driven by real usage. Recheck within 30 days or when the upstream skill changes. The newer Codex sample at https://github.com/openai/codex/blob/main/codex-rs/skills/src/assets/samples/skill-creator/SKILL.md was also retrieved: it explicitly separates structural validation from behavioral proof and reserves independent forward testing for meaningful, authorized evaluations.
- Anthropic `agent-eval` guidance: verified 2026-09-01. Recheck within 90 days or when Anthropic publishes a replacement evaluation methodology.
- OpenAI ChatGPT and Codex skill documentation: verified 2026-10-03. The current Build skills page still uses progressive disclosure, description driven implicit invocation, a bounded initial discovery context, optional resources and scripts, and an explicit implicit invocation policy. Recheck within 30 days.
- Cursor Agent Skills documentation: verified 2026-10-03 at https://cursor.com/docs/skills. The previous https://docs.cursor.com/context/skills URL now redirects to the general docs root. The current page supports automatic relevance based invocation, manual slash invocation, nested path scoping, progressive resources, and `disable-model-invocation`. Use these as competitive host patterns rather than authority over Kory's router. Recheck within 30 days.
- Anthropic official skills repository: `main` at `8a1541c4a3ffa5a20a5a91de0dcf3f0bab1d1ef4`, inspected 2026-11-03. The repository still demonstrates self contained `SKILL.md` packages with optional resources across example and production backed skills, with mixed licensing that must be preserved per skill. Recheck within 30 days.
- Matt Pocock engineering skills: `main` at `d81f3a183412e71a5b1e84ca21bc1a35eea03a60`, inspected 2026-11-03. The current repository still explicitly separates user invoked orchestration from model invoked reusable discipline and emphasizes small composable skills plus shared project language. Recheck within 30 days.

## Competitive patterns adopted

- Anthropic examples support a concrete job promise with focused supporting resources.
- Cursor demonstrates the value of an obvious manual entry point alongside automatic context selection.
- OpenAI Codex guidance supports progressive disclosure and a compact discovery surface.
- Matt Pocock examples support memorable bounded workflows and explicit behavioral invariants.
- Kory adds revision bound routing, paired task evidence, and blind review so a polished public surface remains tied to measured behavior.

Do not copy executable scripts from any source into an active Kory skill merely because the source is official or popular. Review behavior, authority requirements, license, and tests first.
