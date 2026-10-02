# Source map

Use sources in this order when the guidance conflicts:

1. The current Agent Skills specification for portable package structure and `SKILL.md` metadata.
2. Current official provider or framework documentation for product specific behavior.
3. Maintainer reference implementations for operational packaging patterns.
4. Community packages only for demonstrated workflow patterns, edge cases, or examples.

## Verification record

- Agent Skills specification: verified 2026-09-01. Recheck within 60 days or immediately after a published specification revision.
- OpenAI `skill-creator`: `openai/skills` HEAD `49f948faa9258a0c61caceaf225e179651397431`, verified 2026-09-01. Recheck within 30 days or when the upstream skill changes.
- Anthropic `agent-eval` guidance: verified 2026-09-01. Recheck within 90 days or when Anthropic publishes a replacement evaluation methodology.
- OpenAI ChatGPT and Codex skill documentation: verified 2026-09-04. It explicitly uses progressive disclosure, description driven implicit invocation, and a bounded discovery context. Recheck within 30 days.
- Cursor skill documentation: verified reachable 2026-09-04. Use as a competitive reference for reusable task specific guidance and context scoping rather than authority over Kory's router. Recheck within 30 days.
- Anthropic official skills repository: verified 2026-09-04. Use its package and resource patterns and cross surface examples as reference implementations. Preserve each skill's license and provenance. Recheck within 30 days.
- Matt Pocock engineering skills: verified 2026-09-04. Use only as community evidence for small composable skills, user versus model invocation boundaries, shared project language, and disciplined engineering workflows. Recheck within 30 days.

## Competitive patterns adopted

- Anthropic examples support a concrete job promise with focused supporting resources.
- Cursor demonstrates the value of an obvious manual entry point alongside automatic context selection.
- OpenAI Codex guidance supports progressive disclosure and a compact discovery surface.
- Matt Pocock examples support memorable bounded workflows and explicit behavioral invariants.
- Kory adds revision bound routing, paired task evidence, and blind review so a polished public surface remains tied to measured behavior.

Do not copy executable scripts from any source into an active Kory skill merely because the source is official or popular. Review behavior, authority requirements, license, and tests first.
