---
name: interface-usability-testing
description: Test interface tasks, control behavior, feedback, and recovery with interaction evidence and representative users where needed. Use when running UI, interaction, or usability tests; use visual-verification for rendered layout alone and accessibility-verification for accessibility conformance.
---

# Interface Usability Testing

Establish whether an interface supports a realistic user task, not merely whether its code runs or its pixels match a reference. Separate executable interaction evidence from human usability evidence: automation can prove mechanics and state transitions, while claims about comprehension, discoverability, confidence, or ease of recovery require observation of representative users or clearly labelled proxy evidence.

## Test loop

1. **Define the task and success condition.** State the user goal, realistic starting state/data, target medium and input method, observable completion condition, material errors, and recovery path. Avoid task wording that names the control or gives away the interaction.
2. **Exercise the real interaction surface.** Use the supported browser, desktop, mobile, game, or device interface. Cover the controls and states needed for the task: navigation, selection, entry, validation, loading, empty/partial data, confirmation, cancellation, failure, retry, and return to a usable state.
3. **Separate mechanics from usability.** Automated interaction checks may establish that a control is reachable, an action fires, state persists, and an error can be recovered from. They do not establish that a person will understand what to do.
4. **For usability claims, observe representative tasks.** Recruit actual or likely users, or record why a proxy population is being used. Give neutral, believable task scenarios, mostly observe and listen, record whether the participant succeeds without hints, where they hesitate or choose a wrong path, what errors occur, and how they recover. Do not rescue a participant before the observed difficulty has been captured.
5. **Keep evidence attributable.** Distinguish product defects from facilitator intervention, test-data problems, prototype limitations, unavailable backend behavior, and participant-specific setup. For repeated rounds, keep task wording and success criteria stable enough to compare results.
6. **Retest the corrected task.** A design change closes a usability finding only when the affected task/state has fresh evidence. Preserve representative failures as regression scenarios when they can recur mechanically.

## When the evidence packet excludes the runtime

Some evaluations hand over a closed packet of authored records instead of a running product. Treat the packet as the whole evidence base. Do not browse, do not invent measurements, and never describe an interaction you did not drive.

Deliver the work anyway, in three files:

1. `result.md` states the task analysis, the test or design decision it supports, and the recovery design the records justify.
2. `verification.md` walks every falsifiable check and labels it `passed`, `failed`, `unavailable`, or `not-applicable`, citing the record that supports the label.
3. `evidence-map.json` carries `claims[]` with evidence ids and a confidence of `observed`, `inferred`, `assumption`, or `unresolved`; `verification[]` rows with a check id and status; `artifacts[]` rows naming each required artifact as `produced`, `external-evaluator`, or `unavailable` with a note; and `limitations[]`.

Trace every supplied record from at least one claim and give every check a verification row. A check that needs a runtime, participant, or device the packet does not contain stays `unavailable` with the reason recorded. Records the harness marks as evaluator metadata are not product evidence and do not become claims. Honest unavailability completes the answer only when the packet really excludes the surface; a fabricated observation never does.

## Specialist boundaries

- `usability-evaluation` owns broader study design, synthesis, research conclusions, and prioritization across evidence. This skill owns executing and evidencing concrete interface tasks.
- `functional-verification` owns business/acceptance correctness. Compose it when the task must also prove domain state, persistence, or side effects beyond the interface interaction.
- `visual-verification` owns layout, clipping, responsive rendering, density, screenshot/diff evidence, and visual-state integrity. A pixel diff is not usability evidence.
- `accessibility-verification` owns keyboard/focus semantics, accessible name/role/value/state, assistive-technology behavior, scaling/reflow, and conformance evidence. Automated accessibility tools cannot substitute for that specialist verdict.
- `testing-engineering` owns durable suite architecture and broad testing strategy.

Do not label an interface “intuitive” or “easy” from agent opinion, a screenshot, a green automation run, or one anecdote. Use [the maintained source map](references/sources.md) for task design, participant observation, benchmarking, and accessibility-evidence boundaries.
