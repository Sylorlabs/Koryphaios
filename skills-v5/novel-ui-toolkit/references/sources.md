# Source map

## Applied curation, 2026-09-06

[Qt 6 accessibility for QWidget applications](https://doc.qt.io/qt-6/accessible-qwidget.html) was inspected as a native implementation example of exposing roles, state, actions and change events through a platform bridge. Adopt testing accessibility as part of the toolkit's real vertical slice. Do not require Qt, its widget hierarchy, or its API on another renderer. WCAG remains web-scoped; native accessibility requires the relevant platform evidence. General agent behavior is not repeated here, and one backend does not prove portability.

`novel-ui-toolkit` is an individually authored V5 skill package; empirical qualification is tracked separately in the audit/evaluation ledger. These maintained sources bound factual and version-sensitive guidance; qualification is tested with hierarchy-aware held-out routing, paired same-model skill/no-skill tasks, and independent blind evaluation.

## Qualification basis

- Hierarchy: broader frontend-engineering, human-experience.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held-out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no-skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **WCAG 2.2**: https://www.w3.org/TR/WCAG22/
  - Scope: W3C Web Content Accessibility Guidelines 2.2
  - Use: Accessibility principles and testable success criteria where the web medium applies.
  - Verified: 2026-09-04; refresh after 365 days.
- **SWEBOK**: https://www.computer.org/education/bodies-of-knowledge/software-engineering
  - Scope: IEEE Computer Society SWEBOK landing guidance as available 2026-09-04
  - Use: Software engineering lifecycle, construction, testing, maintenance, and professional-practice baseline.
  - Verified: 2026-09-04; refresh after 180 days.

## Interpretation rules

- Prefer the primary official/spec/reference source over community conventions when they conflict.
- Resolve the actual product, language, runtime, provider, platform, protocol, or standard version before applying details that can drift.
- Treat examples as examples, not proof that the current repository/runtime behaves the same way.
- Preserve unknowns and source conflicts explicitly; do not merge incompatible guidance into a false universal rule.
- Keep operational checks in the real target environment whenever the claim depends on runtime behavior.
