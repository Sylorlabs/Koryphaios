---
name: plan-mode
description: Run Koryphaios's explicit read-only Plan interaction mode as a discovery and decision-making engagement that produces a durable implementation-ready plan. Use when the user explicitly invokes Plan mode; ordinary requests to make a plan belong to normal planning guidance.
---

# Plan-mode operating contract

Plan before implementation. Treat the current request as a discovery and decision-making engagement: establish what the user wants to achieve, what success means, what must not change, who is affected, and what authority is available.

While Plan mode is active, do not modify project files, execute write-capable shell commands, commit, create pull requests, or delegate implementation. Read, search, inspect, research, ask questions, and maintain planning artifacts instead. This skill is guidance inside a host-enforced mode; it does not grant or remove tool authority by itself.

Start with a concise restatement of the outcome and a small evidence-backed initial map. Inspect applicable repository guidance, current workspace state, relevant code paths, tests, settings, and runtime boundaries before proposing a solution. Separate observed facts from assumptions, hypotheses, user preferences, and unresolved questions. Never turn a guessed requirement into a plan constraint without labeling it.

## Ask useful questions early and throughout

Ask questions when an answer can materially change scope, user experience, compatibility, ownership, safety, rollout, success criteria, or the chosen implementation path. Keep the batch small and focused: two to four decision-changing questions, each with why the answer matters and, where useful, a recommended default and its trade-off. A vague request for more information, or a long interview that a resumable checkpoint could have carried, is not planning.

Do not ask the user for facts that can be verified cheaply from the workspace, supplied material, or authoritative sources. Do not block low-risk discovery on a reversible preference. When a decision is reversible, state the assumption, its impact, and the trigger for revisiting it. When it is not reversible or changes authority, stop planning past that decision until the user resolves it.

Never write an unanswered compatibility, rollback, downgrade, or rollout decision into the durable record as confirmed. Keep those in the open-decision list with the options and why each is material, even when repository evidence suggests an answer: an inferred product decision is exactly the one that must not become a constraint. Confirmed decisions carry only what the user actually decided.

Keep the host note's own schema intact. The open-decision list holds the host's decision identifiers as plain strings; put options, trade-offs, and materiality in a separate field beside them rather than reshaping the identifiers into richer entries. A note the host can no longer read is not a durable record.

## Maintain a durable planning record

Use the host's plan note as the living record for substantial planning work, and write the checkpoint the host names rather than leaving the interim state only in the conversation. Keep the request, confirmed context, open questions, decisions, alternatives, risks, milestones, and verification evidence current enough that another agent or human can resume without reconstructing the conversation.

Put the question batch where a reader will find it: phrase each decision-changing item as a direct question to the user ending in a question mark, and write the same batch into the durable checkpoint as well as the response. A narrative that a decision is required, without an actual question, leaves the reader unable to answer it.

Consult existing durable context before asking a question that may already be answered. Treat memory as fallible context rather than current truth and verify drift-prone details. Do not store secrets, transient speculation, raw private content, or a transcript merely because a note is available.

## Produce an executable decision record

Keep the plan dependency ordered and concrete. For each material step, identify the target surface, intended change, reason, dependencies, failure behavior, acceptance criteria, verification method, and rollback or recovery path where relevant. Record consequential alternatives and the evidence that would change the decision.

For UI or workflow work, cover the user journey and meaningful empty, loading, error, permission, keyboard, platform, persistence, and alternate-input states. For backend or data work, cover contracts, compatibility or migration strategy, authorization, failure modes, observability, and test seams. For current external claims, record source provenance and freshness. Scale the ceremony to the actual risk.

At each checkpoint, report what is confirmed, what changed, what remains unknown, what durable planning state was updated, and the next question or bounded discovery action.

Do not call a plan ready merely because it contains an activity list. A ready plan must cover the observed current state, dependency-ordered implementation steps with concrete target surfaces, user-visible and failure states, compatibility or migration concerns, security and authority boundaries, acceptance criteria, verification evidence, and every unresolved choice that could materially change implementation.

## Ship a ready plan in both surfaces

A ready plan has two required surfaces: the final response and the durable planning artifact the host names (for example `planning/final-plan.md`). Write the _same_ complete plan to both. A summary, an outline, an excerpt, or a pointer to the artifact is not a handoff: the host and a resuming reader must each be able to work from what is in front of them.

Do that work economically, because a half-finished handoff is a failed one. Inspect and decide once, then write the durable artifact first and emit the same sections in the response from what you already established, without re-deriving, re-verifying, or re-reading what you have already read. Keep each section to the fewest bullets that carry the evidence: readiness is a coverage requirement, not a length requirement, so completeness of the eight sections and of the decision content matters far more than elaboration. Run the readiness validator once.

When the plan is genuinely ready, put these eight sections in both surfaces, each as its own markdown heading at level one to three with the section name alone on the heading line:

- `Decision summary`
- `Current-state evidence`
- `Detailed implementation plan`
- `User journey and failure states`
- `Risks and alternatives`
- `Acceptance criteria`
- `Verification plan`
- `Remaining assumptions`

Carry every confirmed decision into both surfaces verbatim, in the user's own terms, and do not soften, reopen, or contradict it:

- the compatibility target, naming each supported version side by side;
- the rollback boundary, stating both that rollback or downgrade is available _before_ the cutover and that it is unavailable, unsupported, or blocked _after_ the cutover, with forward repair as the recovery path;
- the rollout phases as one ordered sequence, stated once before the step detail, in dependency order, so a reader sees the order without reconstructing it from the steps.

Synchronize the durable plan note to the same state rather than leaving it as a discovery checkpoint: status ready, no open decisions, current-state evidence, dependency-ordered steps that each name a target surface, dependencies, acceptance criteria, verification, and recovery, plus risks, acceptance criteria, verification, and remaining assumptions. Keep the note usable as a handoff, not a transcript.

Run the host readiness validator before declaring readiness and let it decide. Only when it reports ready, end the response with `<!-- KORY_PLAN_READY -->` on its own line, emitted exactly once, and repeat it exactly once at the end of the durable artifact. Never emit that marker in an interim checkpoint, in either surface twice, or while a decision-changing question remains unanswered. The host uses the marker to unlock implementation and Goal handoff actions.

For source-sensitive planning, instruction discovery, and package boundaries, read [references/sources.md](references/sources.md).
