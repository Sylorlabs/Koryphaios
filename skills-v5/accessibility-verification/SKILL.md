---
name: accessibility-verification
description: Verify that people can complete a concrete interface task with supported alternate input, scaling, and representative assistive technology, and that exposed semantics match the visible interaction. Use when the task calls for an accessibility audit, keyboard test, or screen reader test; do not treat automated lint success as conformance proof.
---

# Accessibility Verification

Verify the actual task, not just isolated attributes. Start by identifying the medium, applicable normative/platform guidance, supported input methods, and the user journey being claimed accessible. Automated checks are triage evidence; manual operation and representative assistive technology are required whenever the claim depends on interaction or announced semantics.

## Verification workflow

1. **Define the task and environment.** Record runtime/platform version, input method, assistive technology and version, text/zoom setting, and the start/end state of the representative task. Preserve supplied environment/version identifiers verbatim; record `simulated`, inferred, stale, or unverified status in separate evidence fields or notes instead of rewriting the identifier itself.
2. **Traverse without the default pointer.** For web/desktop, test keyboard-only order, reachability, visible focus, activation, escape/cancel, and focus restoration. For mobile/device targets, use the platform's representative accessibility service or alternate input model rather than assuming desktop Tab behavior.
3. **Inspect exposed semantics.** Confirm name, role, value/state, relationships, grouping, heading/landmark structure where applicable, validation/error association, dynamic announcements, and whether visible and announced intent agree. Prefer native semantics before adding ARIA or custom metadata.
4. **Exercise state changes.** Verify dialogs, menus, disclosure, async loading, success/error messages, disabled/read-only states, validation, cancellation, and recovery. A control being focusable is insufficient if state changes are silent or focus is lost.
5. **Stress presentation without losing operation.** Test supported text enlargement/zoom, reflow, orientation/window changes, contrast/color dependencies, target visibility, and reduced-motion/system accessibility settings where relevant to the product.
6. **Combine evidence honestly.** Run applicable automated scanners and platform inspectors, but reconcile them with manual task results. Keep evidence ownership explicit: evaluator/harness tests are not a project accessibility scan unless that exact scanner was actually invoked and its output retained. Record false positives, unsupported rules, untested assistive technologies, and residual limitations. A synthetic or simulated task run can verify the synthetic fixture contract, but it cannot support a live browser/device/assistive-technology pass verdict. Keep the overall verdict partial or unverified until every required live boundary and visible-focus check has evidence.

## Boundaries

- `accessibility-practice` provides design/implementation guidance; this skill produces fresh verification evidence.
- `functional-verification` owns business-state correctness. Accessibility verification proves the same outcome remains operable and understandable through alternate interaction and semantics.
- `visual-verification` can establish rendered clipping or focus appearance, but semantic order and assistive-technology behavior require this skill.

Use [the maintained source map](references/sources.md) only for the medium it governs; WCAG and ARIA do not automatically define native-platform behavior.
