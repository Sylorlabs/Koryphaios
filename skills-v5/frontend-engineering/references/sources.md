# Source map

This parent skill defines frontend engineering as the presentation and interaction boundary between a system and a person or device. It deliberately stays medium-neutral. Browser, native, terminal, game/spatial, embedded, toolkit, and framework mechanics belong to their corresponding child skills after the target is established.

## Maintained interpretation

- Begin with runtime evidence: who or what consumes the interface, the task, medium, available input/output channels, toolkit and platform conventions, resource constraints, accessibility APIs, and how the result can be exercised. A repository containing React does not prove every requested interface is a browser surface; a screen does not prove pointer input.
- Model observable state and interaction before styling or framework mechanics. Identify domain state, presentation state, actions, side effects, loading and partial states, failures, recovery, cancellation, destructive actions, and what survives interruption or navigation.
- Prefer existing product components and established platform semantics when they satisfy the task. Divergence should buy a concrete task, comprehension, accessibility, performance, or product benefit rather than novelty alone.
- Platform rules are intentionally not universal. Apple guidance emphasizes platform conventions and adaptation across windows/displays. Android's adaptive guidance treats current app-window size as dynamic and requires testing across changing configurations. Browser semantics and focus behavior are governed by HTML and web accessibility standards. Terminal interfaces have different human/machine-output and composability constraints. Select the matching child rather than flattening these into one UI recipe.
- Support the input mechanisms relevant to the medium. W3C's web guidance explicitly recognizes concurrent mouse, touch, keyboard, speech, and alternative inputs; the broader engineering principle is to avoid making a critical task depend on an incidental input mechanism when the platform supports an equivalent path. The exact conformance rule remains medium-specific.
- State feedback must remain perceivable without stealing context unnecessarily. Loading, empty, partial, success, error, disabled, destructive, offline/degraded, interruption, and recovery states are part of the interface contract, not polish to add after the happy path.
- Responsive or adaptive behavior follows the actual available space and task priority. Do not infer layout solely from named device classes; validate resizing, split views, orientation or display changes only where the target runtime can experience them.
- Verification is behavioral and medium-faithful. Exercise representative tasks, state transitions, input modes, focus/selection, display changes, localization pressure, motion preferences, failure/recovery, and runtime diagnostics. Screenshots can support visual claims but cannot prove interaction, semantics, accessibility, or state recovery.

## Community-pattern review

The Command Line Interface Guidelines reinforce that terminal output is both a human interface and an automation surface: discoverability, concise state feedback, composability, and machine-readable output can coexist. Kory uses this as evidence that frontend engineering must branch by medium, not as terminal rules for graphical products.

## Verification record

- Apple Human Interface Guidelines: inspected 2026-09-04; recheck within 90 days.
- Android adaptive-app guidance: inspected 2026-09-04; recheck within 90 days.
- WHATWG HTML Living Standard interaction sections: inspected 2026-10-03; the living standard reported its current update date as 2026-10-03. The current inertness, user-activation, activation, and focus sections still support the browser-specific boundary recorded above. Recheck within 30 days.
- W3C WCAG 2.2 and current input-modality understanding guidance: inspected 2026-09-04; recheck within 90 days for supporting guidance and 365 days for the Recommendation.
- Command Line Interface Guidelines: inspected 2026-09-04; recheck within 180 days.
