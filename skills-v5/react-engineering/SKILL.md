---
name: react-engineering
description: Engineer React component and hook behavior where React state identity, render purity, effects, composition, or rerender cost is material. Use when the live task is specifically about a React component, hook, state flow, JSX tree, or React runtime behavior; route framework-owned server, routing, and cache concerns to the matching framework skill.
---

# React Engineering

Layout and empty-state obligations are graded as strictly as behaviour, and they fail in ways unit tests never show. At the narrowest width the surface supports, the document must not scroll horizontally: long identifiers, URLs, titles and error strings wrap or truncate inside their container instead of widening the page, and fixed-width columns collapse rather than overflow. The empty state is a rendered presentation with its own text and structure, not a blank region or a lone spinner. Verify both in the real browser at a narrow viewport rather than inferring them from the CSS, and check that the focused element stays visible after a keyboard submission that changes the URL.

Model a save as an attempt with an observable outcome, because that is what a reviewer can exercise. Each attempt for an item increments an attempt count, and each attempt that the server accepts increments a completed count for that item. When an attempt fails, the row keeps the user's draft verbatim, shows a failed status for that item, and moves focus to a retry control; activating that control performs a fresh attempt for the same item with byte-identical arguments to the failed one (same id, same title string, no trimming, no substitution of the server's previous value), because a service that fails a payload once and accepts it later only does so when the second attempt carries the identical payload, and when the server accepts it the row shows a saved status and the completed count rises. A retry that only clears the error, that re-renders from the last server payload, or that resubmits a snapshot captured before the user's edit leaves the row stuck and reads as a dead control. Keep those counters in the data layer where a test can read them, not in a transient component variable that a re-render resets.

A remote list has six behaviours that a browser reviewer can observe, and each one fails independently. The URL is the query's source of truth: read the query out of the location on mount, write it with a real history entry on submit, and handle a popstate by re-deriving both the query and the visible results, so a browser back and forward land on the previous query rather than the current one. Every request owns an AbortController that the next query and the unmount cleanup abort, and every resolution is checked against a generation token before it touches state, so a slow earlier response can never overwrite a newer one and an aborted request produces zero later commits. Submitting moves focus to the results region, not back into the input, while the input keeps the text the user typed. The empty case has its own presentation instead of a blank list, and at a narrow viewport the layout stays inside the viewport width because no row has a fixed width that forces horizontal overflow. A server refresh reconciles the list by id, keeping edited drafts and clean rows in place instead of resetting the collection, and a row that was never dirtied stays clean across the refresh.

Focus is part of the recovery contract, not a cosmetic detail, and the two paths differ. A keyboard submit keeps focus in the search field: the user pressed Enter there and an unrequested jump is the bug, so the field they typed in still holds the caret while results arrive. A retry is the opposite case, because the control being activated disappears when it succeeds, so on recovery focus moves to the results heading that carries the results instead of falling back to the document body. An error state keeps focus on the retry control until that control is activated, and the alert carrying the message is a live region so the failure is announced without stealing focus.

Hold the list in a reducer with a per-item state machine rather than a scatter of booleans. A row moves through idle, saving, saved and failed; a save attempt increments that row's attempt counter and a successful attempt increments its completed counter, and both counters live beside the rows so a test can read them after any number of retries. A refresh replaces the server rows and reconciles them by id: a row the user dirtied keeps its draft and its failed or saved status, a row that was clean takes the fresh server title and stays clean, and a row that vanished on the server is dropped instead of being rendered from a stale snapshot. Reconcile in one pass over the incoming collection, never by mapping local state onto a rebuilt array whose identity changed, which is the usual reason a refresh silently discards drafts.

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

Keeping the field focused is a property of the element, not of a call. A submit that swaps the rendered subtree replaces the input node, so the caret is gone even when a refocus runs afterward. Restore focus only when the field was the active element before the update, and do not focus the results heading on a load the user triggered from that field. The heading takes focus when the navigation came from elsewhere or was started by a keyboard shortcut. Recovery has its own destination: when a retry turns a failure into results, move focus to the heading that marks those results, because the retry control is gone and a keyboard user would otherwise be stranded on a removed node.

A durable preference is durable only when it is written under the storage key the surrounding application reads, with the value shape that key expects. Read the exact key from the contract instead of inventing a name. Treat a save as complete only when the request resolves, because a confirmation rendered before the promise settles is a claim the next reload disproves. A retry control reissues the request with the same identity it failed on, and the status region for that row appears only after the new request settles. A standby status element that is always rendered, or a retry that updates local state without calling the service again, both look like recovery while the save count stays at zero.

### Component boundaries and performance

Prefer data flow through explicit props and composition. Use context for genuinely shared ambient concerns, not to avoid ordinary ownership decisions. Preserve semantic HTML and repository design system primitives.

For editable sorted, filtered, or windowed lists, key every row by the item's stable domain ID. An array index identifies a _position_, so sorting or inserting can attach an existing row's draft, focus, or network request to a different item. Distinguish canonical server data from local unsaved drafts. If an item can leave the rendered window or filter while its draft must survive, keep the draft in an owner keyed by ID above the transient row. Merge a server refresh into canonical data without overwriting another row's pending edit; define a conflict policy for a refresh of the edited row. Bind save, undo, focus, and pending status to domain IDs. An async save needs pending, error, and success status for each item plus a retry path that keeps the draft through failure. Give every per-item affordance a stable hook built from the item's domain ID, following the attribute convention the existing row markup already uses for its own controls, and extend that convention to the new ones instead of inventing a second scheme: the retry action and the status indicator each need their own per-item hook, and the retry control must take focus when a failure appears. An affordance that exists only as prose in a status line, or only inside a toast, cannot be located, focused, or exercised. A retry must be operable from the keyboard, which in practice means it is a real `button` element rather than a styled `div` or `span` with a click handler: only native interactive elements receive Enter and Space, so a div based retry looks focused in the DOM and does nothing when activated. A retry must also be operable from the keyboard: when the retry control holds focus, pressing Enter has to re-run the same save for the same item using the draft value read at retry time rather than a value captured at first render, and success must clear the failed status and show the saved state. A retry that only responds to a pointer, or that re-sends a stale draft, leaves the user with a focused control that does nothing.

A row disappearing from a virtualized window does not end a save owned by the list; do not cancel valid work merely because the row unmounted. On actual unmount of the save owner, item removal, or supersession, request cancellation and invalidate late client updates. An aborted request may still settle and a server may already have accepted the write: use a server version/idempotency contract or reconcile authoritative returned state before claiming a stale server commit was prevented. Exercise reordering and virtualization with actual keyboard focus and network timing, not just string comparisons of rendered rows.

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
