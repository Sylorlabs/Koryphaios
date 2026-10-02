# Source map

`privacy-engineering` is individually authored for V5; empirical qualification is tracked separately in the audit/evaluation ledger. These sources bound privacy-engineering concepts and version-sensitive framework status; product behavior and data-store evidence still determine whether a concrete privacy claim is true.

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: broader security-review.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held-out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no-skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **NIST Privacy Framework**: https://www.nist.gov/privacy-framework
  - Scope: Privacy Framework 1.0 is the current final framework. Privacy Framework 1.1 remains an Initial Public Draft as verified 2026-09-05; do not present 1.1 as final.
  - Use: organizational privacy-risk outcomes and vocabulary for identifying, governing, controlling, communicating, and protecting data processing.
  - Verified: 2026-09-05; refresh after 90 days.
- **NISTIR 8062: An Introduction to Privacy Engineering and Risk Management in Federal Systems**: https://csrc.nist.gov/pubs/ir/8062/final
  - Scope: final January 2017 publication; NIST publication record updated May 2026.
  - Use: privacy engineering objectives of predictability, manageability, and disassociability, plus the privacy-risk model that separates privacy problems from security failures.
  - Verified: 2026-09-05; refresh after 365 days.

## Interpretation rules

- Privacy risk can arise from data processing even when confidentiality, integrity, and availability controls work as designed.
- Use NIST's privacy-engineering objectives as engineering lenses, not as claims that a particular jurisdiction requires a specific UI or legal basis.
- Distinguish aggregation, pseudonymization, and de-identification. Removing a direct identifier does not by itself make a dataset anonymous or unlinkable.
- Make retention and deletion claims only after tracing every relevant live copy, derived store, retry path, backup/restore behavior, and external processor boundary.
- A preference or consent UI is evidence only of UI state until downstream processing changes are observed.
