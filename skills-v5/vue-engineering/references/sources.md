# Source map

`vue-engineering` is an individually authored V5 skill package; empirical qualification is tracked separately in the audit/evaluation ledger. These maintained sources bound factual and version-sensitive guidance; qualification is tested with hierarchy-aware held-out routing, paired same-model skill/no-skill tasks, and independent blind evaluation.

## Qualification basis

- Hierarchy: broader frontend-engineering.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held-out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no-skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **Vue documentation:** https://vuejs.org/guide/introduction.html
  - Scope: Vue documentation as fetched 2026-09-06.
  - Use: Primary authority for Vue component, Composition API, and lifecycle behavior.
  - Verified: 2026-09-06; refresh after 45 days.
- **Reactivity Fundamentals:** https://vuejs.org/guide/essentials/reactivity-fundamentals.html
  - Scope: Current Vue reactivity guide as fetched 2026-09-06.
  - Use: `ref`, `reactive`, proxy identity, ref unwrapping, and destructuring boundaries.
  - Verified: 2026-09-06; refresh after 45 days.
- **Computed Properties and Watchers:** https://vuejs.org/guide/essentials/computed and https://vuejs.org/guide/essentials/watchers.html
  - Scope: Current Vue guides as fetched 2026-09-06.
  - Use: Pure derived values versus reactive side effects, watcher source selection, cleanup, and async behavior.
  - Verified: 2026-09-06; refresh after 45 days.
- **Composables:** https://vuejs.org/guide/reusability/composables.html
  - Scope: Current Vue composable guidance as fetched 2026-09-06.
  - Use: Stateful reusable logic, `toValue`, reactive inputs, and lifecycle cleanup.
  - Verified: 2026-09-06; refresh after 45 days.
- **Nuxt 4 data fetching:** https://nuxt.com/docs/4.x/getting-started/data-fetching
  - Scope: Nuxt v4 documentation as fetched 2026-09-06.
  - Use: `$fetch`, `useFetch`, `useAsyncData`, payload hydration, shared keys, and SSR-aware fetching.
  - Verified: 2026-09-06; refresh after 30 days.
- **Matt Pocock skills:** https://github.com/mattpocock/skills
  - Scope: `main` commit `3cca18b368ae95cdbdebbff572ccafa662551015`, authored 2026-09-04T08:43:27Z; repository `package.json` reports `mattpocock-skills` 1.2.3.
  - Use: Community packaging reference for concise composable disciplines and explicit routing. Never authority over Vue or Nuxt behavior.
  - Verified: 2026-09-06; refresh after 30 days.

## Research notes

- Adopted: the current Matt Pocock repository separates routing from reusable model-invoked disciplines. Revision: https://github.com/mattpocock/skills/commit/3cca18b368ae95cdbdebbff572ccafa662551015
- Adapted: Vue routing is based on reactivity and component semantics, while Nuxt-specific server data and hydration claims require Nuxt evidence rather than being inferred from Vue alone.
- Rejected: the external repository's full engineering workflow is not copied into this skill because issue flow and TDD orchestration are outside the Vue specialist boundary.
- Primary-source concepts adopted: computed values remain pure derived state; watchers perform reactive side effects; reactive proxies and destructuring have identity/tracking consequences; Nuxt `useFetch` and `useAsyncData` preserve server-fetched data through hydration and differ from plain `$fetch`.

## Interpretation rules

- Prefer the primary official/spec/reference source over community conventions when they conflict.
- Resolve the actual product, language, runtime, provider, platform, protocol, or standard version before applying details that can drift.
- Treat examples as examples, not proof that the current repository/runtime behaves the same way.
- Preserve unknowns and source conflicts explicitly; do not merge incompatible guidance into a false universal rule.
- Keep operational checks in the real target environment whenever the claim depends on runtime behavior.
