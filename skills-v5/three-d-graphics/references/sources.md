# Source map

## Applied curation, 2026-09-06

The [three.js color management manual](https://threejs.org/manual/en/color-management.html) was inspected. Adopt separation of color and data textures, working space, and final output transformation. Keep API flags and postprocessing mechanics conditional on the actual renderer version. Do not impose three.js or a display transform on every pipeline. Attempts to refresh Blender documentation were inaccessible in this review; no fresh Blender verification is claimed. Refresh the inspected manual within 90 days. Rendered appearance and target performance still require actual output evidence.

`three-d-graphics` is an individually authored V5 skill package; empirical qualification is tracked separately in the audit/evaluation ledger. These maintained sources bound factual and version-sensitive guidance; qualification is tested with hierarchy-aware held-out routing, paired same-model skill/no-skill tasks, and independent blind evaluation.

## Qualification basis

- Hierarchy: broader game-spatial-interface.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held-out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no-skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **glTF 2.0 specification**: https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html
  - Scope: Khronos glTF 2.0 specification
  - Use: 3D scene, mesh, material, animation, coordinate, and asset-interchange semantics.
  - Verified: 2026-09-04; refresh after 365 days.

## Interpretation rules

- Prefer the primary official/spec/reference source over community conventions when they conflict.
- Resolve the actual product, language, runtime, provider, platform, protocol, or standard version before applying details that can drift.
- Treat examples as examples, not proof that the current repository/runtime behaves the same way.
- Preserve unknowns and source conflicts explicitly; do not merge incompatible guidance into a false universal rule.
- Keep operational checks in the real target environment whenever the claim depends on runtime behavior.
