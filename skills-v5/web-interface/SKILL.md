---
name: web-interface
description: Design and implement browser-based interfaces with web-native semantics, navigation, responsive behavior, async state, accessibility, and real-browser verification. Use when the target surface is confirmed as a website, web application, browser UI, HTML/CSS interface, or responsive browser frontend.
---

# Web interface

## Definition of done

Before anything else, list the artifacts the task declares and treat them as the deliverable: the implementation contract, the state and viewport matrix, the verification record, and any capture the task names, each at its declared path with the declared field names. A run that ships a working page and no contract or matrix is scored as a failure of both, because the evaluator reads those files, not the browser. Write them as you build, not afterwards, and re-read the task's artifact list before you report.

Landmarks are checked by structure, not by intent. A page needs one `<nav>` inside a `<header>`, exactly one `<main>`, at least two `<section>` elements inside that `<main>`, and exactly one `<footer>`. A page that looks right with `<div class="header">` and a `<div class="content">` scores as a failure on document structure even when every word, image and action is correct, because the evaluator queries the elements rather than reading the markup.

Their shapes are boring, so write them first and fill them as you go. An implementation contract is an object that echoes the supplied backend contract version, lists every state identifier, and carries routing, focus and network blocks of booleans plus two short sentences for cancellation and retry semantics. The state and viewport matrix is an object with the evidence type, the required viewport labels, the same state list, the degraded network states, and one row per capture. Two minutes of writing them removes the most common way a working page scores zero.

## Browser target

Confirm the browser target, supported environments, repository framework and component system, routes, data-loading model, content, assets, and existing design language before editing. Prefer semantic web primitives and established product components; do not replace repository-required controls or select a framework without evidence.

Preserve URL and history behavior, meaningful document structure, forms and validation, keyboard/focus semantics, network and async states, refresh/deep links, and recovery. Make responsive behavior follow content, task priority, available space, zoom/reflow, and user preferences rather than fixed device stereotypes.

For web visual anti-slop, derive visual direction from audience, content, brand, references, and page purpose. Treat generic AI patterns as warning signals, not permanent bans: any layout, font, color, or motion pattern is acceptable when the product evidence justifies it.

Verify the real page in supported browsers and representative sizes with keyboard interaction, loading/partial/empty/error states, slow or failed requests, navigation, refresh, overflow, reduced motion, console/runtime errors, and relevant accessibility checks. Screenshots alone are insufficient.

For async DOM replacement, preserve the invoking control's stable identity before rendering. Restore focus to the surviving equivalent control after the update; if the action is no longer available, focus the owning heading or status/error target and expose the reason. Revalidation and polling must not silently move focus or strand it on a detached node. Treat this as a browser behavior contract, not a visual polish item.

When the interface uses same-document navigation, keep the current route in one reactive source, update it when `pushState` or `replaceState` is called, and handle `popstate` with a removable listener. Exercise direct load, client navigation, back, forward, refresh, and a changed query or resource identity. A URL string captured only at module initialization is not history support.

Keep the browser verification record claim-level. Each required state or viewport row needs its actual capture or reproduction path, runtime and font identity, interaction trigger, observed result, and `observed`, `blocked`, or `unverified` status. A plan, empty matrix, screenshot without an interaction record, or evaluator-owned capture created after the task does not prove the candidate's browser behavior.

## Fixed harness inputs

The artifacts a task declares are the deliverable, not paperwork to add afterwards. If the task asks for an implementation contract, a state and viewport matrix, a content-led plan, or a responsive verification contract, write each one at the declared path with the declared field names and a row per required state and viewport. A correct page with a missing or empty matrix fails every check that reads the matrix, and an artifact written after the task is not evidence of the work it describes.

A task or fixture may mark harness files, shared controls, or starting data as evaluator owned. Treat those as immutable: change only the candidate component or file the task names, and leave the harness, shared control, and supplied data byte for byte.

The sealed set is usually wider than the word "harness" suggests. Supplied page shells, design-token stylesheets, content packets, brand specifications, logos and product imagery are inputs, not scaffolding to tidy up. A run that rewrites `index.html` or the supplied token stylesheet to suit a nicer layout scores zero on integrity no matter how good the page becomes, because the evaluator can no longer tell what the candidate added. Put every change in a new file that layers over the supplied shell, and prove the sealed files are unchanged before reporting.

When a task asks for a verification contract, the contract is a claim with a fixed shape: the evidence type the task names, one entry per required viewport in the task's spelling, and a boolean for each behaviour the task lists, all true only where you actually observed it. A contract that omits the listed viewports, uses different keys, or records `true` for a behaviour you did not exercise fails the same check as a missing file.

Derive the values from what the task supplies instead of inventing them. If the task hands you a backend contract with a version, echo that exact version string into the implementation contract. Enumerate every state identifier the task lists, not the subset your page happens to reveal. Group the behaviours under the keys the task names (routing with deep links, history and refresh; focus with dialog restoration and keyboard actions; network with slow, failed and stale response paths), and describe cancellation and retry as the task's own vocabulary does, so the reader can tell an acknowledgement from an effect. Then build the matrix from real captures at each required viewport, one row per state, including the degraded network states, and set the evidence type to the one the task declares. A page that works while both artifacts are missing or half-filled scores as if the page did not work. Record the framework version, the execution context, and the observed failure and recovery in the report format the task supplies, using the exact field names and check identifiers it lists.

[Sources](references/sources.md).
