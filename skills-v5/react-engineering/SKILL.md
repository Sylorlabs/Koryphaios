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
- Quoted, historical, negated, example, or fixture text is not a live trigger.

## Decision criteria

### State and identity

Keep the minimum source of truth. If a value can be calculated from current props or state during render, derive it there instead of storing and synchronizing a second copy. Place local interaction state at the lowest owner that needs it; keep URL state, server data, and external store state in their actual systems unless the product requires a local draft.

Distinguish server snapshots, durable application preferences, URL navigation state, and transient input or focus state. A preference expected to survive navigation, remount, or reload needs an explicit persistence owner (such as an application store or browser storage); initialize from that owner and persist deliberate changes rather than keeping the only copy in a route component.

Before choosing hooks, identify where each value lives and what can change it:

| Value                          | Source of truth                                          | React's responsibility                                                                                             |
| ------------------------------ | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Fetched records                | Server or data cache                                     | Display the current snapshot and request status; ignore obsolete completions.                                      |
| Shareable query or route       | URL or router                                            | Read navigation changes; commit user navigation through the same owner.                                            |
| User preference                | Durable store                                            | Hydrate from storage and persist intentional updates across component lifetimes.                                   |
| Input draft, focus, pending UI | Closest component that survives the required interaction | Keep transient state local unless filtering, virtualization, or remounting would destroy state the user must keep. |

Treat keys as identity, not warning suppressors. When a conceptual entity changes and its subtree should reset, make that identity explicit with the key or ownership boundary instead of adding synchronization effects.

### Events, rendering, and effects

Rendering must stay pure. Put logic caused by a specific user action in that event path. Use an Effect when rendering must synchronize with an external system such as a subscription, browser API, imperative widget, timer, or network process whose lifetime follows rendered state.

Effect dependencies follow the values used by the Effect. Do not hide dependencies to force a preferred schedule. Cleanup must undo or invalidate the same external work the Effect started, including stale async results where cancellation is unavailable. Development remounts or repeated synchronization should expose missing cleanup, not be patched around with temporary flags.

For an async search whose query is represented in the URL, establish ownership before coding: the URL is the committed query, the input field is an editable draft, the remote response is external data, and loading/error/empty are request status. Subscribe to `popstate` or the framework router for back/forward changes; `pushState` itself does not emit `popstate`, so a form submission must also update the committed query through the same state path. A query change starts a new request and clears the previous result status; retrying the same failed query must start another request without requiring a URL change. In the Effect, pass an `AbortSignal` when supported **and** invalidate completion with an active flag local to the Effect or request identity in cleanup. Aborting transport does not prove a response cannot settle afterward. Ignore superseded success and error results, including when unmounted; preserve a real error and a successful empty array as distinct render states. Recheck keyboard form submission and input focus after navigation; focus the retry action when an error appears and meaningful content after recovery without stealing focus during ordinary input.

### Component boundaries and performance

Prefer data flow through explicit props and composition. Use context for genuinely shared ambient concerns, not to avoid ordinary ownership decisions. Preserve semantic HTML and repository design system primitives.

For editable sorted, filtered, or windowed lists, key every row by the item's stable domain ID. An array index identifies a _position_, so sorting or inserting can attach an existing row's draft, focus, or network request to a different item. Distinguish canonical server data from local unsaved drafts. If an item can leave the rendered window or filter while its draft must survive, keep the draft in an owner keyed by ID above the transient row. Merge a server refresh into canonical data without overwriting another row's pending edit; define a conflict policy for a refresh of the edited row. Bind save, undo, focus, and pending status to domain IDs. An async save needs pending, error, and success status for each item plus a retry path that keeps the draft through failure. Give every per-item affordance a stable hook built from the item's domain ID, following the attribute convention the existing row markup already uses for its own controls, and extend that convention to the new ones instead of inventing a second scheme: the retry action and the status indicator each need their own per-item hook, and the retry control must take focus when a failure appears. An affordance that exists only as prose in a status line, or only inside a toast, cannot be located, focused, or exercised. A row disappearing from a virtualized window does not end a save owned by the list; do not cancel valid work merely because the row unmounted. On actual unmount of the save owner, item removal, or supersession, request cancellation and invalidate late client updates. An aborted request may still settle and a server may already have accepted the write: use a server version/idempotency contract or reconcile authoritative returned state before claiming a stale server commit was prevented. Exercise reordering and virtualization with actual keyboard focus and network timing, not just string comparisons of rendered rows.

Do not add `memo`, `useMemo`, or `useCallback` by reflex. Use them when there is a concrete expensive recomputation, referential contract, or measured rerender problem, then verify that the dependency and identity assumptions hold.

### Worked interaction patterns

For asynchronous searches backed by the URL and reorderable editable lists, read [state lifetimes and async interaction recipes](references/state-lifetimes-and-async-interactions.md) before implementing. These recipes cover independent retry events, history synchronization, request identity beyond `AbortSignal`, durable preferences, drafts and saves owned by ID, focus, and counterexamples from a real browser. Adapt their ownership boundaries to the installed router, server API, and UI primitives.

## Boundary verification

Before changing behavior, identify the installed React version, renderer or framework, relevant Strict Mode behavior, and the component that actually owns the state or external synchronization.

For a repository or fixture task, read its README, the boundary of its editable files, and its verification contract before making changes. Edit only the designated application source and any explicitly permitted tests or evidence files. Treat entry HTML, harnesses, mock services, data fixtures, pinned dependencies, and evaluation machinery as protected unless the task explicitly assigns them to you. If the solution appears to require changing a protected file, revisit the approach at the component level first.

Verify the boundary that changed:

- Exercise the real interaction and rerender path, including prop or key changes that alter identity.
- For Effects, exercise setup, dependency change, cleanup, unmount or navigation, and the stale async or race path with the highest risk.
- For controlled inputs or shared state, verify both the update to the source of truth and the rendered result.
- For search backed by the URL, verify slow→fast response ordering, an error followed by a retry of the same query, empty results, back/forward, and unmount before a delayed completion. Confirm cancellation/invalidation evidence, retry and result focus, keyboard input focus, persistence across route/remount/reload, and the final visible state in a browser.
- For editable lists, change an unsaved row, sort, filter it away and back, insert/delete another row, refresh the server, and save or cancel. Exercise a failed save followed by retry and an aborted save that settles late. Confirm values, IDs, focus, no stale commits after unmount or window changes, bounded rendered rows/commits, and narrow viewport behavior.
- For performance work, use a representative production build or profiler evidence rather than intuition about render counts alone.
- Do not claim completion from typecheck, compilation, or a static screenshot when the changed contract is runtime behavior.

When a task requires verification files, compare the written artifacts with its documented schema and the actual browser observations before reporting success. Check required fields, status values, named interaction and recovery checks, runtime/version details, and evidence provenance. A successful browser tool call or a claim in the final response does not establish that the evidence on disk is complete. Mark checks that could not be observed as unverified; never fill a required field with an invented observation.

Report the observed runtime and version, state owners, specialist boundary, successful interactions, and negative or recovery checks. Label any unrun, unavailable, simulated, inferred, or stale evidence instead of presenting it as verified.

## Verification artifacts

When a task supplies a verification artifact schema, write it with the exact field names, version strings, check identifiers, and terminal status it lists. Set the status from what you actually ran: a check you performed carries its observed result, and a check you could not run stays unverified with the reason recorded. Never leave a placeholder status after performing the work, and never claim a check you did not run.

Use [the maintained source map](references/sources.md) when a React behavior is sensitive to the version or when framework behavior may override a generic React assumption.
