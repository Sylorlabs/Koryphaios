---
name: critic-auto-selection
description: Decide whether a finished answer in Critic Auto mode needs an independent review, and request one with a concrete concern when a different model could still catch a material error. Use when the manager has to make the per-turn review decision rather than run a review itself.
---

# Critic Auto Selection

## Scope and routing

- Broader skill: `verification`.
- This skill makes one decision per finished answer: request an independent review now, or let the answer stand.
- It is not the review. Selecting this skill never means producing findings; that is `critic-review`.
- Select it when the question is whether this specific answer, with this specific request behind it, is worth a second model's attention in Auto mode.
- Always and Off are user choices, not this decision. In those modes there is nothing to decide and this skill does not apply.
- Do not select it to ask whether a system is ready, to acknowledge a message, or to choose which model to use.

## What the decision protects

An independent review costs a model call and a delay, and it buys the chance that a different model catches what the first one missed. The decision is therefore a comparison between two costs: the chance this answer is materially wrong, and the cost of the review.

The mistake to avoid is symmetric. Requesting a review for everything spends the user's time on answers that were never at risk and teaches the user to dismiss the prompt. Requesting nothing because the answer felt fluent leaves the dangerous case unexamined.

## Signals that justify a request

Request a review when at least one of these is true, and say which one:

- The answer asserts a result that was not observed: a test that was not run, a metric that was not measured, a behaviour that was not exercised.
- The answer changes something irreversible or expensive: a migration, a deletion, a permission boundary, a released artifact, money, or a credential.
- The answer states a security, privacy, or safety conclusion. These are the claims a second reader earns their keep on.
- The answer reconciles conflicting evidence, or reports that a previous failure is now fixed.
- The answer is long or spans several subsystems, so a single reader plausibly lost the thread.
- The user asked for a review of the answer itself.

## Signals that do not

Do not request a review when the answer is a short confirmation, a restatement of what the user already said, a trivial readiness check, or a straightforward lookup the user can verify in one glance. The same applies when the answer delivers nothing to inspect: a request for the user's input, a note that work is still pending, or a confirmation that the user's own plan is still the plan, each contain no claim of the answer's own, so there is nothing to review even when the turn feels unfinished. "The user mentioned testing" is not a signal: a request to test something is work to do, not a reason to review a finished answer. Length alone is not a signal either. A long answer about a low-risk, easily verified topic does not need a second model.

## Making the request concrete

A request without a stated concern is worse than no request, because the reviewer cannot know what to inspect. Name the specific claim, omission, or risk that a second model should attack, for example: "the answer claims the suite passed but the run output is not in the transcript". A vague "please review" is a failure of this decision even when requesting review was correct.

When the answer carries several risks, name the one that would change what the user does next. Another model reading a focused question will find more than one reading a general one.

## When an earlier concern already exists

An earlier turn may have recorded a concern, and that record is context rather than a risk signal for the
answer in front of you. A record cannot manufacture a claim that the current answer does not make, so an
answer that delivers nothing and asks for input still gets no review. Ask what this answer actually changed. A closed concern plus a one line edit with
no claim worth verifying does not justify a review, and inheriting the earlier concern as the reason is the
same mistake as skipping the decision: in both cases the current answer was never judged.

## Recording the decision

For each case, record the decision, the reason, and the concern when a review is requested. A decision record with an empty reason is indistinguishable from a guess and cannot be audited later.

## Boundaries

- Never request a review to compensate for an answer you already know is wrong. Fix the answer.
- Never skip the final decision because an earlier turn mentioned a concern. A recorded concern does not replace the decision on this answer.
- Do not fabricate a concern to justify a request, and do not suppress a real one to keep the turn short.
- Prefer a reviewer different from the model that produced the answer when one is available; the same model reading its own answer is the weakest form of review.
