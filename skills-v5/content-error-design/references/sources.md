# Source map

Content/error design here covers language inside an interactive or technical experience: labels, instructions, status, unavailable states, warnings, confirmations, errors, diagnostics, recovery, and completion. It is not a general copywriting or editorial-content skill, and it does not own the underlying state machine or retry behavior.

## Maintained interpretation

- Start from the reader, decision, vocabulary, urgency, actual system state, impact, and next useful action. Say only what the system can support; preserve uncertainty when commit, sync, permission, or recovery state is not known.
- Design the relevant state family together. Include empty, progress, partial completion, cancellation, warnings, permissions, offline/degraded operation, failure, recovery, and success when relevant. Empty results are not failed loads; local save is not confirmed remote sync; requested cancellation is not confirmed cancellation.
- For a user-correctable error, identify the affected item with its visible label or useful source location and explain a concrete correction when known and safe to disclose. Do not frame service failure, capacity limits, policy, or permissions as if the user entered invalid information.
- Bind wording ready for implementation to supplied state/category IDs, authoritative triggers, impact/uncertainty, permitted dynamic fields, and action labels/effects. Missing inventory facts stay unresolved. Separate automatic recovery from reader action and state retention, loss, retry, restoration, support, and timing only when established; a blocked state need not invent a fix.
- Preserve useful diagnostic identifiers and context when they help support or debugging, but never expose secrets, tokens, private data, internal exploit detail, or unsupported guesses about root cause.
- Avoid blame, false reassurance, vague codes without explanation, cute distress language, all-caps urgency, and disappearing critical information. “Try again” is useful only when retry is actually a reasonable action and the message still explains the situation.
- Review wording where it will appear, including constrained surfaces, localization expansion, assistive output, interruption, and long running operations. Test whether representative readers understand the situation and can choose the intended action; grammar approval alone is not evidence of usability.
- Validate success, failure, and recovery against the same state facts, including recovery that fails or has no available fix. Record expected understanding/action, method, actual result and evidence; proposed reader or assistive checks remain unexecuted until observed.

## Source boundaries

[GOV.UK's Error message component](https://design-system.service.gov.uk/components/error-message/) is strong operational evidence for user-correctable validation errors, matching field-label terminology, retaining entered answers, and separating validation from permission/capacity/service problems. Its component placement and visual conventions are GOV.UK-specific and are not universalized across all media. Content must reflect actual retention behavior; wording alone cannot preserve input.

WCAG 2.2 is normative for web content: [3.3.1 Error Identification](https://www.w3.org/TR/WCAG22/#error-identification) requires detected input errors to be identified and described in text; [3.3.2 Labels or Instructions](https://www.w3.org/TR/WCAG22/#labels-or-instructions) covers required input guidance; [3.3.3 Error Suggestion](https://www.w3.org/TR/WCAG22/#error-suggestion) requires known correction suggestions unless they jeopardize security or purpose; [4.1.3 Status Messages](https://www.w3.org/TR/WCAG22/#status-messages) governs programmatic exposure of applicable status messages without receiving focus. These are not universal DOM/ARIA prescriptions for native or terminal interfaces. Full conformance testing remains with accessibility specialists.

[Apple HIG Writing](https://developer.apple.com/design/human-interface-guidelines/writing) ([official Markdown](https://developer.apple.com/design/human-interface-guidelines/writing.md)) is authoritative only for Apple platform conventions. Its broader principles of language patterns, contextual tone, useful empty states, and clear next actions are transferable; platform wording conventions are not forced onto other media.

Rampstack's MIT [`content-and-copy` package at the inspected revision](https://github.com/rampstackco/claude-skills/blob/ac2b078f5025336c475d72a6fafa256d28aa6173/skills/content-and-copy/SKILL.md) is useful community evidence for defining the reader and goal, editing for clarity, and removing generic filler. Its blog, SEO, marketing, and editorial structures are explicitly outside `content-error-design`. Official guidance and specifications take precedence over community patterns when they conflict; none of these sources proves a particular product's state, recovery behavior, or reader comprehension.

## Verification record

- GOV.UK Design System Error message: official guidance rechecked 2026-10-17; recheck within 90 days.
- WCAG 2.2 Recommendation dated 2024-12-12: official W3C specification rechecked 2026-10-17, including SC 3.3.1-3.3.3 and 4.1.3; recheck within 180 days or after a new Recommendation.
- Apple HIG Writing: official Apple Markdown documentation rechecked 2026-10-17; recheck within 90 days.
- Rampstack `content-and-copy`: GitHub revision `ac2b078f5025336c475d72a6fafa256d28aa6173` and its [MIT license](https://github.com/rampstackco/claude-skills/blob/ac2b078f5025336c475d72a6fafa256d28aa6173/LICENSE) rechecked 2026-10-17. Recheck within 30 days.
