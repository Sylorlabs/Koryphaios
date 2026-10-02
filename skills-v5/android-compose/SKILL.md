---
name: android-compose
description: Engineer Android and Jetpack Compose applications with lifecycle-aware state, navigation, coroutines, accessibility, and device constraints. Use when the request specifically requires jetpack compose, android app, compose ui, android lifecycle; prefer a narrower child only when its boundary is established.
---

# Android Compose

## Responsibility

Keep state, identity, and asynchronous work owned by the lifetime that actually needs them. Inspect the project's Android/Compose versions and conventions before choosing APIs; do not replace its architecture to match an example.

## Hierarchy and routing

- Broader skills: native-interface.
- No narrower bundled child is declared.
- Required skills: verification.

Inherit shared interface principles from the parent. This skill owns Android-specific state, lifecycle, input, and semantics; it does not import desktop/web abstractions or grant execution authority.

## Professional practice

Distinguish durable domain data, small restorable UI state, and ephemeral view resources. Configuration recreation and process death are different boundaries: ViewModel memory is not durable storage. Restore identifiers and reconstruct large state from its owner; capture account/entity and operation identity with pending work so retries cannot target a newly selected entity.

Rendering must not accidentally launch or duplicate effects. Give flow collection, subscriptions, and asynchronous work explicit start/cancel/cleanup ownership. Stable item identity must survive insertions, reordering, and paging. Avoid retaining Activity references beyond their lifetime. Choose state holders, effect APIs, and persistence mechanisms from the actual requirement, not a mandatory template.

Keep back navigation, insets, keyboard focus, permission denial, font scaling, and accessibility semantics native. Preserve user-owned drafts and the product's existing navigation contract.

## Completion evidence

Test identity changes, recreation, offline retry, repeated rendering, stale completion, and navigation-away cleanup as relevant. Vary entities and event order; a fix tied to one account or row position is not transferable. Run representative Android semantics/input and device checks where the claim requires them. Record the runtime and observed outcomes; label component simulations and unavailable TalkBack, hardware, or process-death checks explicitly. A preview or successful build is not device verification.

Use [the maintained source map](references/sources.md) for version-sensitive facts and source conflicts.
