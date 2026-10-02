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

## Test hypotheses

Form a short list of plausible causes from the observed path and system design. Prefer tests that can rule hypotheses in or out with one controlled observation. Change one meaningful variable at a time when possible, and distinguish correlation from causal evidence.

Reduce the failure to the smallest useful input, state transition, component boundary, or timing condition. Do not rewrite broad areas merely to see whether the symptom disappears.

## Correct the cause

When a fix is authorized and the causal mechanism is supported, make the narrowest coherent correction that restores the intended contract. Preserve unrelated behavior, existing repository decisions, and user owned work. If authorized mitigation is required before root cause work can safely continue, clearly separate mitigation from the permanent fix.

If the requested mechanism cannot work, make that limitation visible and diagnose it. Do not silently substitute a fallback, reduced behavior, different implementation, or unrelated refactor and then report success.

## Preserve the regression

For an implemented fix, add or strengthen a check that fails on the demonstrated bug and passes with the correction at the most appropriate observable boundary. Run the original reproduction again as well as focused surrounding checks. Continue authorized work until the correction and relevant evidence are complete when the environment permits it. Report what was reproduced, what evidence established the cause, any actual change, and the checks performed. Do not imply that a proposed fix, a disappearing symptom, or an unverified fallback has been tested successfully.

## Routing boundary

This is the parent debugging discipline. Use `deterministic-debugging`, `concurrency-debugging`, `distributed-debugging`, `performance-debugging`, or `hardware-runtime-debugging` when the observed failure establishes that narrower boundary.

Do not activate for feature implementation, ordinary refactoring, explanation only requests, or a known cause code edit that no longer requires diagnosis.

Use [the maintained source map](references/sources.md) for the troubleshooting and regression testing evidence behind this workflow.
