# Source map

Source curation for `ios-swiftui`. Routing fixtures and eval IDs remain in `kory.json`. This revision does not claim paired skill/no skill or blind qualification.

## Adopted primary guidance

- **Managing user interface state**: https://developer.apple.com/documentation/swiftui/managing-user-interface-state?changes=__1
  - Adopted: keep a single source of truth at the stable owner that needs to share state, and distinguish view lifetime state from durable model storage.
  - Conditional: local state remains appropriate when it truly belongs to one view identity.
  - Limit: moving all state upward is not a goal and can obscure ownership.
- **SwiftUI ScenePhase**: https://developer.apple.com/documentation/swiftui/scenephase?changes=_4
  - Adopted: treat active, inactive, and background transitions as observable application lifecycle boundaries when a feature depends on suspension or resumption.
  - Conditional: only add lifecycle handling where work or state actually depends on those transitions.
  - Limit: scene phase does not prove hardware, entitlement, or background execution behavior.
- **SwiftUI accessibility modifiers**: https://developer.apple.com/documentation/SwiftUI/View-Accessibility
  - Adopted: preserve platform accessibility semantics and verify custom interactions with assistive technology behavior when semantics change.
  - Conditional: native controls often provide useful semantics without extra modifiers.
  - Limit: modifier presence alone is not proof that the resulting experience is usable with VoiceOver.
- **SwiftUI documentation index**: https://developer.apple.com/documentation/swiftui
  - Preserved use: current API, platform availability, navigation, layout, and lifecycle discovery.

Simulator evidence can establish pure UI state and navigation behavior when faithfully modeled. Device only capabilities need physical device evidence.
