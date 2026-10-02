---
name: instructional-communication
description: Teach a reader to complete and verify a task through prerequisites, actions, feedback, and recovery. Use when writing tutorials, setup guides, runbooks, onboarding, or troubleshooting procedures; not for narrative explanation, lookup reference, executive briefs, or implementation without an instructional artifact.
---

# Instructional Communication

Write for the executor. A procedure is complete only when they can recognize the start state, act in order, detect failure, recover safely, and prove the end state.

## Operating contract

1. Define reader, goal, environment/version, prerequisites, permissions, inputs, safety constraints, and observable start state; say how prerequisites are checked.
2. Choose the form intentionally: tutorial, bounded how-to, setup/onboarding, or operational runbook with branches/recovery/escalation.
3. Order actions by dependency. Put conditions before actions. Use exact commands, UI labels, files, parameters, locations, and defined placeholders for the scoped environment.
4. After meaningful stages, state observable feedback so readers do not proceed blindly after failure.
5. Put warnings before consequential actions with effects, backup/rollback prerequisites, and safer alternatives. Do not reveal irreversible consequences after the command.
6. Tie branches to observable conditions; separate recovery from escalation and preserve data, security, and availability on rollback.
7. End with objective outcome checks; command success alone is insufficient.
8. Test commands, paths, version flags, outputs, failure branches, and cleanup in the target environment when practical. Mark anything untested.

## Boundaries and failure

`documents-communication` supplies factual/format discipline; technical/reference skills own explanation and lookup facts; `incident-response` owns live incident action. Repository/domain skills establish real commands and runtime behavior. Writing a guide does not authorize changing the target. Resolve version-sensitive facts or scope the guide, split materially different environment paths, put privileged/destructive recovery boundaries before the failure path, and never call a procedure complete when success cannot be observed.

Use [the maintained source map](references/sources.md) when refreshing instructional-writing, procedure, or skill-authoring guidance.
