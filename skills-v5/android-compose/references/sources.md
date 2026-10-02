# Source map

Use the installed Compose and Android versions. These API sources support the Android-specific state and lifecycle rules; they do not establish device behavior or empirical skill qualification.

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: broader native-interface.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held-out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no-skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **Jetpack Compose documentation**: https://developer.android.com/compose
  - Scope: Android Jetpack Compose documentation as available 2026-09-04
  - Use: navigation to platform-specific guidance; the precise lifecycle sources below support the adopted rules.
  - Verified: 2026-09-04; refresh after 45 days.
- **Save UI state in Compose**: https://developer.android.com/develop/ui/compose/state-saving
  - Use: configuration recreation, system-initiated process death, small saved state, and rebuilding screen data from its owner.
  - Verified: 2026-09-06; refresh after 45 days.
- **Side-effects in Compose**: https://developer.android.com/develop/ui/compose/side-effects
  - Use: composition-owned effects, restart keys, cancellation, and cleanup.
  - Verified: 2026-09-06; refresh after 45 days.
- **Lazy lists and lazy grids**: https://developer.android.com/develop/ui/compose/lists
  - Use: stable item identity and supported key types for remembered/restored item state.
  - Verified: 2026-09-06; refresh after 45 days.

## Interpretation rules

- Adopted: distinguish composition lifetime, configuration recreation, process recreation, and durable business data; they need different evidence.
- Adapted: choose state owners and effect keys from the existing architecture and the user's restoration expectations.
- Rejected: requiring a ViewModel merely for persistence, saving whole datasets in a Bundle, or claiming restored behavior from a screenshot.
