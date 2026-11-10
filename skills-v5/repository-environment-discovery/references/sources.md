# Repository discovery sources

Read this file when changing repository-identification, worktree-preservation, or instruction discovery behavior. These references describe evidence semantics; they do not authorize commands or mutations.

## Git working-tree status

- Source: https://git-scm.com/docs/git-status
- Verified: 2026-09-01
- Relevant contract: status distinguishes changes between `HEAD` and the index, changes between the index and working tree, and untracked paths. Repository discovery must preserve those pre-existing states rather than treating a dirty tree as disposable.

## Git repository identity

- Source: https://git-scm.com/docs/git-rev-parse
- Verified: 2026-09-01
- Relevant contract: repository/worktree-aware operations can resolve the top-level path and related repository identity. Do not infer the intended checkout from a parent directory or filename.

## OpenAI Codex AGENTS.md discovery

- Source: https://developers.openai.com/codex/agent-configuration/agents-md (redirects to https://learn.chatgpt.com/docs/agent-configuration/agents-md)
- Verified: 2026-10-02 by retrieving the current documentation.
- Relevant contract: Codex builds its instruction chain once per run/session. Global override guidance takes precedence over the global default; project discovery walks from the project root to the current directory, selecting at most one nonempty override/default/fallback file per directory. Deeper guidance appears later. The default combined limit is 32 KiB. Discovery should identify applicable instructions and truncation before edits; these are Codex semantics, not an automatic claim about every client.

## AGENTS.md convention

- Source: https://agents.md/
- Verified: 2026-09-01
- Relevant pattern: repositories can provide agent-specific project context and instructions near the code they govern.

Runtime/toolchain details are deliberately not hardcoded here. Detect versions and supported commands from the actual project because package managers, frameworks, and CI conventions vary by repository and drift independently.
