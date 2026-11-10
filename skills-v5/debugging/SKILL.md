---
name: debugging
description: Reproduce an observed software failure, establish its root cause with evidence, implement a narrow correction, and preserve a regression check. Use when the user asks to debug, diagnose, or fix a bug whose cause is not already established.
---

# Debugging

Treat debugging as an evidence loop, not a sequence of guesses.

Resolve whether the request authorizes diagnosis, a fix, or operational mitigation. Diagnosis alone permits scoped evidence collection that does not mutate the system. It does not authorize implementation changes, fault injection into live systems, or new instrumentation. Return the supported cause and proposed correction when those effects are not authorized. Once the user has authorized a fix, continue through the agreed correction and verification without asking for the same approval again.

## Establish the failure

- Capture the exact symptom, expected behavior, affected boundary, and environment before changing code.
- Reproduce the failure when practical. If reproduction is unsafe or unavailable, establish it from logs, traces, crash output, state, or another observable artifact and state the limitation.
- Learn enough of the relevant system path to distinguish where correct state first becomes incorrect. Do not mistake the final symptom for the cause.
- Preserve evidence needed to compare the failing and corrected behavior.

Before editing, make the evidence boundary reviewable: retain the supplied failing output or state, the exact command/fixture and environment, one working control, and the first observable transition that differs from the contract. If a host check, profile, trace, or build was not run by the current execution, label it unavailable rather than importing a later result, or one owned by the evaluator, into the response.

Keep the control matrix explicit: include the failing case, one nearby valid case, the relevant invalid or denied case, and a case covering recovery or repeated use when the boundary has lifecycle or state. Record the command, source/runtime identity, observed result, and exit/status for each; a proposed check or a scorer declaration is not an observation. A fix is ready for promotion only when the authored regression fails against the demonstrated starting behavior, passes after the narrow correction, and preserves the control and negative behavior.

## Test hypotheses

Form a short list of plausible causes from the observed path and system design. Prefer tests that can rule hypotheses in or out with one controlled observation. Change one meaningful variable at a time when possible, and distinguish correlation from causal evidence.

Reduce the failure to the smallest useful input, state transition, component boundary, or timing condition. Do not rewrite broad areas merely to see whether the symptom disappears.

## Correct the cause

When a fix is authorized and the causal mechanism is supported, make the narrowest coherent correction that restores the intended contract. Preserve unrelated behavior, existing repository decisions, and user owned work. If authorized mitigation is required before root cause work can safely continue, clearly separate mitigation from the permanent fix.

If the requested mechanism cannot work, make that limitation visible and diagnose it. Do not silently substitute a fallback, reduced behavior, different implementation, or unrelated refactor and then report success.

## Preserve the regression

For an implemented fix, add or strengthen a check that fails on the demonstrated bug and passes with the correction at the most appropriate observable boundary. Run the original reproduction again as well as focused surrounding checks. Continue authorized work until the correction and relevant evidence are complete when the environment permits it. Report what was reproduced, what evidence established the cause, any actual change, and the checks performed. Do not imply that a proposed fix, a disappearing symptom, or an unverified fallback has been tested successfully.

## Routing boundary

This is the parent debugging discipline. Keep the parent selected for the full evidence loop, and add `deterministic-debugging`, `concurrency-debugging`, `distributed-debugging`, `performance-debugging`, or `hardware-runtime-debugging` when the observed mechanism establishes that narrower boundary. A fixed input/state failure routes to deterministic debugging; alternate interleavings or ownership routes to concurrency debugging; identity and delivery across processes or services route to distributed debugging; measured latency/resource budgets route to performance debugging; and physical device, driver, firmware, or transport evidence routes to hardware runtime debugging. Do not use the parent as a substitute for a control specific to a specialist when the boundary is already established.

Do not activate for feature implementation, ordinary refactoring, explanation only requests, or a known cause code edit that no longer requires diagnosis.

Use [the maintained source map](references/sources.md) for the troubleshooting and regression testing evidence behind this workflow.
