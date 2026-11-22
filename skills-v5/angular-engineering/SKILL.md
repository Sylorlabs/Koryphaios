---
name: angular-engineering
description: Engineer Angular applications with explicit dependency scopes, signals or RxJS lifecycles, templates, routing, forms, and change detection. Use when implementing or repairing an Angular app, component, service, signals, RxJS flow, router, or forms; confirm the installed version and preserve its architecture.
---

# Angular Engineering

## Responsibility

Keep dependency, reactive state, form, and asynchronous work ownership explicit. Confirm the project's Angular version and standalone/module conventions before choosing APIs; preserve its public contracts and architecture unless the task requires a change.

## Hierarchy and routing

- Broader skills: frontend-engineering.
- No narrower bundled child is declared.
- Required skills: verification.

Inherit shared frontend principles from the parent. This child owns Angular specific injection, reactivity, forms, routing, and templates, not React/Vue/Svelte conventions or additional execution authority.

## Professional practice

Choose the smallest injector lifetime that matches ownership. Component, route/feature, overlay, and application lifetimes are not interchangeable. Resources start once for their owner and end when that owner ends; making a leaking service global merely hides the wrong boundary. For an overlay created with `createComponent()` that must share a feature scoped provider, pass the feature's `Injector` as `elementInjector` (or preserve equivalent injector ancestry); passing only an application `EnvironmentInjector` can resolve a second service instance. Overlay open/close must not start or stop the feature's poller; check navigation teardown and independent concurrent feature instances.

For a dynamically created Angular overlay, retrieve `Injector` from the **owning feature component** with `inject(Injector)`, and pass it alongside the existing `environmentInjector` and `hostElement` to `createComponent`. Keep the service provider on that feature component; do not add a root provider or create a new child provider for the overlay. Attach the new host view once, detach and destroy it once on close, and close any surviving overlay when its owning feature is destroyed. Let Angular tear down the feature's injected service when the feature injector is destroyed; calling the service's destructor manually risks a second cleanup. Test starting/stopping counts and notifications across overlay reopen, feature A→B navigation, simultaneous feature instances, final navigation away, and reentry.

The essential ownership wiring is small and easy to miss in a larger repair. In the feature component, retain `private readonly featureInjector = inject(Injector)` and create its overlay with `createComponent(OverlayComponent, { environmentInjector: this.environment, elementInjector: this.featureInjector, hostElement: this.host })`. The `elementInjector` is the owner scope; `environmentInjector` alone can locate a root provider and leave a feature poller alive after navigation. When tests exercise two feature owners concurrently, both must resolve their own provider and destroy only their own overlay and service lifetime. Preserve the existing DOM selectors and component API while making this change.

Make signal ownership, observable completion/cancellation, and template data flow inspectable. Use the project's supported reactive mechanisms coherently; do not subscribe without cleanup or mutate ambient shared state invisibly. A callback must still belong to the active entity and operation when it completes, including after an A→B→A navigation sequence.

