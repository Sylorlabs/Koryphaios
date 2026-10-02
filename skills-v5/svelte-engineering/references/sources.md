# Source map

`svelte-engineering` is an individually authored V5 skill package; empirical qualification is tracked separately in the audit/evaluation ledger. These maintained sources bound factual and version-sensitive guidance; qualification is tested with hierarchy-aware held-out routing, paired same-model skill/no-skill tasks, and independent blind evaluation.

## Qualification basis

- Hierarchy: broader frontend-engineering.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held-out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no-skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **Svelte documentation:** https://svelte.dev/docs/svelte/overview
  - Scope: Svelte documentation as fetched 2026-09-06.
  - Use: Primary authority for Svelte components, runes, lifecycle, stores, and legacy APIs.
  - Verified: 2026-09-06; refresh after 45 days.
- **`$state`:** https://svelte.dev/docs/svelte/$state
  - Scope: Current Svelte rune reference as fetched 2026-09-06.
  - Use: Reactive state, deep proxies, snapshots, and destructuring behavior.
  - Verified: 2026-09-06; refresh after 45 days.
- **`$derived`:** https://svelte.dev/docs/svelte/$derived
  - Scope: Current Svelte rune reference as fetched 2026-09-06.
  - Use: Derived reactive state and dependency propagation.
  - Verified: 2026-09-06; refresh after 45 days.
- **`$effect`:** https://svelte.dev/docs/svelte/$effect
  - Scope: Current Svelte rune reference as fetched 2026-09-06.
  - Use: Browser-only effects, dependency tracking, teardown, and guidance against using effects to synchronize application state.
  - Verified: 2026-09-06; refresh after 45 days.
- **Legacy reactive statements:** https://svelte.dev/docs/svelte/legacy-reactive-assignments
  - Scope: Current legacy API reference as fetched 2026-09-06.
  - Use: Compiler-visible dependencies and ordering constraints in legacy `$:` code.
  - Verified: 2026-09-06; refresh after 45 days.
- **Matt Pocock skills:** https://github.com/mattpocock/skills
  - Scope: `main` commit `3cca18b368ae95cdbdebbff572ccafa662551015`, authored 2026-09-04T08:43:27Z; repository `package.json` reports `mattpocock-skills` 1.2.3.
  - Use: Community packaging reference for focused composable skill responsibilities and separate routing. Never authority over Svelte behavior.
  - Verified: 2026-09-06; refresh after 30 days.

## Research notes

- Adopted: Matt Pocock's current repository uses small reusable skill disciplines under explicit routing. Revision: https://github.com/mattpocock/skills/commit/3cca18b368ae95cdbdebbff572ccafa662551015
- Adapted: Svelte routing first distinguishes runes, legacy reactivity, and SvelteKit SSR or hydration boundaries, then applies only the relevant reactive rules.
- Rejected: no unrelated idea-to-ship, issue-tracker, or review workflow is imported into this entrypoint.
- Primary-source concepts adopted: `$state` may deeply proxy simple objects and arrays; destructured values are not live reactive references; `$effect` runs in the browser, tracks synchronously read reactive values, supports teardown, and should not be the default tool for synchronizing application state; legacy `$:` dependencies remain compiler-visible and can be obscured by indirection.

## Interpretation rules

- Prefer the primary official/spec/reference source over community conventions when they conflict.
- Resolve the actual product, language, runtime, provider, platform, protocol, or standard version before applying details that can drift.
- Treat examples as examples, not proof that the current repository/runtime behaves the same way.
- Preserve unknowns and source conflicts explicitly; do not merge incompatible guidance into a false universal rule.
- Keep operational checks in the real target environment whenever the claim depends on runtime behavior.
