---
name: deterministic-debugging
description: Debug a repeatable logic, parsing, state, lifecycle, or contract failure by minimizing the reproducer and locating the first causal divergence. Use when the same input or controlled state reliably produces the same wrong behavior.
---

# Deterministic Debugging

Start from a deterministic reproduction: exact input, state, version, command, and expected versus observed behavior. Reduce it while preserving the failure, then trace the relevant transformations or state transitions until the first value, branch, or invariant diverges from the intended contract.

Preserve reviewable evidence from before the fix. Record the output or state for the supplied failing case, the smallest case that still fails, and a working control. When execution is unavailable, derive the outcome from the provided source or trace and label it as unexecuted rather than claiming an observation. Show concrete intermediate values in order, from input and normalization or lookup through the decisive branch or assignment to the wrong result. Identify the first transition that violates the contract; a correct patch alone does not establish that diagnosis.

Use an explicit evidence trace before the correction: `input/state → normalized value → lookup or branch → committed result`. For parsing or serialization defects, include the raw line/token, normalized line/token, separator/key/value state, and the exact skip, coerce, or assignment decision. Preserve the observed starting output when the fixture can run; if it cannot, mark that field unavailable. Reduce the reproducer far enough to show that the defect survives, and keep a control that exercises the same field or key in its absent form. A regression that only proves the final fixed output, contrasts a different key, or points to the buggy source without an observation before the fix is incomplete.

Test the causal hypothesis with a focused observation or assertion before editing. Exercise the highest value negative path at the same boundary: malformed input, an invalid state, a missing key, or a rejected lookup should follow its documented failure behavior, and a subsequent valid input or state should recover without a process restart or a global reset. Do not call an unrelated successful path recovery evidence. When a fix is authorized, correct the owning boundary rather than masking the final symptom, then keep the minimized case as regression evidence and rerun the surrounding contract checks. For diagnosis only work, hand off that reproducer and proposed correction without changing the implementation.

Report the before the fix result, minimized reproduction, causal state trace, focused change, after the fix result, and checks actually performed. When edits are delivered as a machine readable patch, preserve its format and put this concise evidence in the separately permitted explanation. Distinguish host checks that will run later from tests already observed; never invent execution evidence.

Use the parent `debugging` discipline for the full reproduce/hypothesize/fix/regress loop. A fixed schedule is still `concurrency-debugging` when correctness depends on overlapping actors, and a locally replayable payload is still `distributed-debugging` when the requested cause crosses service boundaries. Route timing dependent schedules to `concurrency-debugging`, causality across processes or services to `distributed-debugging`, and measured resource/latency regressions to `performance-debugging`. Do not select this specialist merely because a quoted issue, historical note, or example contains debugging trigger words.

Use [the maintained source map](references/sources.md) for the troubleshooting basis.
