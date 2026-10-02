# Source map

`react-engineering` is an individually authored V5 skill package; empirical qualification is tracked separately in the audit/evaluation ledger. These maintained sources bound factual and version-sensitive guidance; qualification is tested with hierarchy-aware held-out routing, paired same-model skill/no-skill tasks, and independent blind evaluation.

## Qualification basis

- Hierarchy: broader frontend-engineering.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held-out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no-skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **React documentation:** https://react.dev/
  - Scope: React documentation as fetched 2026-09-06.
  - Use: Primary authority for React rendering, state, effects, component identity, and hooks.
  - Verified: 2026-09-06; refresh after 45 days.
- **You Might Not Need an Effect:** https://react.dev/learn/you-might-not-need-an-effect
  - Scope: Current React guidance as fetched 2026-09-06.
  - Use: Derived state belongs in render; event-caused work belongs in event handlers; Effects synchronize with external systems.
  - Verified: 2026-09-06; refresh after 45 days.
- **Lifecycle of Reactive Effects:** https://react.dev/learn/lifecycle-of-reactive-effects
  - Scope: Current React guidance as fetched 2026-09-06.
  - Use: Effect synchronization lifecycle, dependencies, cleanup, and repeated development synchronization.
  - Verified: 2026-09-06; refresh after 45 days.
- **Matt Pocock skills:** https://github.com/mattpocock/skills
  - Scope: `main` commit `3cca18b368ae95cdbdebbff572ccafa662551015`, authored 2026-09-04T08:43:27Z; repository `package.json` reports `mattpocock-skills` 1.2.3.
  - Use: Community reference for small composable skill packaging and explicit router versus reusable-discipline separation. Never authority over React behavior.
  - Verified: 2026-09-06; refresh after 30 days.

## Research notes

- Adopted: the repository's explicit distinction between routing/orchestration and model-invoked reusable discipline, visible in the current `ask-matt` router and repository skill organization. Revision: https://github.com/mattpocock/skills/commit/3cca18b368ae95cdbdebbff572ccafa662551015
- Adapted: that separation becomes a React-specific boundary rule. React owns component and hook semantics; Next.js owns framework server, routing, and cache semantics; TypeScript joins only when language behavior is material.
- Rejected: the repository's broader idea-to-ship workflow and user-command flow are not imported into this specialist skill because they would add process that does not improve React decisions.
- Primary-source concepts adopted: derive renderable values instead of synchronizing duplicate state; reserve Effects for external synchronization; make cleanup match setup; treat keys as state identity when a subtree must reset.

## Interpretation rules

- Prefer the primary official/spec/reference source over community conventions when they conflict.
- Resolve the actual product, language, runtime, provider, platform, protocol, or standard version before applying details that can drift.
- Treat examples as examples, not proof that the current repository/runtime behaves the same way.
- Preserve unknowns and source conflicts explicitly; do not merge incompatible guidance into a false universal rule.
- Keep operational checks in the real target environment whenever the claim depends on runtime behavior.
