---
name: visual-verification
description: Verify rendered interfaces across sizes, content densities, themes, and states. Use when reviewing screenshots, layout, or visual changes on the actual platform; use functional-verification for behavior and accessibility-verification for semantics and alternate operation.
---

# Visual Verification

Judge what the target runtime actually renders, not what the source code appears intended to render. Establish the visual claims first, then collect comparable captures across the states and environmental dimensions that could falsify them.

## Verification workflow

1. **Identify the real medium and reference.** Confirm browser/native/terminal/game/spatial/embedded target, runtime version, design reference if one exists, and any platform conventions that materially constrain the result. A mockup is a reference, not runtime evidence.
2. **Build a bounded state matrix.** Choose the few viewport/window/device sizes, themes, content lengths, locale directions, densities, and interaction states most likely to expose layout defects. Include loading, empty, error, disabled, selected/focused, overflow, and resize states only when the interface can reach them.
3. **Inspect hierarchy before pixels.** Check whether grouping, alignment, spacing, typography, color/material, imagery, and control prominence express the intended information hierarchy. Look for accidental competition, weak grouping, inconsistent token use, and controls visually detached from the content they govern.
4. **Stress adaptation.** Verify reflow or platform-appropriate adaptation at minimum and maximum supported sizes, long localized strings, larger text where supported, dense/empty data, safe areas, and resizable-window states. Record clipping, overlap, inaccessible off-screen content, cropped assets, broken wrapping, and misleading truncation.
5. **Compare like with like.** When using screenshot or golden comparison, hold runtime, font assets, scale, animation state, data, and theme constant. Treat pixel diffs as a detector that still needs semantic review; anti-aliasing or platform-rendering noise is not automatically a product defect.
6. **Issue claim-level verdicts.** Mark each visual claim passed, failed, or unavailable/inconclusive and attach the capture plus environment that supports it. State any untested size, platform, theme, or state explicitly.

Every matrix row must distinguish evidence level from intended coverage. For an observed row, retain the capture path or reproducible runtime trace, exact viewport or window, scale, theme, content/state, runtime and font identity, and the concrete element or claim inspected. For a blocked or unverified row, retain the attempted command/tool error or missing dependency. A checklist, empty capture path, source prediction, browser accessibility tree, or later evaluator-owned capture cannot be rewritten as observed candidate evidence.

## Boundaries

When the task specifies a capture matrix, account for every requested cell. Record actual capture paths, viewport, scale, theme, content and state with runtime and font identity. Inspect each capture and bind every failure to a concrete element, observed condition and affected cells. A capture plan or empty matrix is not captured evidence. Keep the requested artifact schema and distinguish missing captures from passing cells; the overall verdict must retain any observed failure and untested boundary.

When an observed capture exposes a failure, record the exact capture identifier in the claim audit even if the implementation is otherwise polished. When capture execution times out or the target platform is unavailable, preserve the tooling failure and leave the affected claim unverified; do not use a source-derived prediction or a synthetic state description to close it.

- `visual-interface-design` decides the intended visual direction; this skill verifies whether the implementation realizes it.
- `functional-verification` proves actions and state transitions work; a screenshot cannot establish those behaviors.
- `accessibility-verification` owns semantic names, focus order, keyboard/switch/screen reader operation, and normative accessibility criteria. Visual verification may surface clipping, contrast, or text-scaling symptoms but must not claim accessibility conformance without that specialist evidence.
- Apply browser responsiveness only to browser targets; do not force browser responsiveness onto native, terminal, game, spatial, or embedded media. Those media need their own window/device/layout conventions.

Use [the maintained source map](references/sources.md) when platform layout guidance or normative visual criteria affect the verdict.
