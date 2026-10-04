---
name: repository-environment-discovery
description: Inspect repository state, governing instructions, ownership, runtime, and verification before code mutations. Use when coding needs local evidence about the checkout or stack.
---

# Repository and environment discovery

Before any mutation, establish the exact repository/worktree and the scope that governs the requested files. Resolve applicable repository/agent instructions in precedence order, then inspect staged, unstaged, and untracked state so pre-existing user work is distinguishable from task changes. A dirty tree is evidence to preserve, not permission to reset or clean it.

Map only enough of the repository to locate ownership: entry points, call/consumer paths, state and configuration boundaries, nearby tests/fixtures, generated-vs-source files, and existing implementation patterns. Use repository evidence such as manifests, lockfiles, toolchain files, CI configuration, scripts, and actual file types to identify runtime/framework/version and supported verification commands. Do not infer stack, medium, provider, or topology merely from vocabulary in the prompt.

Check whether the task spans multiple packages/workspaces or instruction scopes before editing shared code. Identify files that appear generated, vendored, migrated, or externally synchronized so the source of truth is clear. Keep unresolved repository identity, runtime version, command, or ownership facts explicit rather than filling them with defaults.

Discovery is read-only and does not authorize installs, global configuration, service startup, credential access, cleanup/migration, or destructive Git. Keep unresolved identity/runtime facts explicit.

Stop discovery when the task owner, governing instructions, relevant existing patterns, preservation boundary, and proportional verification path are known. More repository reading is not automatically better context.

Before mutation, record a compact discovery result: exact target repository/worktree, applicable instruction chain, owning path and existing pattern, detected toolkit/framework and version, representative verification command, and any unresolved identity or runtime fact. When similarly named or sibling checkouts exist, record the selected checkout and the fact that the sibling was left untouched.

When the task or evaluation requires proof that discovery preceded mutation, retain a minimal chronology from the real tool observations: for example, the pre-edit worktree status plus the instruction/runtime inspection that informed the first edit. Do not infer that ordering from the final repository state. Likewise, preserving unrelated dirty files proves preservation, but does not by itself prove that no reset, clean, checkout, or equivalent destructive operation ran; make that stronger claim only when the available command or tool trace supports it.

Keep that record machine-readable and unambiguous: prefer scalar fields such as `repositoryRoot`, `governingInstructions`, `owningPath`, `runtimeToolchain`, `focusedVerificationCommand`, and `regressionBounded`, with separate name and version fields for the toolkit and UI/runtime. Store the report in the task-designated evidence location while keeping source mutations inside the requested checkout.

For Git/instruction semantics, read [references/sources.md](references/sources.md).
