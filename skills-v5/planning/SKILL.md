---
name: planning
description: Create bounded, acceptance-driven implementation plans. Use when the request specifically requires planning, plan and implement a feature; prefer a narrower child only when its boundary is established.
---

# Planning

## Responsibility

Translate the task contract into coherent dependency-ordered work with explicit acceptance criteria, risks, and verification.

## Hierarchy and routing

- This is a graph root for its responsibility.
- Narrower children: architecture-planning, business-case-analysis, migration-planning, product-management, project-program-management, release-planning, startup-operations.

## Turn outcomes into decisions

Establish the desired outcome, affected people, current state, constraints, authority, and observable acceptance criteria. Separate confirmed facts from preferences, assumptions, risks, and open choices. Inspect the relevant workspace or source evidence before naming an implementation surface. Do not promote a tentative stack or architecture into a requirement.

Choose a narrower planning child when its boundary is established. Keep the next work concrete and dependency ordered: target surface, owner, input, intended result, and the check that determines whether to advance. Plan distant work at a coarser level when discovery can change it. An activity list or date alone is not a falsifiable milestone.

Expose the highest-consequence uncertainty and a bounded way to resolve it. Prefer a representative, authorized probe before an expensive commitment. Record consequential alternatives, why one is preferred, and what evidence would reopen that choice. Identify compatibility, affected consumers, and rollback or forward recovery before an irreversible step.

Reconcile the plan when evidence, dependencies, or authority change. Mark estimates that depend on unresolved discovery instead of disguising them as commitments. A request for a plan does not authorize executing it; proposed acceptance tests are not completed verification. Explicit host Plan mode has its own `plan-mode` contract and must not be inferred from every use of the word planning.

## Completion evidence

- Current-state evidence, decision rationale, and unresolved assumptions
- Dependency-ordered work with observable acceptance and recovery boundaries
- Proposed verification separated from checks actually performed during discovery

Use [the maintained source map](references/sources.md) for version-sensitive facts and source conflicts.
