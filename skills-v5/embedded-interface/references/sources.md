# Source map

## Applied curation, 2026-09-06

The [FDA guidance landing page](https://www.fda.gov/regulatory-information/search-fda-guidance-documents/applying-human-factors-and-usability-engineering-medical-devices) was inspected for intended users, uses, environments and reduction of use-related harm. The full PDF was not freshly reviewed. Adopt the human/device risk boundary where relevant, not a claim that every appliance is an FDA-regulated medical device. Confirmation alone is not an independent physical interlock. Hardware/simulator validity and safe-state evidence stay in this child; generic authority prose was removed.

`embedded-interface` is an individually authored V5 skill package; empirical qualification is tracked separately in the audit/evaluation ledger. These maintained sources bound factual and version-sensitive guidance; qualification is tested with hierarchy-aware held out routing, paired same-model skill/no skill tasks, and independent blind evaluation.

## Qualification basis

- Hierarchy: broader visual-interface-design, frontend-engineering.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **FDA human factors guidance**: https://www.fda.gov/regulatory-information/search-fda-guidance-documents/applying-human-factors-and-usability-engineering-medical-devices
  - Scope: FDA human-factors/usability engineering guidance as available 2026-09-04
  - Use: Safety-critical human-device interaction, use-related hazards, validation, and representative-use conditions.
  - Verified: 2026-09-04; refresh after 365 days.

## Interpretation rules

- Prefer the primary official/spec/reference source over community conventions when they conflict.
- Resolve the actual product, language, runtime, provider, platform, protocol, or standard version before applying details that can drift.
- Treat examples as examples, not proof that the current repository/runtime behaves the same way.
- Preserve unknowns and source conflicts explicitly; do not merge incompatible guidance into a false universal rule.
- Keep operational checks in the real target environment whenever the claim depends on runtime behavior.
