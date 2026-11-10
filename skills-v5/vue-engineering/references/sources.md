# Source map

`vue-engineering` is an individually authored V5 skill package. Empirical qualification is recorded separately in the audit and evaluation ledger. These maintained sources ground facts that vary by version. Qualification uses routing that respects the skill hierarchy, withheld cases, paired tasks on the same model with and without the skill, and independent blind review.

## Qualification basis

- Hierarchy: broader frontend-engineering.
- Routing: five positive, five negative cases about neighboring skills, three compound or ambiguous, and three adversarial withheld cases through the real resolver.
- Full task evaluation: two individual scenarios with six falsifiable checks, pairing on the same model with and without the skill, retention of regressions, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **Vue documentation:** https://vuejs.org/guide/introduction.html
  - Scope: Vue documentation as fetched 2026-10-20.
  - Use: Primary authority for Vue component, Composition API, and lifecycle behavior.
  - Verified: 2026-10-20; refresh after 45 days.
- **Reactivity Fundamentals:** https://vuejs.org/guide/essentials/reactivity-fundamentals.html
  - Scope: Current Vue reactivity guide as fetched 2026-10-20.
  - Use: `ref`, `reactive`, proxy identity, ref unwrapping, and destructuring boundaries.
  - Verified: 2026-10-20; refresh after 45 days.
- **Computed Properties and Watchers:** https://vuejs.org/guide/essentials/computed and https://vuejs.org/guide/essentials/watchers.html
  - Scope: Computed guide fetched 2026-09-06; watcher guide inspected 2026-10-10.
  - Use: Pure derived values versus reactive side effects; watcher sources, immediate runs, synchronous `onWatcherCleanup` in Vue 3.5+, callback `onCleanup`, async tracking limits, flush timing, and disposal.
  - Verified: Computed 2026-09-06; watchers 2026-10-10; refresh after 45 days.
- **Composables:** https://vuejs.org/guide/reusability/composables.html
  - Scope: Current Vue composable guidance as fetched 2026-09-06.
  - Use: Stateful reusable logic, `toValue`, reactive inputs, and lifecycle cleanup.
  - Verified: 2026-09-06; refresh after 45 days.
- **Nuxt 4 data fetching:** https://nuxt.com/docs/4.x/getting-started/data-fetching
  - Scope: Nuxt v4 documentation for data fetching as inspected 2026-11-07.
  - Use: `$fetch`, `useFetch`, `useAsyncData`, payload hydration, shared keys, and fetching that preserves SSR data.
  - Verified: 2026-11-07; refresh after 30 days.
- **Browser History API:** https://developer.mozilla.org/en-US/docs/Web/API/Window/popstate_event
  - Scope: Browser navigation events as inspected 2026-10-10.
  - Use: `pushState` and `replaceState` do not emit `popstate` on their own; history traversal does. Keep manual history listeners paired with teardown.
  - Verified: 2026-10-10; refresh after 45 days.
- **Matt Pocock skills:** https://github.com/mattpocock/skills
  - Scope: `main` commit `4588b32ecab9ecc9fc8cc6b6c5e7d675b6004b0d` fetched 2026-11-07.
  - Use: Community packaging reference for concise composable disciplines and explicit routing. This does not override Vue or Nuxt documentation.
  - Verified: 2026-11-03; refresh after 30 days.

## Research notes

- Adopted: the inspected Matt Pocock repository separates routing from reusable model-invoked disciplines. Revision: https://github.com/mattpocock/skills/commit/4588b32ecab9ecc9fc8cc6b6c5e7d675b6004b0d
- Adapted: Vue routing is based on reactivity and component semantics, while Nuxt server data and hydration claims require evidence specific to Nuxt.
- Rejected: the external repository's full engineering workflow is not copied into this skill because issue flow and TDD orchestration are outside the Vue specialist boundary.
- Primary-source concepts adopted: computed values remain pure derived state; watchers perform reactive side effects; reactive proxies and destructuring have identity/tracking consequences; Nuxt `useFetch` and `useAsyncData` preserve server-fetched data through hydration and differ from plain `$fetch`.
- Vue native fixture contract: `backend/src/kory/skill-eval-vue-browser-runtime.ts` intentionally resolves a delayed request after abort, records disposal of watchers and resources, and checks browser history, error recovery, and focus. Its child draft fixture checks a parent refresh of the same identity, ID reuse, reset, cancel, validation focus, and exactly one commit emit. These are test contracts, not fresh campaign or browser results.

## Interpretation rules

- Prefer the primary official/spec/reference source over community conventions when they conflict.
- Resolve the actual framework, runtime, or platform version before applying details that can drift.
- Treat examples as examples, not proof that the current repository/runtime behaves the same way.
- Preserve unknowns and source conflicts explicitly; do not merge incompatible guidance into a false universal rule.
- Keep operational checks in the real target environment whenever the claim depends on runtime behavior.
