---
name: instructional-communication
description: Teach an executor to complete and verify a bounded task through prerequisites, actions, feedback, decisions, and recovery. Use when writing tutorials, setup guides, runbooks, onboarding, or troubleshooting procedures; not for narrative explanation, lookup reference, executive briefs, accessibility audits, or implementation without instructions.
---

# Instructional Communication

Write for the executor. A procedure is complete only when its intended reader can recognize the start state, act in order, interpret feedback, recover safely, and prove the end state.

## Operating contract

1. Define one primary audience and one task outcome. State the reader's role and likely expertise, the target medium, permissions, inputs, safety constraints, and what is out of scope. If audience, medium, or authority is unknown, label the assumption or ask for the missing boundary instead of writing for an imaginary maintainer.
2. Establish the environment and observable start state before acting. For every version sensitive prerequisite, include an exact read only check, the acceptable output or range, and the branch for a mismatch. “Confirm that it is installed” is not reproducible; if the check was not run in the target environment, label it untested.
3. Choose the form intentionally: tutorial, bounded how to, setup/onboarding, or operational runbook with branches, recovery, and escalation. Keep lookup facts in a linked reference and technical rationale in the appropriate explanatory artifact.
4. Order actions by dependency. Put conditions before actions. Use exact commands, UI labels, files, parameters, locations, and defined placeholders for the scoped environment. Define each placeholder on first use and preserve the target's terminology.
5. Treat each consequential stage as a feedback contract: precondition, action, expected immediate feedback, decision condition, next step, and recovery or escalation. For commands that start a service or process, define the expected liveness signal and treat an unexpected immediate exit or returned shell prompt as failure unless the command is explicitly one shot.
6. Before any copy, reset, migration, replacement, or cleanup action, branch on whether the target already exists and protect state owned by the user by default. State what is preserved, what may change, backup or rollback prerequisites, and the authorization required for destructive action.
7. Put warnings before consequential actions with effects, backup/rollback prerequisites, and safer alternatives. Tie branches to observable conditions, separate recovery from escalation, and preserve data, security, and availability during rollback.
8. Make the procedure operable in its stated medium. Do not make meaning depend on color, position, sound, timing, or pointer only interaction when the target supports another route; provide textual status, exact labels, and an equivalent input or output path. This is instructional accessibility, not a claim of product conformance.
9. End with objective outcome checks tied to the reader's goal. Command success, a generated artifact, a compilation, or a checklist is insufficient when the real task requires liveness, persistence, state visible to the user, or a recovered path.
10. Test commands, paths, version flags, outputs, feedback, failure branches, recovery, and cleanup in the target environment when practical. Record the environment and evidence, and mark simulated, inferred, stale, unavailable, or untested work explicitly.

## Boundaries and routing

Select this skill when the deliverable is an ordered task that a reader must perform and verify. Select it with a domain skill when domain facts or commands determine the procedure. The broader `documents-communication` skill owns shared audience, format, and factual discipline. `technical-communication` owns mechanism and design rationale, `reference-communication` owns lookup oriented fields and versioned facts, and `executive-communication` owns leadership decisions and status. `accessibility-practice` owns accessibility requirements and `accessibility-verification` owns observed conformance or assistive-technology evidence. `incident-response` owns live incident command. Do not absorb those responsibilities because a procedure mentions them.

## Full-task completion contract

Before drafting, map the whole path: reader and goal, source/version boundary, preflight, ordered actions, stage feedback, decision branches, warning, recovery, escalation, and final proof. A useful procedure must carry the reader from the supplied start state to an observable end state, including at least one relevant invalid, interrupted, compatibility, or recovery path. If a dependency or runtime is unavailable, provide the bounded procedure and label the walkthrough unobserved; never convert a plausible happy path into a completed verification.

## Boundaries and failure

`documents-communication` supplies factual/format discipline; technical/reference skills own explanation and lookup facts; `incident-response` owns live incident action. Repository/domain skills establish real commands and runtime behavior. Writing a guide does not authorize changing the target. Resolve version sensitive facts or scope the guide, split materially different environment paths, put privileged/destructive recovery boundaries before the failure path, and never call a procedure complete when success cannot be observed.

Use [the maintained source map](references/sources.md) when refreshing instructional-writing, procedure, or skill-authoring guidance.
