---
name: frontend-engineering
description: Engineer presentation and interaction boundaries across the confirmed target medium without treating frontend as a synonym for browser code. Use when implementing or refactoring a frontend, user interface, presentation layer, device-facing interface, or when the medium must be established before selecting a platform or framework specialist.
---

# Frontend engineering

Establish the consumer, primary job, target medium, input and output modes, runtime, toolkit, platform conventions, accessibility surface, and verification environment before choosing implementation patterns. Inspect the existing product and its meaningful states in the real runtime when available.

Translate goals into explicit flows, information hierarchy, state ownership, actions, feedback, failure, and recovery. Keep domain state distinct from presentation state. Reuse proven product and platform conventions unless evidence justifies divergence. Do not import DOM, CSS, React, browser, REST, or database assumptions without repository, runtime, or user evidence; route confirmed medium and framework depth to the relevant child skill.

Make interruption a first class transition. Define what happens when a task is cancelled, superseded, backgrounded, or resumed, including whether stale work remains actionable, which presentation state is shown, and the deterministic `focusTarget` or selection destination when the previously focused control disappears. Do not mark interruption recovery complete merely because the task can be rediscovered; the return path must restore a usable context in the real medium.

Verify observable behavior in the real target: primary tasks, keyboard or equivalent non-pointer operation, focus or selection, loading, empty, partial, error, disabled, success and destructive states, interruption, overflow, resize or display changes, localization pressure, and reduced-motion or equivalent accessibility behavior where applicable. Do not substitute screenshots or unit tests for interaction evidence.

For every consequential state, record the domain owner, presentation owner, permitted actions, rule for stale data, recovery path, and evidence oracle. A state that represents work in progress permits the interruption the product supports; when the domain forbids cancellation, state that prohibition explicitly instead of leaving the action silently absent. In a verification contract, distinguish `planned` or `blocked` from an observed runtime result and preserve the exact missing environment or capture requirement. A contract can define a native or browser check, but cannot claim that check ran without target-runtime evidence.

[Sources](references/sources.md).
