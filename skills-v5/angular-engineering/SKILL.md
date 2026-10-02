---
name: angular-engineering
description: Engineer Angular applications with explicit dependency scopes, signals or RxJS lifecycles, templates, routing, and change detection. Use when the request specifically requires angular component, angular service, angular signals, angular rxjs; prefer a narrower child only when its boundary is established.
---

# Angular Engineering

## Responsibility

Keep dependency, reactive state, form, and asynchronous work ownership explicit. Confirm the project's Angular version and standalone/module conventions before choosing APIs; preserve its public contracts and architecture unless the task requires a change.

## Hierarchy and routing

- Broader skills: frontend-engineering.
- No narrower bundled child is declared.
- Required skills: verification.

Inherit shared frontend principles from the parent. This child owns Angular-specific injection, reactivity, forms, routing, and templates, not React/Vue/Svelte conventions or additional execution authority.

## Professional practice

Choose the smallest injector lifetime that matches ownership. Component, route/feature, overlay, and application lifetimes are not interchangeable. Resources start once for their owner and end when that owner ends; making a leaking service global merely hides the wrong boundary.

Make signal ownership, observable completion/cancellation, and template data flow inspectable. Use the project's supported reactive mechanisms coherently; do not subscribe without cleanup or mutate ambient shared state invisibly. A callback must still belong to the active entity and operation when it completes, including after an A→B→A navigation sequence.

Initialize or reset forms intentionally when route identity changes, while preserving same-entity dirty input and unsaved-change decisions. Retain typed forms, template checking, validation/error focus, keyboard operation, and the existing service API. Different internal implementations are acceptable when they preserve these observable guarantees.

## Completion evidence

Run the Angular build and relevant component/router tests. Exercise route reuse, out-of-order completion, validation, declined navigation, overlay churn, concurrent feature instances, and teardown as applicable. Check actual keyboard/change-detection behavior for UI claims. Record versions and observable results; a framework-neutral state simulation does not establish Angular injector or browser behavior. Preserve failures and unavailable checks instead of treating compilation as full verification.

Use [the maintained source map](references/sources.md) for version-sensitive facts and source conflicts.
