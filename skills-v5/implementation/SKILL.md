---
name: implementation
description: Implement a concrete code change in an existing repository when the requested behavior and system boundary are already understood. Use when direct code mutation is requested; specialized feature, refactor, or integration skills may compose beneath this implementation discipline.
---

# Implementation

Turn an already-understood change request into the smallest coherent repository change that satisfies the stated acceptance criteria.

## Work from the repository contract

- Inspect the relevant call path, types, tests, local instructions, and existing conventions before editing.
- Reuse established abstractions and integration points. Do not create a parallel architecture merely because it is locally convenient.
- Keep the patch conceptually focused. Include every coupled change required for correctness, but separate unrelated cleanup or refactoring.
- Preserve user-owned and unrelated work in a dirty worktree.

## Make the change complete

Trace the requested behavior through the surfaces it actually affects: inputs, state, outputs, errors, persistence, configuration, and tests. A small implementation is still incomplete if one required contract is left inconsistent.

When the request exposes a material failure or recovery path, handle it inside the existing design rather than adding speculative machinery. Do not invent compatibility promises that the repository does not make.

## Verify observable behavior

Run the narrowest meaningful checks that exercise the changed contract, then broaden verification when the impact justifies it. Report the actual diff and observed checks; do not substitute code inspection for runtime evidence when behavior can be exercised.

## Routing boundary

Use a more specific implementation skill alongside this parent discipline when it owns the task:

- `feature-implementation` for a new end-to-end capability or user-visible behavior.
- `refactor-implementation` when preserving behavior while restructuring internals is the primary goal.
- `integration-implementation` when the core work is connecting components or an external provider across a contract boundary.
- `debugging` when the task begins with an unexplained failure whose root cause must first be established.

This skill can compose with a specialized implementation child or a domain skill such as frontend, backend, or language engineering; it owns disciplined execution of the concrete change, not the child/domain-specific rules. Do not select it for explanation-only, planning-only, or research-only requests with no code mutation.

Use [the maintained source map](references/sources.md) for the evidence behind the small-coherent-change and verification guidance.
