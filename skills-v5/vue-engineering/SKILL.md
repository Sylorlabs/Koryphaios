---
name: vue-engineering
description: Engineer Vue component and composable behavior where Vue reactivity, computed state, watchers, component contracts, routing, or hydration is material. Use when the live task is specifically about Vue, the Composition API, Vue Router, or Vue behavior inside Nuxt; do not generalize Vue-only rules into Nuxt server data behavior.
---

# Vue Engineering

## Scope and routing

- Broader skill: `frontend-engineering`.
- Required skill: `verification`.
- Select this skill for Vue reactivity, component contracts, composables, lifecycle, Vue Router behavior, and Vue-side hydration behavior.
- For a Nuxt task, this skill owns Vue component and reactive semantics. Nuxt data fetching, server/client execution, payload hydration, and request-scoped state require Nuxt-specific evidence from the maintained source map.
- Compose `typescript-javascript-engineering` only when types, module resolution, or runtime language behavior materially affects the solution.
- Quoted, historical, negated, fixture-only, or example Vue text is not a live trigger.

## Decision criteria

### Reactive state

Choose `ref()` or `reactive()` based on the shape and ownership of the state, then preserve its reactive boundary. Remember that `reactive()` returns a proxy and that destructuring a reactive property into an ordinary local can disconnect later reads from that proxy. Do not depend on proxy identity for serialization or external equality contracts.

Use `computed()` for derived values. Computed getters should remain pure and their results should be treated as derived snapshots. Use `watch()` when a specific reactive source must trigger a side effect, and `watchEffect()` when dependency tracking should follow the reactive reads performed by the effect itself.

Avoid deep watchers as a substitute for identifying the actual changed source. Prefer a narrower source, getter, or explicit state model when only part of a large object drives the effect.

### Components and composables

Keep props as inputs and emitted events or explicit callbacks as outputs unless the component contract intentionally uses a binding. Keep composables focused on reusable stateful behavior, normalize ref or getter inputs when callers may pass either, and clean up subscriptions, timers, or other external resources in the lifecycle that owns them.

Do not hide cross-component mutation in module singletons. In SSR environments, verify whether shared state is request-scoped before placing mutable reactive state outside component setup.

### Nuxt boundary

When the task is Nuxt, distinguish `$fetch` from SSR-aware `useFetch` and `useAsyncData`. Initial server data that must hydrate without a duplicate browser request belongs on the SSR-aware path. Shared async-data keys also share reactive state, so key choice and option consistency are part of the contract.

## Boundary verification

Identify the installed Vue version, Composition or Options API convention, router or Nuxt version, and whether the changed code executes during SSR, hydration, client navigation, or all three.

- Exercise the state transition that should trigger a computed value or watcher and one transition that should not.
- Verify watcher or composable cleanup on dependency change and unmount when external work is involved.
- For routing, exercise direct navigation, client navigation, params or query changes, and the relevant guard or cleanup path.
- For SSR or Nuxt, compare server-rendered state with hydrated client state and check for duplicate requests or request-leaked state.
- Preserve repository-native controls and semantic HTML. Do not recreate shared controls locally when the project already defines them.
- Do not claim completion from a production build alone when the changed contract is reactive or hydration behavior.

Use [the maintained source map](references/sources.md) for Vue and Nuxt behavior that can vary by framework version.
