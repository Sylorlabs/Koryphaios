# Source map

`react-engineering` is an individually authored V5 skill package; empirical qualification is tracked separately in the audit/evaluation ledger. These maintained sources bound guidance that is factual or tied to a version; qualification is tested with held out routing that accounts for hierarchy, paired tasks run with the same model with and without the skill, and independent blind evaluation.

## Qualification basis

- Hierarchy: broader frontend-engineering.
- Routing: five positive, five negative from near neighbors, three compound/ambiguous, and three adversarial held out cases through the real resolver.
- Full task evaluation: two individual scenarios with six falsifiable checks, pairing runs of the same model with and without the skill, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **React documentation:** https://react.dev/
  - Scope: React documentation as fetched 2026-10-20.
  - Use: Primary authority for React rendering, state, effects, component identity, and hooks.
  - Verified: 2026-10-20; refresh after 45 days.
- **You Might Not Need an Effect:** https://react.dev/learn/you-might-not-need-an-effect
  - Scope: Current React guidance as fetched 2026-10-20.
  - Use: Derived state belongs in render; work caused by an event belongs in event handlers; Effects synchronize with external systems.
  - Verified: 2026-10-20; refresh after 45 days.
- **Lifecycle of Reactive Effects:** https://react.dev/learn/lifecycle-of-reactive-effects
  - Scope: Current React guidance as fetched 2026-10-20.
  - Use: Effect synchronization lifecycle, dependencies, cleanup, and repeated development synchronization.
  - Verified: 2026-10-20; refresh after 45 days.
- **Synchronizing with Effects:** https://react.dev/learn/synchronizing-with-effects
  - Scope: React v19.3 documentation read 2026-10-10; check the target application's installed version.
  - Use: Events versus synchronization; dependency declarations; abort or ignore stale asynchronous completions; cleanup.
  - Verified: 2026-10-10; refresh after 45 days.
- **Preserving and Resetting State:** https://react.dev/learn/preserving-and-resetting-state
  - Scope: React v19.3 documentation read 2026-10-10; check the target application's installed version.
  - Use: Component position and keys determine state lifetime; moving/reordering views must preserve stable entity identity.
  - Verified: 2026-10-10; refresh after 45 days.
- **Matt Pocock skills:** https://github.com/mattpocock/skills
  - Scope: `main` commit `4588b32ecab9ecc9fc8cc6b6c5e7d675b6004b0d`, fetched 2026-10-05 per the existing package metadata; original adopted pattern from commit `3cca18b368ae95cdbdebbff572ccafa662551015`.
  - Use: Community reference for small composable skill packaging and explicit separation between a router and a reusable discipline. Never authority over React behavior.
  - Verified: 2026-11-03 per existing package metadata; refresh after 30 days.

## Research notes

- Adopted: the repository's explicit distinction between routing/orchestration and reusable discipline invoked by the model, visible in the current `ask-matt` router and repository skill organization. Revision: https://github.com/mattpocock/skills/commit/3cca18b368ae95cdbdebbff572ccafa662551015
- Adapted: that separation becomes a boundary rule specific to React. React owns component and hook semantics; Next.js owns framework server, routing, and cache semantics; TypeScript joins only when language behavior is material.
- Rejected: the repository's broader workflow from idea to ship and its user command flow are not imported into this specialist skill because they would add process that does not improve React decisions.
- Concepts adopted from primary sources: derive renderable values instead of synchronizing duplicate state; reserve Effects for external synchronization; make cleanup match setup; treat keys as state identity when a subtree must reset.

## Interpretation rules

- Prefer the primary official/spec/reference source over community conventions when they conflict.
- Resolve the actual product, language, runtime, provider, platform, protocol, or standard version before applying details that can drift.
- Treat examples as examples, not proof that the current repository/runtime behaves the same way.
- Preserve unknowns and source conflicts explicitly; do not merge incompatible guidance into a false universal rule.
- Keep operational checks in the real target environment whenever the claim depends on runtime behavior.
