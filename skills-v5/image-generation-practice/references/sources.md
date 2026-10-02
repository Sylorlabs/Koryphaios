# Source map

## Applied curation, 2026-09-06

The output options and limitations sections of [OpenAI image generation](https://developers.openai.com/api/docs/guides/image-generation) were inspected. Adopt the distinction between supported image controls and actual text accuracy, visual continuity, and composition fidelity. Do not pin one model, image dimension, or API into the reusable skill. Refresh within 30 days. Generation must use capabilities actually available to the task, and visual review must inspect the returned file rather than infer success from a prompt or API response.

`image-generation-practice` is an individually authored V5 skill package; empirical qualification is tracked separately in the audit/evaluation ledger. These maintained sources bound factual and version-sensitive guidance; qualification is tested with hierarchy-aware held-out routing, paired same-model skill/no-skill tasks, and independent blind evaluation.

## Qualification basis

- Hierarchy: broader visual-interface-design.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held-out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no-skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **OpenAI image generation guide**: https://platform.openai.com/docs/guides/image-generation
  - Scope: OpenAI image generation guidance as available 2026-09-04
  - Use: Image-generation prompt, edit, input, output, and model behavior guidance.
  - Verified: 2026-09-04; refresh after 30 days.

## Interpretation rules

- Prefer the primary official/spec/reference source over community conventions when they conflict.
- Resolve the actual product, language, runtime, provider, platform, protocol, or standard version before applying details that can drift.
- Treat examples as examples, not proof that the current repository/runtime behaves the same way.
- Preserve unknowns and source conflicts explicitly; do not merge incompatible guidance into a false universal rule.
- Keep operational checks in the real target environment whenever the claim depends on runtime behavior.
