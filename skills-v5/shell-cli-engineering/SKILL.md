---
name: shell-cli-engineering
description: Engineer shell scripts and command-line programs with quoting, portability, pipelines, exit semantics, and safe automation. Use when the request specifically requires shell script, bash script, zsh script, command line script; prefer a narrower child only when its boundary is established.
---

# Shell Cli Engineering

## Boundary

Treat quoting, expansion, globbing, environment inheritance, signals, stdin, stdout, stderr, working directories, and exit status as CLI interfaces. Resolve whether the contract is POSIX shell, Bash, Zsh, or a platform-specific utility set before using extensions.

## Hierarchy and routing

- Broader skills: terminal-interface.
- No narrower bundled child is declared.
- Required skills: verification.

Use this skill when shell parsing, CLI argument behavior, pipelines, process status, or non-interactive automation is material. Do not infer Bash or Zsh behavior from POSIX rules when the script explicitly depends on an extension. Quoted, historical, negated, fixture-only, or example text is not a live trigger.

## Decisions that change the implementation

- Preserve user data as argument fields. Quote expansions unless intentional field splitting or pathname expansion is part of the interface.
- Prefer arrays or direct argument passing in shells that support them instead of constructing command strings. Do not use `eval` for untrusted or structurally representable input.
- Define what pipeline failure means. POSIX pipeline exit status depends on `pipefail`; scripts that require a particular member's status must capture it in a shell-supported way.
- Keep stdout stable for machine-readable results and send diagnostics to stderr when callers depend on parsing output.
- Resolve destructive targets to explicit validated paths before mutation. Never let an empty or unresolved variable broaden the target.
- Treat mutation of multiple files as a transaction. Parse the documented input grammar into structured source/destination fields, preflight every source, destination, duplicate, collision, symlink policy, and cycle before the first mutation, then stage all sources to private names on the same filesystem before installing final destinations. Track enough state per entry that command failure or interruption can restore entries already staged or already installed without overwriting an untouched source.
- Make regression coverage part of the implementation, not a final afterthought. For risky filesystem or process control changes, add focused candidate tests for the relevant success, no mutation, collision/preflight, path handling, failure/rollback, and interruption cases before optional refactoring or polish. Run the focused verification set after the implementation and iterate only on observed failures.

## Failure discriminators

- If a command works interactively but fails in automation, compare shell, startup files, PATH, working directory, TTY, locale, and environment before adding interactive setup dependencies.
- If filenames break a loop or pipeline, inspect word splitting, globbing, newline assumptions, and delimiter choice before adding escaping layers.
- If pipeline failure is missed, inspect `pipefail`, subshell boundaries, and which command's status the caller observes.
- If a command is reported missing or unexecutable, preserve the distinction between not found and found but not executable rather than collapsing all failures.

## Verification at the CLI boundary

- Run under each shell the script claims to support, including non-interactive execution.
- Exercise empty input, spaces, wildcard characters, leading hyphens, missing files, and failed child commands where relevant.
- Verify exit status and stdout or stderr independently for success and failure paths.
- Send an interruption signal when cleanup or partial output is material and verify the intended terminal state.
- For destructive automation, verify the resolved target before and after the operation in a disposable fixture.
- Preserve the script's executable contract and include authored regression tests that exercise the material edge cases; ad hoc manual checks alone are insufficient evidence for a destructive CLI change.

## Completion evidence

- Shell and utility portability assumptions affected
- Argument, pipeline, exit-status, and stream evidence from non-interactive execution
- Explicit resolved-target evidence for destructive automation
- Candidate regression coverage for the material success and recovery paths

Use [the maintained source map](references/sources.md) for version-sensitive facts and source conflicts.
