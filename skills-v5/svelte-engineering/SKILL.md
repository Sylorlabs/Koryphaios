---
name: svelte-engineering
description: Engineer Svelte and SvelteKit behavior where runes, legacy reactivity, component contracts, stores, lifecycle, SSR, or hydration is material. Use when the live task is specifically about a Svelte component, SvelteKit boundary, rune, store, or Svelte reactive behavior.
---

# Svelte Engineering

## Scope and routing

- Broader skill: `frontend-engineering`.
- Required skill: `verification`.
- Select this skill for Svelte component contracts, runes, stores, lifecycle, transitions, reactivity visible to the compiler, or SvelteKit SSR and hydration behavior.
- Confirm whether the project uses Svelte 5 runes, legacy syntax, or a deliberate mixture before changing reactive code. Do not migrate generations incidentally during an unrelated fix.
- Compose `typescript-javascript-engineering` only when types, module resolution, or JavaScript runtime semantics materially affects the solution.
- Quoted, historical, negated, fixture content, or example Svelte text is not a live trigger.

## Decision criteria

### Runes and derived state

In runes mode, use `$state` for owned reactive state and `$derived` for values that are functions of reactive inputs. Svelte state objects and arrays may be deeply proxied, and destructuring a reactive property into an ordinary local captures the value at that point rather than a live reactive reference.

Trace the user-visible update before changing it: identify the source of truth, the event that changes it, the derived value, the rendered consumer, and any server or persistence boundary. A local `$state` initialized from a prop is a separate owner and will not automatically adopt later parent changes; preserve the intended controlled or draft contract. Avoid assigning a copied snapshot of a reactive object when subsequent nested edits must be observed. When adapting a reusable control, inspect its actual props, callback/binding, and event contract in the installed version; do not guess that native DOM events and component callbacks are interchangeable.

Treat `$effect` as an escape hatch for browser synchronization such as an imperative library, canvas work, analytics, network work, or another external side effect. It runs in the browser rather than during server rendering. Do not use effects to keep two pieces of application state synchronized when `$derived`, an event handler, or an explicit binding expresses the relationship directly.

When an effect owns external work, return the teardown that stops that work. Remember that tracked dependencies come from reactive values read during the effect, so hiding reads in opaque indirection can change what reruns.

### Legacy reactivity and stores

Legacy `$:` dependencies must be visible to the compiler. If a dependency is hidden behind a function or indirect mutation, ordering and invalidation can differ from what the source visually suggests. Preserve legacy syntax in a legacy component unless the task explicitly includes migration.

Use stores when their subscription contract or ownership shared across components is actually needed. Do not recreate store behavior around state that is naturally local to a component or module using runes.

### Async updates, identity, and teardown

For a filtered, sorted, virtualized, or editable `{#each}` list, choose keys from stable domain identities instead of array positions. Keep unsaved edits and pending operation identities in an owner that survives row recycling. Define what happens when a selection disappears, the list changes, or a server refresh conflicts with a dirty draft; avoid silently moving one item's state to another row.

For asynchronous requests, track the input or revision that launched each attempt. Invalidate stale successes **and** stale failures when a newer query, navigation, or component teardown supersedes them; an abort request alone does not prove an ignored result cannot arrive. Distinguish pending, empty success, failure, cancelled, and retry states. A retry of the same input still needs a new attempt identity. When saving, keep client cancellation separate from whether the server has already committed, and preserve a recoverable local draft until the result is confirmed.

Keep browser-only listeners, subscriptions, timers, observers, and imperative integrations behind the correct client lifecycle and remove them when their owning effect or component ends. Verify that reruns do not accumulate handlers or reopen a completed request; do not use a one-time global flag to hide an incorrect dependency or ownership boundary.

### Workspace and dependency boundary

The runtime a task hands you is the runtime to measure. Treat an installed Svelte compiler, browser harness, and test runner as fixed host capability: do not add dependencies, edit `package.json`, or run a package install to obtain a tool, because the install can spend the whole turn, change lock state the task did not ask for, and still leave the check unrun. Do not scaffold a new application or build configuration to observe a component that already has a harness. When a tool is genuinely absent, record the check as unverified with the missing tool named, and report which observations you could still make.

### SvelteKit and repository controls

Keep server and browser capabilities separate. Browser globals and `$effect` do not belong to the server-rendered path. For SvelteKit data or navigation work, identify where the code executes and how server output reaches hydration before deciding where state should live.

For URL- or server-owned state, inspect the route loader, action, navigation/invalidation flow, and client hydration contract before introducing a local copy. Confirm how a browser Back/Forward navigation updates displayed values and whether reload preserves the intended state. Do not describe an SSR path as verified after testing only client navigation, or the reverse.

Reuse the repository's shared controls and theme primitives when they exist. Do not recreate a project-standard select, switch, stepper, or other reusable control with a browser-default substitute.

Repair the consuming component before changing a shared control that already supplies the required behavior. A fixture or task may explicitly make shared controls immutable; preserve that boundary.

A file the task marks as harness, fixture, evaluator owned, generated, or fixed is read only even when it looks wrong. Editing it is not a repair, it invalidates the run, and the work is discarded. When such a control genuinely misbehaves, the fix belongs in the consumer, and the suspected defect belongs in the verification record. Persist requested version, execution context and transition evidence in the supplied report format. Distinguish authored verification expectations from browser observations, especially when tools are unavailable.

## Boundary verification

Identify the Svelte and SvelteKit versions, reactivity generation, and whether the changed code executes during SSR, hydration, navigation, or only in the browser.

- Run the repository's Svelte check and focused component tests.
- Exercise the reactive transition that should update and one nearby transition that should not.
- For an async control or searchable list, exercise request A followed by B with B resolving first, then A resolving or failing late; retry the same failed input and navigate away while a request is pending. Assert the final visible identity, status, and focus.
- For an editable collection, edit an item, reorder/filter or virtualize it away and back, then save, fail, and retry; assert stable ID ownership, draft retention, and that late completions cannot update the wrong row.
- For `$effect`, verify setup, dependency-driven rerun, teardown, and component destruction.
- For SSR or SvelteKit work, verify server rendering without browser-only access and then hydration or client navigation behavior.
- For migration-sensitive code, verify that no accidental runes or legacy semantics were introduced outside the intended boundary.
- Exercise keyboard and focus behavior when a shared interactive control changes.
- Do not claim a reactive or hydration fix from compilation alone.

## Verification artifacts

The task packet decides whether a verification schema applies. When the workspace ships result or verification files, or the task text names them, that schema applies, and the files are part of the deliverable rather than a summary of it. Write them with the exact field names, version strings, check identifiers, and terminal status the packet lists.

Order the turn around that contract. Create or open the artifact while the work is still in progress and record the environment facts you already hold, because a turn that runs out of time or dies inside a runtime attempt still has to leave a document behind. Update each field as its observation happens rather than holding the whole document until the end. An unfinished artifact is the one defect that erases every other result in the same turn.

The artifact is a file in the workspace, not a section of your final message. A prose summary that describes what you would have checked leaves the deliverable missing.

Set the status from what you actually ran: a check you performed carries its observed result, and a check you could not run stays unverified with the reason recorded. Never leave a placeholder status after performing the work, and never claim a check you did not run. Before you stop, reopen the artifact files and confirm that no `TODO` or placeholder value survives in a field you had the evidence to fill.

Use [the maintained source map](references/sources.md) for version-sensitive Svelte behavior and legacy-to-runes distinctions.
