---
name: svelte-engineering
description: Engineer Svelte and SvelteKit behavior where runes, legacy reactivity, component contracts, stores, lifecycle, SSR, or hydration is material. Use when the live task is specifically about a Svelte component, SvelteKit boundary, rune, store, or Svelte reactive behavior.
---

# Svelte Engineering

## Scope and routing

- Broader skill: `frontend-engineering`.
- Required skill: `verification`.
- Select this skill for Svelte component contracts, runes, stores, lifecycle, transitions, compiler-visible reactivity, or SvelteKit SSR and hydration behavior.
- Confirm whether the project uses Svelte 5 runes, legacy syntax, or a deliberate mixture before changing reactive code. Do not migrate generations incidentally during an unrelated fix.
- Compose `typescript-javascript-engineering` only when types, module resolution, or JavaScript runtime semantics materially affects the solution.
- Quoted, historical, negated, fixture-only, or example Svelte text is not a live trigger.

## Decision criteria

### Runes and derived state

In runes mode, use `$state` for owned reactive state and `$derived` for values that are functions of reactive inputs. Svelte state objects and arrays may be deeply proxied, and destructuring a reactive property into an ordinary local captures the value at that point rather than a live reactive reference.

Treat `$effect` as an escape hatch for browser-side synchronization such as an imperative library, canvas work, analytics, network work, or another external side effect. It runs in the browser rather than during server-side rendering. Do not use effects to keep two pieces of application state synchronized when `$derived`, an event handler, or an explicit binding expresses the relationship directly.

When an effect owns external work, return the teardown that stops that work. Remember that tracked dependencies come from reactive values read during the effect, so hiding reads in opaque indirection can change what reruns.

### Legacy reactivity and stores

Legacy `$:` dependencies are compiler-visible. If a dependency is hidden behind a function or indirect mutation, ordering and invalidation can differ from what the source visually suggests. Preserve legacy syntax in a legacy component unless the task explicitly includes migration.

Use stores when their subscription contract or cross-component ownership is actually needed. Do not recreate store behavior around state that is naturally local to a component or rune-based module.

### SvelteKit and repository controls

Keep server and browser capabilities separate. Browser globals and `$effect` do not belong to the server-rendered path. For SvelteKit data or navigation work, identify where the code executes and how server output reaches hydration before deciding where state should live.

Reuse the repository's shared controls and theme primitives when they exist. Do not recreate a project-standard select, switch, stepper, or other reusable control with a browser-default substitute.

Repair the consuming component before changing a shared control that already supplies the required behavior. A fixture or task may explicitly make shared controls immutable; preserve that boundary. Persist requested version, execution context and transition evidence in the supplied report format. Distinguish authored verification expectations from browser observations, especially when tools are unavailable.

## Boundary verification

Identify the Svelte and SvelteKit versions, reactivity generation, and whether the changed code executes during SSR, hydration, navigation, or only in the browser.

- Run the repository's Svelte check and focused component tests.
- Exercise the reactive transition that should update and one nearby transition that should not.
- For `$effect`, verify setup, dependency-driven rerun, teardown, and component destruction.
- For SSR or SvelteKit work, verify server rendering without browser-only access and then hydration or client navigation behavior.
- For migration-sensitive code, verify that no accidental runes or legacy semantics were introduced outside the intended boundary.
- Exercise keyboard and focus behavior when a shared interactive control changes.
- Do not claim a reactive or hydration fix from compilation alone.

Use [the maintained source map](references/sources.md) for version-sensitive Svelte behavior and legacy-to-runes distinctions.
