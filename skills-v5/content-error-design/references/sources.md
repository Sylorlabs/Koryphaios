# Source map

Content/error design here covers language inside an interactive or technical experience: labels, instructions, status, unavailable states, warnings, confirmations, errors, diagnostics, recovery, and completion. It is not a general copywriting or editorial-content skill, and it does not own the underlying state machine or retry behavior.

## Maintained interpretation

- Start from the reader, decision, vocabulary, urgency, actual system state, impact, and next useful action. Say only what the system can support; preserve uncertainty when commit, sync, permission, or recovery state is not known.
- Design the relevant state family together. Orientation, progress, partial completion, warnings, permissions, offline/degraded operation, failure, recovery, and success should use consistent terms and avoid contradictions.
- For a user-correctable error, identify the affected item and explain a concrete correction when one is known. Do not frame service failure, capacity limits, policy, or permissions as if the user entered invalid information.
- Preserve useful diagnostic identifiers and context when they help support or debugging, but never expose secrets, tokens, private data, internal exploit detail, or unsupported guesses about root cause.
- Avoid blame, false reassurance, vague codes without explanation, cute distress language, all-caps urgency, and disappearing critical information. “Try again” is useful only when retry is actually a reasonable action and the message still explains the situation.
- Review wording where it will appear, including constrained surfaces, localization expansion, assistive output, interruption, and long-running operations. Test whether representative readers understand the situation and can choose the intended action; grammar approval alone is not evidence of usability.

## Source boundaries

GOV.UK's Error message component is strong operational evidence for user-correctable validation errors and for separating those from permission/capacity/service problems. Its component placement and visual conventions are GOV.UK-specific and are not universalized across all media.

WCAG 2.2 gives a normative accessibility floor for error identification, labels/instructions, and status messages. This skill must preserve those needs, while full conformance testing remains with accessibility specialists.

Apple HIG Writing is authoritative only for Apple platform conventions. Its broader principle that product words are part of the experience is transferable; platform wording conventions are not forced onto other media.

Rampstack's MIT `content-and-copy` package is useful community evidence for defining the reader and goal, editing for clarity, and removing generic filler. Its blog, SEO, marketing, and editorial structures are explicitly outside `content-error-design`.

## Verification record

- GOV.UK Design System Error message: official guidance verified 2026-09-04; recheck within 90 days.
- WCAG 2.2 Recommendation: official W3C specification verified 2026-09-04; recheck within 180 days or after a new Recommendation.
- Apple HIG Writing: official Apple documentation verified 2026-09-04; recheck within 90 days.
- Rampstack `content-and-copy`: GitHub `main` inspected 2026-09-04; repository license is MIT. Recheck within 30 days.
