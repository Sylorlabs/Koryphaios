# Source map

## Applied curation, 2026-09-06

The [Godot physics interpolation introduction](https://docs.godotengine.org/en/stable/tutorials/physics/interpolation/physics_interpolation_introduction.html) was inspected. Adopt distinct simulation and rendering clocks, interpolation latency, and the possibility that network timing requires a different presentation scheme. Do not mandate Godot, 60 ticks per second, or built in interpolation for every game. Refresh within 90 days. Stable gameplay, saved state, and sustained performance must be tested on the actual target; a smooth preview is insufficient.

`game-development` is an individually authored V5 skill package; empirical qualification is tracked separately in the audit/evaluation ledger. These maintained sources bound factual and version-sensitive guidance; qualification is tested with hierarchy-aware held out routing, paired same-model skill/no skill tasks, and independent blind evaluation.

## Qualification basis

- Hierarchy: broader implementation.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **Godot documentation**: https://docs.godotengine.org/en/stable/
  - Scope: Godot stable documentation as available 2026-09-04
  - Use: Game engine scene, physics, input, rendering, resource, and performance reference.
  - Verified: 2026-11-03; refresh after 60 days.

## Interpretation rules

- Prefer the primary official/spec/reference source over community conventions when they conflict.
- Resolve the actual product, language, runtime, provider, platform, protocol, or standard version before applying details that can drift.
- Treat examples as examples, not proof that the current repository/runtime behaves the same way.
- Preserve unknowns and source conflicts explicitly; do not merge incompatible guidance into a false universal rule.
- Keep operational checks in the real target environment whenever the claim depends on runtime behavior.
