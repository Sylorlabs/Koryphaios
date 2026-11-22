# Android Compose

## Responsibility

Keep state, identity, and asynchronous work owned by the lifetime that actually needs them. Inspect the project's Android/Compose versions and conventions before choosing APIs; do not replace its architecture to match an example.

## Hierarchy and routing

- Broader skills: native-interface.
- No narrower bundled child is declared.
- Required skills: verification.

Inherit shared interface principles from the parent. This skill owns Android specific state, lifecycle, input, and semantics; it does not import desktop/web abstractions or grant execution authority. Establish the actual Android module, activity/navigation entry point, Compose and lifecycle dependency versions, persistence owner, and available device/test environment first. Keep iOS/SwiftUI and desktop/Electron work with their respective specialists even when a request mentions both platforms.

## State and restoration decisions

- Trace each input and action across recomposition, activity recreation, app process loss, offline retry, and navigation away. Classify state before editing: persistent domain data and queued operations belong in the existing repository/store; small restorable view values can use `rememberSaveable` or `SavedStateHandle`; focus and resources owned by composition can use `remember`. A `ViewModel` survives configuration recreation but does **not** persist through process death. Saved instance state is neither a durable offline queue nor a place to serialize large datasets.
- For edits that must survive a cold start, restore the selected entity and user owned draft from their durable owner, then expose them through observable UI state. Use `collectAsStateWithLifecycle()` for `StateFlow` consumed by Compose, or `repeatOnLifecycle` for other lifecycle bound subscriptions; do not collect indefinitely from a composable body. Treat UI and repository state as one intentional source of truth path, avoiding divergent copies after rotation.
- When saving offline, persist a pending operation **before** attempting delivery. Snapshot its target account/entity ID, payload, and stable idempotency identity at enqueue time. Retry the stored operation after restart or connectivity recovery; never recompute its target from the currently selected account or fire a second write on repeated taps. Verify that success removes the pending entry durably, while failures preserve it and prevent cross account writes.

## Effects, paging, and identity

- Never launch I/O or a coroutine directly while composing a row. For work owned by a visible item, use `LaunchedEffect(message.id, retryGeneration)` (or an equivalent explicitly cancelled owner) so changing identity, retrying, scrolling the row away, and navigation away have predictable cancellation. Use `DisposableEffect` for listeners/resources with a real `onDispose` cleanup. A standalone `CoroutineScope(SupervisorJob())` with an empty `onDispose` leaks work; a long lived ViewModel job needs explicit deduplication and cancellation if row visibility is its contract. Rethrow `CancellationException` while handling expected transient failures for an intentional retry.
- Key `LazyColumn` items by stable **domain identity** (`items(messages, key = { it.id })`), not list index or current position. Preserve `rememberLazyListState` and its visible item anchor when older pages are prepended; do not replace the paging layer to make a test pass. Associate image/avatar loads, their retry keys, and their cancellation with the same stable message ID. Inspect behavior after prepend and reordering, not only initial rendering.
- Avoid capturing an `Activity`, `View`, or obsolete callback in long lived state. Keep back behavior, IME dismissal, focus, insets, and permission denial consistent with Android and the app's existing navigation contract.

## Accessibility and observable timing

- Give actionable controls and editable fields accurate semantics and accessible names, including their state where appropriate. Check the Compose semantics tree **and** Android accessibility nodes with instrumentation/UI Automator; test keyboard focus, TalkBack sensitive labels, large system font scale, and return/back navigation on the actual supported runtime. An enabled TalkBack service plus visible nodes establishes accessibility tree evidence; it does not independently prove spoken announcements or manual traversal.
- Drive tests through real user interactions and wait on observable state changes (`waitForIdle` for composition; bounded `waitUntil`/condition checks for asynchronous launches, retries, and cancellations). Do not use arbitrary sleeps, screenshots, or a green compile as proof that pending work stopped or saved data survived. Distinguish activity `recreate()` from a killed process followed by a fresh launch; test both when restoration is claimed.

## Completion evidence

Cover both success and negative/recovery paths: switch between at least two entities; save while offline; rotate; kill and relaunch the app; retry twice and assert exactly one write to the original entity; relaunch again and confirm the commit persists. For a paged feed, scroll to an identified row, prepend entries, assert that row stays anchored, trigger and observe an avatar failure/retry, then leave the screen and verify outstanding work reaches zero. Check font scaling and focused text entry with the native IME; exercise permission denial and physical hardware when the feature depends on them.

For native claims, use the project's actual Android Gradle build and independently run instrumentation against an identified Android device/emulator, with test app data isolated at the start of a run and fresh processes for process loss phases. Respect evaluator owned manifests, fixtures, test code, and allowed source boundaries. Report the specific runtime, test phases and observed assertions, async timing outcomes, accessibility state, and failures; separate native evidence from simulations, unavailable checks, and unobserved TalkBack speech. Native runtime success alone does not establish independent paired, blinded V5 promotion.

Use [the maintained source map](references/sources.md) for version sensitive facts and source conflicts.