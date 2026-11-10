# Source map

## Applied curation, 2026-09-06

[W3C XR Accessibility User Requirements](https://www.w3.org/TR/xaur/) was inspected for multiple input/output modalities, alternative interaction and personalization. Adopt user requirements and explicit device/comfort evidence, not universal headset geometry, engine choices, or a formal conformance claim based on a user-requirements note. The existing OpenXR source remains scoped to its runtime semantics and earlier verification date. General agent instructions were removed while situated interaction and accessibility constraints remain.

`game-spatial-interface` is an individually authored V5 skill package; empirical qualification is tracked separately in the audit/evaluation ledger. These maintained sources bound factual and version-sensitive guidance; qualification is tested with hierarchy-aware held out routing, paired same-model skill/no skill tasks, and independent blind evaluation.

## Qualification basis

- Hierarchy: broader visual-interface-design, frontend-engineering; narrower children three-d-graphics.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **OpenXR 1.1 specification**: https://registry.khronos.org/OpenXR/specs/1.1/html/xrspec.html
  - Scope: Khronos OpenXR 1.1 specification
  - Use: Spatial runtime, interaction, action, view, and lifecycle semantics.
  - Verified: 2026-09-04; refresh after 365 days.

## Interpretation rules

- Prefer the primary official/spec/reference source over community conventions when they conflict.
- Resolve the actual product, language, runtime, provider, platform, protocol, or standard version before applying details that can drift.
- Treat examples as examples, not proof that the current repository/runtime behaves the same way.
- Preserve unknowns and source conflicts explicitly; do not merge incompatible guidance into a false universal rule.
- Keep operational checks in the real target environment whenever the claim depends on runtime behavior.
