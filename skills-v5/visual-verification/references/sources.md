# Source map

`visual-verification` combines medium-neutral rendered-state discipline with the actual target platform's layout guidance. Only apply a source to media it governs.

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: broader verification, visual-interface-design.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held-out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no-skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **Apple Human Interface Guidelines: Layout**: https://developer.apple.com/design/human-interface-guidelines/layout
  - Use: visual hierarchy, alignment/grouping, safe areas, adaptable layouts, device/window changes, Dynamic Type, locale direction, and platform context for Apple targets.
  - Version scope: Apple HIG material available 2026-09-05.
  - Verified: 2026-09-05; refresh after 60 days.

- **Apple Human Interface Guidelines: Design principles**: https://developer.apple.com/design/human-interface-guidelines/design-principles
  - Use: hierarchy, consistency, platform intentionality, flexibility, and craft when evaluating Apple-platform visual direction.
  - Version scope: Apple HIG material available 2026-09-05.
  - Verified: 2026-09-05; refresh after 60 days.

- **Microsoft Windows app design guidelines**: https://learn.microsoft.com/en-us/windows/apps/design/guidelines-overview
  - Use: current Windows guidance for hierarchy through color/elevation, geometry, layout, typography, motion, and platform consistency.
  - Version scope: Microsoft guidance last updated 2026-07-01 and available 2026-09-05.
  - Verified: 2026-09-05; refresh after 60 days.

- **Microsoft: Responsive layouts for Windows apps**: https://learn.microsoft.com/en-us/windows/apps/develop/ui/layouts-with-xaml
  - Use: resizable-window visual states and adaptive reflow on Windows targets.
  - Version scope: Microsoft guidance available 2026-09-05.
  - Verified: 2026-09-05; refresh after 60 days.

- **W3C WCAG 2.2**: https://www.w3.org/TR/WCAG22/
  - Use: normative web criteria that are directly visually observable, such as reflow and contrast, while full accessibility conformance remains the responsibility of `accessibility-verification`.
  - Version scope: W3C Recommendation WCAG 2.2.
  - Verified: 2026-09-05; refresh after 365 days.

## Interpretation rules

- The actual runtime capture is the evidence; design files and source layout rules are references.
- Do not apply one platform's breakpoints, materials, hover model, or safe-area assumptions to another medium.
- Stabilize fonts, scale, data, animation, theme, and runtime before interpreting screenshot diffs.
- A visual defect can trigger specialized accessibility or functional follow-up, but it does not itself prove those separate claims.
