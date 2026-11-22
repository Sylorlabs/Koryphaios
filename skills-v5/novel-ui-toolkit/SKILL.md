---
name: novel-ui-toolkit
description: Design a new cross-domain UI toolkit, rendering system, or language-native interface API without importing web architecture by default. Use when the request specifically requires ui toolkit, widget system, rendering system.
---

# Novel Ui Toolkit

## Responsibility

Use this branch when the task creates the interface substrate itself. Establish target platforms, consumers, language constraints, rendering backends, retained versus immediate ownership, layout model, text shaping, scene or widget tree, invalidation, event dispatch, focus, input capture, accessibility bridge, styling and theming, resource lifetime, concurrency boundary, testability, debugging tools, and performance budgets before proposing public APIs.

Separate the ergonomic surface used by application authors from backend adapters and platform integration. Design primitives that compose without forcing one product aesthetic. Make state ownership, identity, lifecycle, measurement, layout, rendering, and event propagation explicit. Provide escape hatches without making unsafe or platform-specific behavior the default. Research mature native, game, embedded, and declarative toolkits for tradeoffs, but do not clone DOM/CSS or a fashionable framework unless its model fits the language and runtime.

Coalesce continuous input into one paint per frame: a burst of scroll, wheel, or drag events must set the pending value and schedule a single frame, not paint once per event, and a virtualized window must be recomputed from the coalesced offset rather than from each event. Build a vertical reference slice that proves layout, text, input, focus, theming, accessibility semantics, error reporting, and rendering in the real target. Test invariants, golden rendering where stable, event/focus traversal, resize/scaling, resource cleanup, performance, and at least one realistic application flow.

## Hierarchy and routing

- Broader skills: frontend-engineering, human-experience.
- No narrower bundled child is declared.
- Cross-cutting facets: interaction-design, accessibility-practice, developer-experience.

## Professional practice

### Operating contract

Keep the semantic projection in lockstep with visual selection, so the active item alone carries `aria-current` and an activation key invokes exactly that item and never its neighbour. Convert a pointer event exactly once, from client coordinates into model coordinates: subtract the canvas rectangle origin, subtract the pan offset, then divide by the zoom factor, and compare the result with model bounds. Applying the transform twice, or comparing client coordinates with model coordinates, resolves a click to the wrong node. Design a reusable rendering or widget substrate without cloning browser architecture by default.

### Canvas surface and virtualized window

A canvas has two sizes and they are not interchangeable. The backing store comes from the dataset, and the CSS box must equal it exactly. A percentage width, a padding box, or a border that shrinks the drawing area all produce a surface that silently scales every coordinate, so the hit test and the paint disagree while the picture still looks plausible. Set the CSS box in pixels from the same constants that set the backing store, and fail loudly when the measured client box and the backing store diverge.

A virtualized list derives its projected window instead of guessing one. Walk cumulative item and group header heights from the scroll offset until the viewport height is covered, add a small overscan for pointer and keyboard travel, and keep the projected row count inside the stated bound. A fixed row guess either overflows the bound on tall rows or leaves a blank band on short ones. Project only the visible slice into the semantic tree and draw once per frame from that same slice, so the accessible structure, the drawn rows and the reported count can never describe three different lists.

### Execution sequence

1. Establish target platforms, consumers, language/runtime constraints, and quality budgets.
2. Define ownership, identity, lifecycle, layout, text, rendering, events, focus, and accessibility.
3. Separate ergonomic public primitives from backend and platform adapters.
4. Build a vertical slice proving layout, text, input, focus, theme, diagnostics, and cleanup.
5. Stress composition, scaling, traversal, resources, performance, and realistic application flow.

### Decisions that must be explicit

- Retained, immediate, or hybrid ownership model.
- Measurement/layout and invalidation contracts.
- Event propagation, capture, focus, and accessibility bridge.
- Focus ownership across transient loading, error, and recovery controls. When a recovery action succeeds, leave keyboard focus on a durable control that continues the user's task instead of letting focus fall away with a removed retry surface.
- Where safe escape hatches end and platform-specific adapters begin.

### Failure and recovery discipline

- DOM/CSS concepts are copied without runtime fit.
- A toy demo avoids lifecycle or accessibility.
- Public APIs leak backend details.
- Identity or resource ownership becomes implicit and untestable.
- Async failure UI exposes a retry path but drops keyboard focus when that temporary recovery control disappears. Make error state perceivable through the target platform's semantic status/alert mechanism and verify the post-recovery focus target.

### Evidence required before completion

- Architecture and tradeoff record.
- Real vertical slice.
- Invariant, rendering, event, focus, cleanup, and performance tests.
- At least one representative application workflow.
- Reconcile the completion summary against the retained verification results. If semantic focus, pointer input, keyboard traversal, rendering, cleanup, accessibility, or another required invariant fails, report that failure and keep the corresponding capability unverified. Do not replace a mixed or failing result with a blanket statement such as "verification passed."

### Anti-misinterpretation boundaries

- Do not select a fashionable architecture without constraints.
- Do not force one product aesthetic into primitives.
- Do not postpone text or accessibility as polish.
- Do not claim portability from one backend.
- Do not claim a capability is implemented or verified merely because the relevant code path exists; the observed result at that boundary controls the completion claim.

## Completion evidence

- Architecture decision record
- Real vertical slice
- Layout input focus and performance tests

Use [the maintained source map](references/sources.md) for version-sensitive facts and source conflicts.
