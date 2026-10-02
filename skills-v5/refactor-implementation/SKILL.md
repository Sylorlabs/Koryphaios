---
name: refactor-implementation
description: Improve internal structure while preserving defined external behavior. Use when the request specifically requires refactor, restructure, extract abstraction, remove duplication; prefer a narrower child only when its boundary is established.
---

# Refactor Implementation

## Responsibility

Define invariants and compatibility first, add characterization evidence where behavior is uncertain, move in reviewable steps, reduce rather than relocate complexity, and remove obsolete paths without mixing unrelated features.

## Hierarchy and routing

- Broader skills: implementation.
- No narrower bundled child is declared.
- Required skills: verification.

## Professional practice

Define external behavior and compatibility invariants before editing. Characterize uncertain behavior, then move in reviewable steps that reduce complexity rather than relocate it. Preserve public contracts unless change is authorized; remove obsolete paths and prove no duplicate authority remains. Evidence: characterization checks, structural improvement, invariant results, and focused diff review. Reject simultaneous unrelated features, abstraction for its own sake, and success claims based only on compilation. Method: trace one representative request or event across every changed boundary before editing, then implement in dependency order and keep the system runnable after each coherent increment. Inspect callers and consumers whenever a contract changes. Exercise success, boundary, denied, interrupted, and recovery paths in the closest supported environment. Preserve exact diffs and test output, and explain any generated or migrated state. Stop and reassess when the change requires duplicate sources of truth, bypasses an owning abstraction, broadens permissions, or cannot be verified independently. Completion requires observable behavior plus cleanup of superseded paths; compilation, mocks, scaffolding, and code appearance alone are insufficient evidence.

## Completion evidence

- Behavior invariants
- Characterization checks
- Hierarchy boundary and selected specialist rationale
- Representative success, negative-path, and recovery verification
- Preserve contradictory or missing evidence explicitly.
- Verify the highest-value invalid, partial, compatibility, interruption, or recovery path for the actual environment.
- Do not claim success from compilation, a screenshot, a happy-path example, or source documentation alone when runtime or operational evidence is required.

Use [the maintained source map](references/sources.md) for version-sensitive facts and source conflicts.
