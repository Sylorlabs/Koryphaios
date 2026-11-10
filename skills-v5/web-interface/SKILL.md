---
name: web-interface
description: Design and implement browser-based interfaces with web-native semantics, navigation, responsive behavior, async state, accessibility, and real-browser verification. Use when the target surface is confirmed as a website, web application, browser UI, HTML/CSS interface, or responsive browser frontend.
---

# Web interface

Confirm the browser target, supported environments, repository framework and component system, routes, data-loading model, content, assets, and existing design language before editing. Prefer semantic web primitives and established product components; do not replace repository-required controls or select a framework without evidence.

Preserve URL and history behavior, meaningful document structure, forms and validation, keyboard/focus semantics, network and async states, refresh/deep links, and recovery. Make responsive behavior follow content, task priority, available space, zoom/reflow, and user preferences rather than fixed device stereotypes.

For web visual anti-slop, derive visual direction from audience, content, brand, references, and page purpose. Treat generic AI patterns as warning signals, not permanent bans: any layout, font, color, or motion pattern is acceptable when the product evidence justifies it.

Verify the real page in supported browsers and representative sizes with keyboard interaction, loading/partial/empty/error states, slow or failed requests, navigation, refresh, overflow, reduced motion, console/runtime errors, and relevant accessibility checks. Screenshots alone are insufficient.

For async DOM replacement, preserve the invoking control's stable identity before rendering. Restore focus to the surviving equivalent control after the update; if the action is no longer available, focus the owning heading or status/error target and expose the reason. Revalidation and polling must not silently move focus or strand it on a detached node. Treat this as a browser behavior contract, not a visual polish item.

When the interface uses same-document navigation, keep the current route in one reactive source, update it when `pushState` or `replaceState` is called, and handle `popstate` with a removable listener. Exercise direct load, client navigation, back, forward, refresh, and a changed query or resource identity. A URL string captured only at module initialization is not history support.

Keep the browser verification record claim-level. Each required state or viewport row needs its actual capture or reproduction path, runtime and font identity, interaction trigger, observed result, and `observed`, `blocked`, or `unverified` status. A plan, empty matrix, screenshot without an interaction record, or evaluator-owned capture created after the task does not prove the candidate's browser behavior.

## Fixed harness inputs

A task or fixture may mark harness files, shared controls, or starting data as evaluator owned. Treat those as immutable: change only the candidate component or file the task names, and leave the harness, shared control, and supplied data byte for byte. Record the framework version, the execution context, and the observed failure and recovery in the report format the task supplies, using the exact field names and check identifiers it lists.

[Sources](references/sources.md).
