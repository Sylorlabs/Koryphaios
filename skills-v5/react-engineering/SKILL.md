---
name: react-engineering
description: Engineer React component and hook behavior where React state identity, render purity, effects, composition, or rerender cost is material. Use when the live task is specifically about a React component, hook, state flow, JSX tree, or React runtime behavior; route framework-owned server, routing, and cache concerns to the matching framework skill.
---

# React Engineering

## Scope and routing

- Broader skill: `frontend-engineering`.
- Required skill: `verification`.
- Select this skill for React runtime semantics: component state, hooks, render behavior, effects, context, keys, refs, or component composition.
- In a Next.js app, let `nextjs-engineering` own Server Components, Client Component boundaries, routing, caching, revalidation, Server Actions, and deployment behavior. Compose this skill only when the problem also depends on React component or hook semantics.
- Compose `typescript-javascript-engineering` only when types, module resolution, emitted JavaScript, or runtime language behavior materially affects the solution. A `.tsx` file alone is not enough.
- Quoted, historical, negated, fixture-only, or example React text is not a live trigger.

## Decision criteria

### State and identity

Keep the minimum source of truth. If a value can be calculated from current props or state during render, derive it there instead of storing and synchronizing a second copy. Place local interaction state at the lowest owner that needs it; keep URL state, server data, and external-store state in their actual systems unless the product requires a local draft.

Treat keys as identity, not warning suppressors. When a conceptual entity changes and its subtree should reset, make that identity explicit with the key or ownership boundary instead of adding synchronization effects.

### Events, rendering, and effects

Rendering must stay pure. Put logic caused by a specific user action in that event path. Use an Effect when rendering must synchronize with an external system such as a subscription, browser API, imperative widget, timer, or network process whose lifetime follows rendered state.

Effect dependencies follow the values used by the Effect. Do not hide dependencies to force a preferred schedule. Cleanup must undo or invalidate the same external work the Effect started, including stale async results where cancellation is unavailable. Development remounts or repeated synchronization should expose missing cleanup, not be patched around with one-time flags.

### Component boundaries and performance

Prefer data flow through explicit props and composition. Use context for genuinely shared ambient concerns, not to avoid ordinary ownership decisions. Preserve semantic HTML and repository design-system primitives.

Do not add `memo`, `useMemo`, or `useCallback` by reflex. Use them when there is a concrete expensive recomputation, referential contract, or measured rerender problem, then verify that the dependency and identity assumptions hold.

## Boundary verification

Before changing behavior, identify the installed React version, renderer or framework, relevant Strict Mode behavior, and the component that actually owns the state or external synchronization.

Verify the boundary that changed:

- Exercise the real interaction and rerender path, including prop or key changes that alter identity.
- For Effects, exercise setup, dependency change, cleanup, unmount or navigation, and the highest-risk stale async or race path.
- For controlled inputs or shared state, verify both the source-of-truth update and the rendered result.
- For performance work, use a representative production build or profiler evidence rather than render-count intuition alone.
- Do not claim completion from typecheck, compilation, or a static screenshot when the changed contract is runtime behavior.

Use [the maintained source map](references/sources.md) when a React behavior is version-sensitive or when framework behavior may override a generic React assumption.
