---
name: vue-engineering
description: Engineer Vue component and composable behavior where Vue reactivity, computed state, watchers, component contracts, routing, or hydration is material. Use when the live task is specifically about Vue, the Composition API, Vue Router, or Vue behavior inside Nuxt; do not generalize Vue-only rules into Nuxt server data behavior.
---

# Vue Engineering

## Scope and routing

- Broader skill: `frontend-engineering`.
- Required skill: `verification`.
- Select this skill for Vue reactivity, component contracts, composables, lifecycle, Vue Router behavior, and Vue-side hydration behavior.
- For a Nuxt task, this skill owns Vue component and reactive semantics. Nuxt data fetching, server/client execution, payload hydration, and state shared across requests require evidence specific to Nuxt from the maintained source map.
- Compose `typescript-javascript-engineering` only when types, module resolution, or runtime language behavior materially affects the solution.
- Quoted, historical, negated, fixture-only, or example Vue text is not a live trigger.

## Decision criteria

### Reactive state

Choose `ref()` or `reactive()` based on the shape and ownership of the state, then preserve its reactive boundary. Remember that `reactive()` returns a proxy and that destructuring a reactive property into an ordinary local can disconnect later reads from that proxy. Do not depend on proxy identity for serialization or external equality contracts.

Use `computed()` for derived values. Computed getters should remain pure and their results should be treated as derived snapshots. Use `watch()` when a specific reactive source must trigger a side effect, and `watchEffect()` when dependency tracking should follow the reactive reads performed by the effect itself.

For async watcher effects, invalidate prior work when the source changes. A previous completion must not overwrite current data, loading, error, or focus state. Register `onWatcherCleanup()` synchronously in Vue 3.5+ before the first `await`, or use the callback's `onCleanup` argument. Watchers created synchronously in setup stop on unmount; watchers created asynchronously need explicit stop handles. Choose watcher flush timing based on when the DOM must be read.

For requests driven by a route or resource identity, watch that identity and an explicit retry signal with `{ immediate: true }`. Clear prior result and error state. Cleanup must abort prior work **and** invalidate its active flag because a service can still resolve after abort. Check that flag before updating data, errors, loading, or deferred focus. Async `watchEffect()` only tracks reads before its first `await`; prefer explicit `watch()` sources for route and retry dependencies. See [async watcher contracts](references/vue-async-contracts.md) when implementing this behavior.

Avoid deep watchers as a substitute for identifying the actual changed source. Prefer a narrower source, getter, or explicit state model when only part of a large object drives the effect.

### Components and composables

Keep props as inputs and emitted events or explicit callbacks as outputs unless the component contract intentionally uses a binding. Keep composables focused on reusable stateful behavior, normalize ref or getter inputs when callers may pass either, and clean up subscriptions, timers, or other external resources in the lifecycle that owns them.

When a child edits a value owned by its parent, separate the parent's source of truth from the child's draft. Define when an incoming prop update resets the draft and emit only committed changes. Incidental nested mutation or watcher feedback must never write edits back to the parent.

Copy editable prop fields into the child's draft instead of sharing nested mutable objects. Watch the record identity and an explicit reset signal, for example `watch([() => props.record.id, () => props.resetEpoch], restoreDraft, { immediate: true })`. Changing identity, including returning to a previous ID, or requesting reset restores the draft; refreshing the same record leaves unsaved edits intact. Cancel restores the latest parent fields and clears validation. Input and invalid saves must never emit commits; a valid save emits one copied payload. Focus the invalid field once the DOM updates, without a watcher echo.

Each form owns its draft and reset signal; resetting one must preserve unsaved edits and validation in sibling forms. Invalidate any pending validation, commit, or `nextTick()` focus on identity change, reset, cancel, or unmount. A stale completion must not emit, replace validation, or move focus. See [form draft contracts](references/vue-async-contracts.md) when editing these workflows.

Treat the existing rendered interface as part of the component contract. Preserve labels, focus destinations, accessible status elements, stable integration selectors, and user interactions when repairing reactivity. Moving an accessibility attribute or replacing an element can break consumers even when the Vue code compiles.

Do not hide mutation between components in module singletons. In SSR environments, verify whether shared mutable state is scoped to an individual request before placing it outside component setup.

### Client navigation

With the native History API, `history.pushState()` does not fire `popstate`. Update reactive route state when pushing an entry, handle back and forward through `popstate`, and remove manually installed listeners on unmount. When Vue Router is installed, use its navigation API and reactive route instead of a parallel history listener.

Focus ownership survives a route change. A navigation started from an input leaves that input as the focused element: restore it in `nextTick()` only when it was the active element before the update, and do not move focus to a heading as a side effect of the same load. A completion may move focus only when focus is not already inside a control the user is operating. A heading or retry target takes focus when the load failed, or when the navigation came from outside the form, not when the user submitted from the field they are still using. Focusing every successful load looks correct in isolation and silently steals the caret from the person typing.

### Nuxt boundary

When the task is Nuxt, distinguish `$fetch` from `useFetch` and `useAsyncData`, which support SSR and hydration. Data fetched on the server that must hydrate without a duplicate browser request needs the Nuxt data utilities. Shared async data keys also share reactive state; key choice and consistent options are part of the contract.

## Boundary verification

Identify the installed Vue version, Composition or Options API convention, router or Nuxt version, and whether the changed code executes during SSR, hydration, client navigation, or all three.

- Exercise the state transition that should trigger a computed value or watcher and one transition that should not.
- Verify watcher or composable cleanup on dependency change and unmount when external work is involved.
- Start a slow request, navigate to a faster one, and let the slow request settle even after abort. Verify current data, loading and error state, and focus, including retry, empty, and unmount cases. Assert watcher, listener, and pending resource counts return to baseline after unmount and do not grow across navigation and retries.
- Keep a child draft dirty during a parent refresh of the same identity, switch identities and return, then exercise explicit reset, cancel, invalid save focus, and commit counts. With two dirty sibling forms, reset one and verify the other remains untouched. Change identity while validation or focus is pending and verify old work has no effect.
- For routing, exercise direct and client navigation, back and forward, params or query changes, and guard or listener cleanup.
- For SSR or Nuxt, compare server output with hydrated client state and check for duplicate requests or state leaked between requests.
- Preserve repository-native controls and semantic HTML. Do not recreate shared controls locally when the project already defines them.
- Exercise the repaired component in a real browser when the contract includes focus, keyboard navigation, asynchronous state, or rendering. Check accessible loading and error semantics, focus across transitions, narrow viewports, and persisted preferences when promised. Syntax checks or isolated assertions do not prove those interactions work.
- If the browser cannot launch or times out, record its tooling error separately from application failures. Run available production builds and component state checks, mark browser focus, keyboard, viewport, and lifecycle behavior unverified, and rerun browser checks when the environment works. A browser startup failure proves neither a component defect nor a successful interaction.
- Do not claim completion from a production build alone when the changed contract is reactive or hydration behavior.

## Fixed harness inputs

A task or fixture may mark harness files, shared controls, or starting data as evaluator owned. Treat those as immutable: change only the candidate component or file the task names, and leave the harness, shared control, and supplied data byte for byte. Record the framework version, the execution context, and the observed failure and recovery in the report format the task supplies, using the exact field names and check identifiers it lists.

Use [the maintained source map](references/sources.md) for Vue and Nuxt behavior that can vary by framework version.
