---
name: plan-mode
description: Run Koryphaios's explicit read-only Plan mode as a discovery and decision-making engagement that produces a durable implementation-ready plan. Use when the user explicitly invokes Plan mode or the host pins the Plan permission mode; ordinary requests to make a plan belong to normal planning guidance.
---

# Plan-mode operating contract

Plan before implementation. Treat the current request as a discovery and decision-making engagement: establish what the user wants to achieve, what success means, what must not change, who is affected, and what authority is available.

While Plan mode is active, do not modify project files, execute write-capable shell commands, commit, create pull requests, or delegate implementation. Read, search, inspect, research, ask questions, and maintain planning artifacts instead. This skill is guidance inside a host-enforced mode; it does not grant or remove tool authority by itself.

Start with a concise restatement of the outcome and a small evidence-backed initial map. Inspect applicable repository guidance, current workspace state, relevant code paths, tests, settings, and runtime boundaries before proposing a solution. Separate observed facts from assumptions, hypotheses, user preferences, and unresolved questions. Never turn a guessed requirement into a plan constraint without labeling it.

## Ask useful questions early and throughout

Ask questions when an answer can materially change scope, user experience, compatibility, ownership, safety, rollout, success criteria, or the chosen implementation path. Prefer a small focused batch over a vague request for more information. Explain why the answer matters and, when useful, include a recommended default and its trade-off.

Do not ask the user for facts that can be verified cheaply from the workspace, supplied material, or authoritative sources. Do not block low-risk discovery on a reversible preference. When a decision is reversible, state the assumption, its impact, and the trigger for revisiting it. When it is not reversible or changes authority, stop planning past that decision until the user resolves it.

## Maintain a durable planning record

Use the host's plan note as the living record for substantial planning work. Keep the request, confirmed context, open questions, decisions, alternatives, risks, milestones, and verification evidence current enough that another agent or human can resume without reconstructing the conversation.

Consult existing durable context before asking a question that may already be answered. Treat memory as fallible context rather than current truth and verify drift-prone details. Do not store secrets, transient speculation, raw private content, or a transcript merely because a note is available.

## Produce an executable decision record

Keep the plan dependency ordered and concrete. For each material step, identify the target surface, intended change, reason, dependencies, failure behavior, acceptance criteria, verification method, and rollback or recovery path where relevant. Record consequential alternatives and the evidence that would change the decision.

For UI or workflow work, cover the user journey and meaningful empty, loading, error, permission, keyboard, platform, persistence, and alternate-input states. For backend or data work, cover contracts, compatibility or migration strategy, authorization, failure modes, observability, and test seams. For current external claims, record source provenance and freshness. Scale the ceremony to the actual risk.

At each checkpoint, report what is confirmed, what changed, what remains unknown, what durable planning state was updated, and the next question or bounded discovery action.

Do not call a plan ready merely because it contains an activity list. A ready plan must cover the observed current state, dependency-ordered implementation steps with concrete target surfaces, user-visible and failure states, compatibility or migration concerns, security and authority boundaries, acceptance criteria, verification evidence, and every unresolved choice that could materially change implementation.

When the plan is genuinely ready, present these sections:

- Decision summary
- Current-state evidence
- Detailed implementation plan
- User journey and failure states
- Risks and alternatives
- Acceptance criteria
- Verification plan
- Remaining assumptions

End a ready plan with `<!-- KORY_PLAN_READY -->` on its own line. Never emit that marker in an interim checkpoint or while a decision-changing question remains unanswered. The host uses the marker to unlock implementation and Goal handoff actions.

For source-sensitive planning, instruction-discovery, and package boundaries, read [references/sources.md](references/sources.md).
