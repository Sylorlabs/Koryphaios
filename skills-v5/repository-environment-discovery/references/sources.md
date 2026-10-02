# Repository discovery sources

Read this file when changing repository-identification, worktree-preservation, or instruction-discovery behavior. These references describe evidence semantics; they do not authorize commands or mutations.

## Git working-tree status

- Source: https://git-scm.com/docs/git-status
- Verified: 2026-09-01
- Relevant contract: status distinguishes changes between `HEAD` and the index, changes between the index and working tree, and untracked paths. Repository discovery must preserve those pre-existing states rather than treating a dirty tree as disposable.

## Git repository identity

- Source: https://git-scm.com/docs/git-rev-parse
- Verified: 2026-09-01
- Relevant contract: repository/worktree-aware operations can resolve the top-level path and related repository identity. Do not infer the intended checkout from a parent directory or filename.

## OpenAI Codex AGENTS.md discovery

- Source: https://developers.openai.com/codex/guides/agents-md/
- Verified: 2026-09-01
- Relevant contract: Codex constructs an instruction chain, including global and project-scoped `AGENTS.md`/override guidance with defined precedence. Discovery should identify the instructions applicable to the actual files in scope before edits.

## AGENTS.md convention

- Source: https://agents.md/
- Verified: 2026-09-01
- Relevant pattern: repositories can provide agent-specific project context and instructions near the code they govern.

Runtime/toolchain details are deliberately not hardcoded here. Detect versions and supported commands from the actual project because package managers, frameworks, and CI conventions vary by repository and drift independently.
