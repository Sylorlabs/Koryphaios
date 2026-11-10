# Source map

## Applied curation, 2026-09-06

The output options and limitations sections of [OpenAI image generation](https://developers.openai.com/api/docs/guides/image-generation) were inspected. Adopt the distinction between supported image controls and actual text accuracy, visual continuity, and composition fidelity. Do not pin one model, image dimension, or API into the reusable skill. Refresh within 30 days. Generation must use capabilities actually available to the task, and visual review must inspect the returned file rather than infer success from a prompt or API response.

`image-generation-practice` is an individually authored V5 skill package; empirical qualification is tracked separately in the audit/evaluation ledger. These maintained sources bound factual and version-sensitive guidance; qualification is tested with hierarchy-aware held out routing, paired same-model skill/no skill tasks, and independent blind evaluation.

## Qualification basis

- Hierarchy: broader visual-interface-design.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held out cases through the real resolver.
- Full task evaluation: two individual scenarios with six falsifiable checks, same model skill pairing with and without the skill, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **OpenAI image generation guide**: https://platform.openai.com/docs/guides/image-generation
  - Scope: the legacy platform URL redirected to the canonical OpenAI image generation guide and was inspected 2026-11-03.
  - Use: generation and editing through the Image API and Responses API, image inputs, and output controls. Current model IDs remain version-sensitive reference detail rather than reusable skill rules.
  - Verified: 2026-11-03; refresh after 30 days.

## Interpretation rules

- Prefer the primary official/spec/reference source over community conventions when they conflict.
- Resolve the actual product, language, runtime, provider, platform, protocol, or standard version before applying details that can drift.
- Treat examples as examples, not proof that the current repository/runtime behaves the same way.
- Preserve unknowns and source conflicts explicitly; do not merge incompatible guidance into a false universal rule.
- Keep operational checks in the real target environment whenever the claim depends on runtime behavior.

## Evidence and provenance protocol

- The evidence unit is the actual returned image file. Prompt text, a provider response, a filename that looks generated, or a probe that only reads metadata cannot substitute for it.
- For generated images, record provider/runtime, model or endpoint identifier, request timestamp, relevant parameters and seed when available, output path, SHA-256, dimensions, format/color mode, and any post-generation transforms.
- For edits, also record each supplied asset's stable identifier or path, SHA-256 before editing, permission/consent boundary, and the comparison performed against the preserved source.
- Run file readability/dimension checks and visual delivery-resolution/crop checks as separate rows. Mark visual inspection, human review, simulated fixtures, inferred claims, and unavailable runtime checks explicitly.
- A blocked generation or edit remains blocked until actual output bytes and the requested visual review exist. Do not manufacture a negative or recovery result from prose, a thumbnail, or a changed prompt.
