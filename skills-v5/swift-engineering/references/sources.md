# Source map

Source curation for `swift-engineering`. Routing fixtures and eval IDs remain in `kory.json`. This revision does not claim paired skill/no skill or blind qualification.

## Adopted primary guidance

- **Automatic Reference Counting**: https://docs.swift.org/swift-book/documentation/the-swift-programming-language/automaticreferencecounting/
  - Adopted: reason about strong cycles and choose weak versus unowned references from the actual lifetime relationship, especially for closure captures.
  - Conditional: use weak when the referenced object may validly disappear; use unowned only when the lifetime invariant guarantees validity at access.
  - Limit: ARC documentation cannot prove an application's ownership graph is free of cycles.
- **Swift concurrency**: https://docs.swift.org/swift-book/documentation/the-swift-programming-language/concurrency/
  - Adopted: preserve actor isolation, `Sendable` boundaries, structured task ownership, and cooperative cancellation as public concurrency contracts.
  - Conditional: diagnostics and accepted patterns depend on Swift language mode and compiler version, so resolve the repository toolchain before applying newer concurrency rules.
  - Limit: host-language concurrency tests do not establish Apple framework lifecycle or device behavior.
- **The Swift Programming Language**: https://docs.swift.org/swift-book/documentation/the-swift-programming-language/
  - Preserved use: value and reference semantics, ownership, language, and discovery of features sensitive to the version in use.
  - Limit: the index alone is not evidence for a particular concurrency diagnostic or platform API.

Package tools version, Swift language mode, and target platform are evidence inputs. Device or framework claims need the corresponding Apple runtime boundary.
