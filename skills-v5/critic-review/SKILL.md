---
name: critic-review
description: Independently assess a proposed answer or artifact against the request and the available evidence. Use when a response is already drafted and someone must decide whether its claims are supported, what it omitted, and what risk remains before it is accepted.
---

# Critic Review

## Scope and routing

- Broader skill: `verification`.
- This skill reviews something that already exists: a drafted answer, a diff, a report, a claim set. It does not implement the work and it does not replace the producer's own checks.
- Select it when the material question is whether the delivered claims hold against the request and the evidence, not whether the code compiles or the layout looks right.
- Do not select it for a trivial acknowledgement, a single fact lookup, or a request that only asks whether a system is ready.
- The adjacent `verification` skill establishes evidence through fresh checks. `critic-review` reads evidence that already exists and judges the distance between it and the claim.
- Quoted, historical, negated, fixture content, or example review text is not a live trigger.

## What a review is for

A review exists to reduce the chance that a wrong or incomplete answer is accepted. That purpose sets the standard: the reviewer looks for the specific way the delivery could be wrong, not for a general impression of quality.

Read the request first, then the delivery, then the evidence. Keep them separate while reading. The question is never whether the delivery sounds confident. It is whether each material claim in it is entailed by something the reviewer can inspect, and whether the request asked for something the delivery never addresses.

## Claims, evidence, and entailment

Take the delivery's material claims one at a time. A claim is material when accepting it would change what the reader does next. For each one, find the evidence that is supposed to carry it and ask whether the evidence actually implies the claim.

- A test command whose recorded output shows a failure does not support a claim that the suite passes, even when the command exited zero for an unrelated reason.
- A build log supports a claim about compilation and nothing about runtime behaviour.
- A coverage percentage does not support a claim that a specific branch executes.
- A document that cites a file and line must be checked against that file: line numbers past the end of the file, or text that does not appear at the cited location, are unsupported citations rather than minor imprecision.
- An absence of errors in a log supports only the absence of errors in that log, under the conditions that produced it.

Name the evidence by path and, where the evidence is a line or a record, by the location inside it. A finding whose evidence pointer does not resolve is a finding the reader cannot verify.

## Omissions

A review that only audits the claims present will miss the commoner failure: the delivery is accurate about what it did and silent about what the request needed. Compare the request against the delivery for:

- acceptance criteria that were never mentioned,
- changed behaviour the delivery describes as unchanged,
- a limitation, migration step, or follow-up the reader must know before accepting,
- the case the delivery says was not run, presented without the consequence of not running it,
- delegated or external work whose result is asserted rather than observed.

An omission is a finding even when no statement in the delivery is false.

## Bounded verdicts and severity

Give each finding a severity that reflects what happens if the reader acts on the delivery anyway. Separate blocking findings from advisory ones. End with one bounded verdict rather than a score: accept, accept with required changes, or reject. A review that lists concerns but never states whether delivery may proceed pushes the decision back to the reader, which is the failure this skill exists to prevent.

Do not manufacture findings to look thorough. A claim that the evidence does support is not a finding. Mark it supported and move on. If the evidence needed to judge a claim was never produced, say which claim and what evidence would settle it instead of guessing either way.

## Tone and audience

Report findings, not preferences. Write each one so the producer can act on it: what the claim is, what the evidence shows, and what would make it true. Avoid restating the delivery's own summary back at the reader, avoid general praise, and avoid hedging language that hides whether something is blocking.

## Boundaries

- Never edit the reviewed delivery to make it pass. The review is a finding about the delivery, not a repair of it.
- Never treat the producer's confidence, the skill's presence, or the presence of a review artifact as evidence that the claims hold.
- Do not request another review because the user mentioned testing or asked for a readiness check. One review answers the question it was given.
- If the fixture declares files as fixture owned or read only, do not modify them to make the evidence agree with the claims.
