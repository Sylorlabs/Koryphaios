# Source map

## Qualification basis

- Package authorship is independent from empirical qualification; the audit/evaluation ledger is authoritative for qualification status.
- Hierarchy: broader verification, accessibility-practice.
- Routing: five positive, five near-neighbor negative, three compound/ambiguous, and three adversarial held out cases through the real resolver.
- Full-task evaluation: two individual scenarios with six falsifiable checks, same-model skill/no skill pairing, regression retention, and blind semantic judging.
- Source discipline: authoritative/spec/reference sources outrank community patterns when they conflict; runtime evidence outranks examples for behavioral claims.

## Maintained sources

- **W3C WCAG 2.2**: https://www.w3.org/TR/WCAG22/
  - Use: normative web success criteria for keyboard operation, focus, reflow, contrast, labels/instructions, status/error handling, and related web accessibility claims.
  - Version scope: WCAG 2.2 Recommendation.
  - Verified: 2026-09-05; refresh after 365 days.

- **W3C ARIA Authoring Practices Guide**: https://www.w3.org/WAI/ARIA/apg/
  - Use: web widget semantics and keyboard interaction patterns; APG is implementation guidance, not a substitute for the normative WAI-ARIA/WCAG requirements.
  - Version scope: APG material available 2026-09-05.
  - Verified: 2026-09-05; refresh after 90 days.

- **W3C APG: Accessible Names and Descriptions**: https://www.w3.org/WAI/ARIA/apg/practices/names-and-descriptions/
  - Use: web accessible-name quality, role/name relationships, and name/description distinctions when evaluating screen reader output.
  - Version scope: APG guidance available 2026-09-05.
  - Verified: 2026-09-05; refresh after 90 days.

- **W3C APG: Modal Dialog Pattern**: https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/
  - Use: modal keyboard behavior, forward/reverse focus containment, Escape, initial focus and return to the invoking context. APG is implementation guidance, not a native-platform specification or independent speech capture.
  - Version scope: APG guidance available 2026-10-10.
  - Verified: 2026-10-10; refresh after 90 days.

- **W3C WCAG 2.2 Understanding SC 2.4.11**: https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum
  - Use: determine whether author-created content obscures a focused element. Check the observed focused target during keyboard navigation, including overlays, rather than inferring visibility from focusable DOM state.
  - Version scope: WCAG 2.2 Understanding guidance available 2026-10-10.
  - Verified: 2026-10-10; refresh after 90 days.

- **Android Developers: Test your app's accessibility**: https://developer.android.com/guide/topics/ui/accessibility/testing
  - Use: Android manual testing with TalkBack, Switch Access/alternate switches, accessibility scanning, and automated Compose/UI checks.
  - Version scope: Android guidance available 2026-11-07.
  - Verified: 2026-11-07; refresh after 60 days.
  - Operational detail: Google documents separate TalkBack navigation and Switch Access scanning exercises. Keep their observations separate; Compose/UI tests remain a distinct evidence channel.

- **Apple Human Interface Guidelines: Accessibility**: https://developer.apple.com/design/human-interface-guidelines/accessibility
  - Use: Apple-platform accessibility expectations, adaptability, alternate interaction, and system accessibility contexts.
  - Version scope: Apple HIG material available 2026-11-07.
  - Verified: 2026-11-07; refresh after 60 days.

## Interpretation rules

- Apply WCAG/ARIA to web content; use the target native platform's accessibility APIs and guidance for native claims.
- Prefer native semantics and controls over recreating their accessibility contract manually.
- Automated tools detect a subset of issues and never prove end-to-end task accessibility by themselves.
- Record the exact assistive technology, input method, runtime, and settings used for manual evidence.
- Do not treat a browser accessibility tree, semantic node dump, or synthetic service event as direct evidence of screen reader speech, focus indication, or switch hardware input.
- Keep the pass/failed/untested/blocked status of each required environment visible in the final verification verdict; a simulation may pass without clearing native-environment readiness.
- Require a scanner execution record (tool/version, invocation, target build/state, time, original findings/report) before asserting `passed` or zero findings. Fixture checks and a green test suite do not supply that record.
- Preserve distinct fields for fixture verdict and real-world accessibility verdict. A simulator's `manual: true` row or an accepted blind review establishes neither human input nor live assistive-technology speech.
- When a successful destructive action removes the trigger, verify the replacement focus target in the resulting UI state; never assert restoration to an element that no longer exists.
