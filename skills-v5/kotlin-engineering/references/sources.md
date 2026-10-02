# Source map

Source curation for `kotlin-engineering`. Routing fixtures and eval IDs remain in `kory.json`. This revision does not claim paired skill/no-skill or blind qualification.

## Adopted primary guidance

- **Kotlin coroutines basics**: https://kotlinlang.org/docs/coroutines-basics.html
  - Adopted: use structured concurrency so scopes own child lifetimes, parents wait for children, and cancellation or failure propagates through the intended tree.
  - Conditional: this guidance assumes `kotlinx.coroutines` and the target's supported coroutine runtime.
  - Limit: structured concurrency does not choose the correct dispatcher or solve blocking calls by itself.
- **Coroutines and channels tutorial**: https://kotlinlang.org/docs/coroutines-and-channels.html
  - Adopted: avoid independent global coroutine lifetimes for work that belongs to a component, and keep producer-consumer ownership explicit.
  - Conditional: channel and coroutine patterns must match the actual target and lifecycle.
  - Limit: tutorial examples are not evidence for the repository's threading, Flow, or shutdown behavior.
- **Kotlin documentation index**: https://kotlinlang.org/docs/home.html
  - Preserved use: language, nullability, interoperability, and multiplatform reference discovery.
  - Limit: the index alone is not evidence that Kotlin/JVM behavior applies unchanged to Native or JS.

Target-specific documentation and tests outrank JVM assumptions when a Kotlin Multiplatform boundary is involved.
