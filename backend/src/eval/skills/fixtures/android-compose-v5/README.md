# Jetpack Compose V5 native evaluation fixture

The Gradle project is materialized in a candidate working directory. The
candidate can modify only EditFeature.kt and FeedFeature.kt (and add Kotlin
helpers to the same package). The full Android app compiles on a real Android
Gradle Plugin / Kotlin Compose toolchain, then the evaluator builds and
installs both app and instrumentation APKs onto an already booted device.

Scenario 1 starts with intentionally unsafe account/queue ownership. Repair
this using NoteJournal for durable selected account, draft and idempotent
offline pending save. ViewModel data should use lifecycle-aware collection,
and the Android back action should behave normally.

Scenario 2 starts with position keys and avatar jobs that survive disposal.
Preserve actual message IDs as LazyColumn keys and scroll anchors, tie avatar
coroutines to composable lifecycle, and allow retry and navigation cleanup.
The evaluator runs at 1.5x system font scale and checks native keyboard focus.

Evaluator instrumentation is copied into an isolated build *after* candidate
work completes. It is not a test file that the candidate supplies or edits.
Native evidence comes from Gradle, installed APKs, fresh instrumentation
processes and Android accessibility/Compose assertions. Android component
simulations, screenshots, and a green Gradle compilation alone cannot pass.
TalkBack must be installed and enabled for native readiness; native accessibility
nodes are inspected, but audible spoken output is not independently recorded.
External qualification must still independently verify paired blinded runs.
