---
name: novel-ui-toolkit
description: Design a new cross-domain UI toolkit, rendering system, or language-native interface API without importing web architecture by default. Use when the request specifically requires ui toolkit, widget system, rendering system.
---

# Novel Ui Toolkit

## Responsibility

Use this branch when the task creates the interface substrate itself. Establish target platforms, consumers, language constraints, rendering backends, retained versus immediate ownership, layout model, text shaping, scene or widget tree, invalidation, event dispatch, focus, input capture, accessibility bridge, styling and theming, resource lifetime, concurrency boundary, testability, debugging tools, and performance budgets before proposing public APIs.

Separate the ergonomic surface used by application authors from backend adapters and platform integration. Design primitives that compose without forcing one product aesthetic. Make state ownership, identity, lifecycle, measurement, layout, rendering, and event propagation explicit. Provide escape hatches without making unsafe or platform-specific behavior the default. Research mature native, game, embedded, and declarative toolkits for tradeoffs, but do not clone DOM/CSS or a fashionable framework unless its model fits the language and runtime.

Build a vertical reference slice that proves layout, text, input, focus, theming, accessibility semantics, error reporting, and rendering in the real target. Test invariants, golden rendering where stable, event/focus traversal, resize/scaling, resource cleanup, performance, and at least one realistic application flow.

## Hierarchy and routing

- Broader skills: frontend-engineering, human-experience.
- No narrower bundled child is declared.
- Cross-cutting facets: interaction-design, accessibility-practice, developer-experience.

## Professional practice

### Operating contract

Design a reusable rendering or widget substrate without cloning browser architecture by default.

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
- Where safe escape hatches end and platform-specific adapters begin.

### Failure and recovery discipline

- DOM/CSS concepts are copied without runtime fit.
- A toy demo avoids lifecycle or accessibility.
- Public APIs leak backend details.
- Identity or resource ownership becomes implicit and untestable.

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