For route reuse, observe `ActivatedRoute.paramMap` (or the project's configured router input binding); a constructor snapshot does not track later parameter changes. Component destruction cleanup alone, including `takeUntilDestroyed`, does not cancel work when the id changes on a surviving component. Scope requests to each committed route identity, cancel superseded subscriptions, and guard success, error, and finalization writes with an operation generation as well as the id. Use `switchMap` for replaceable reads; choose save concurrency deliberately rather than assuming a cancelled write was rolled back on the server. Unsubscribing an `HttpClient` request aborts its client transport, not an already committed server mutation. Keep recoverable request errors inside the inner stream so later route changes and retries still work. Pass an injected `DestroyRef` to `takeUntilDestroyed` outside an injection context, and place destruction cleanup after higher-order operators so it also unsubscribes their active inner work.

Initialize or reset forms intentionally when route identity changes, while preserving dirty input and unsaved change decisions for the same entity. Retain typed forms, template checking, validation/error focus, keyboard operation, and the existing service API. Angular's `Validators.required` accepts whitespace only strings: `form.invalid` alone does not reject `'   '`. When a field requires meaningful text, explicitly check its trimmed value **in the submit path before starting asynchronous work**, even if the form reports valid (for example, reject `form.invalid || form.pending || !form.controls.name.value?.trim()`, adapting the field and nullable type to the component). Represent the whitespace failure with a trim-aware validator or equivalent field error so validation feedback and focus agree. After an invalid keyboard or pointer submission, mark controls touched and focus the first invalid control in the actual rendered form without issuing a request; do not always focus the name field when another control fails first. Verify both focus and unchanged request count for whitespace only input. Different internal implementations are acceptable when they preserve these observable guarantees.

Confirm the configured change detection mode as well as the Angular version. In zoneless applications, reactive form model mutations do not themselves schedule rendering; bridge relevant form changes to the project's supported notification mechanism, such as `markForCheck`, and verify errors, pending state, and structural form changes in the rendered view.

## Completion evidence

Run the Angular build and relevant component/router tests. Exercise route reuse, out of order completion, validation, declined navigation, overlay churn, concurrent feature instances, and teardown as applicable. Check actual keyboard and change detection behavior for UI claims. Record versions and observable results; a framework neutral state simulation does not establish Angular injector or browser behavior. Preserve failures and unavailable checks instead of treating compilation as full verification.

Finish every requested verification artifact as carefully as the implementation. For a supplied machine readable `verification/result.json` contract, inspect the fixture instructions and match the exact case sensitive fields and **values**, not just the file name or a prose claim that it was updated: the evidence-backed status, the actual pinned Angular version, the requested broader skill and near neighbor identity, and a specific recovery explanation when required. A `nearNeighbor` identifier is distinct from the broader skill and may differ by scenario. Read the saved JSON again, validate its required fields against the fixture, and fix mismatches before declaring completion. Use a verified status only after the required runtime checks have actually passed; if they are unavailable, record the blocker and the contract's supported incomplete status, or report that the contract cannot yet be satisfied.

 Treat that artifact as a five key checklist and verify it one key at a time after the runtime work, because a single missing key fails the whole task while every other check passes:

1. `status`, set to the contract's verified value only when the browser or compiler checks you ran actually passed.
2. `angularVersion`, the exact version string the pin states, copied as a bare version such as `20.3.16` with no caret, tilde, range or `latest` marker, never from memory or the newest release you know of.
3. `broaderSkill`, this skill's declared broader skill taken from the hierarchy at the top of this document (`frontend-engineering`), never the active skill's own name.
4. `nearNeighbor`, the adjacent skill identifier the task itself names, which differs between scenarios.
5. `recovery`, a full sentence describing how the failing or interrupted state was recovered, not a word or a placeholder.

Re-open the saved file after writing it and confirm each key exists with a concrete value; an artifact written early and never re-read is the most common reason a working component still scores zero on this check. For example, a route form task may name `react-engineering` as its adjacent discipline, while an overlay injector task names `svelte-engineering`. Neither the active skill name `angular-engineering` nor a prose description of the UI satisfies an expected skill identifier. Write the identifier in the catalog's own kebab-case form: the adjacent framework's name plus `-engineering`, so `react` becomes `react-engineering`, `svelte` becomes `svelte-engineering`, and `vue` becomes `vue-engineering`. A bare framework name, a version string, or a display label such as `React` is rejected as an identifier even though it names the right technology. Read the task's actual falsifiable hierarchy check to select the value; do not reuse metadata from another task.

## Verification artifacts

When a task supplies a verification artifact schema, write it with the exact field names, version strings, check identifiers, and terminal status it lists. Set the status from what you actually ran: a check you performed carries its observed result, and a check you could not run stays unverified with the reason recorded. Never leave a placeholder status after performing the work, and never claim a check you did not run.

Use [the maintained source map](references/sources.md) for version sensitive facts and source conflicts.
