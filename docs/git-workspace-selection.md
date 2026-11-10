# Git revision selection and provider execution locations

## Per-chat Git UI

The compact Git control in the composer is bound to **the active chat ID**, not the selected project. It shows the branch and changed-file count; the panel header shows the short HEAD hash. Ordinary chats use the selected project folder directly; chats created through revision selection keep independent Git refs, indexes, files, and selection state.

Open the panel for **Changes**, **Branches**, **History**, or **PRs**. Changes supports per-file diffs, stage/unstage (including all files), and staged commits with Ctrl/Cmd+Enter. Branches supports switching, creating a branch from the selected revision, and merging a chat-local branch into the current branch. History and PRs open pinned revisions on new chat-local branches.

The footer provides push/pull with ahead/behind counts. **Add remote** explicitly configures this chat's `origin` with an HTTPS or SSH URL; local source paths are not accepted as publication destinations. No source remote is copied automatically. The first push of a new branch sets its upstream. Writes are blocked during active work, concurrent workspace operations, archived sessions, and pending change reviews. Git errors are displayed inline and merge/pull conflicts open the existing recovery UI.

- **This chat's branch:** switch directly, or optionally create a new branch from it.
- **Source-project branch/tag/commit:** import the pinned committed revision into a new branch in this chat. Source changes, refs, and settings are untouched. Source remote-tracking branches reflect the last fetch; no source fetch is performed.
- **Commit:** choose recent history or enter a hexadecimal ID. A new working branch is required; agent work is never silently left detached.
- **GitHub PR:** browse up to 30 open PRs, or load a PR by number (including closed/merged PRs). See title, state/draft, head/base branches, and change counts. Opening the PR fetches its pinned head into a new chat-local branch. It does not merge, push, create a publication remote, or mutate the PR.

The checkout path is available in the header tooltip. Commit details (full message, author/date, hash and bounded diffstat) load only when requested. Escape and outside clicks close the panel; tab navigation supports arrow keys. The UI refreshes on chat changes, completed runs, session updates, focus and manual refresh; stale responses cannot replace another chat's state.

### PR setup and scope

PR support currently targets **GitHub.com**, using the host-owned source project's `origin` to identify the repository. HTTPS and GitHub SSH origins are recognized; arbitrary URLs, embedded credentials and other hosts are not accepted as PR inputs. Install GitHub CLI and run `gh auth login`. Credentials remain owned by the CLI and are not copied into the chat or sent in tool arguments. Network/account failures are shown explicitly. GitLab/Bitbucket PR adapters are not implemented here.

### Safety and agent access

`git_inspect` and `git_switch` are manager-only first-party tools, also exposed as `kory__git_inspect` and `kory__git_switch` through the authenticated MCP bridge. They use the caller's host-bound session, never a model-supplied session/path. Inspection is read-only; switching follows the normal risky-tool approval policy and is unavailable in the Plan interaction mode. Workers/critics cannot switch the manager's checkout.

Both UI and tool switching reject dirty/unreadable status, unfinished Git operations, stale current HEAD/branch, moved target refs, pending change reviews, active workers and agent background terminals. UI switching additionally requires an idle chat. A manager can intentionally switch during its own turn, but the exclusive tool lease refuses overlapping managed tool executions. The existing mandatory OS sandbox confines Git and helpers to the owned chat checkout.

No force/reset/clean or automatic stash is used. Ignored-file collisions are protected, and a project subdirectory must exist in the target revision. External editors/manual processes do not honor Kory's lifecycle locks; post-switch verification detects changed Git state but does not claim universal filesystem quiescence.

The creation origin in `gitWorkspace.branch/baseCommit` is retained. The latest explicit target/PR is persisted separately as `gitWorkspace.selection`; live Git determines the displayed current branch and HEAD. If metadata persistence conflicts after Git switched, the error says so and requires refresh rather than rolling back/discarding work.

### API

All `/api/git/chat*` endpoints require authentication and a nonempty **`X-Koryphaios-Session`**. Missing/unknown/archived chats never fall back to `X-Koryphaios-Project`.

- `GET /api/git/chat`: actual chat state, available chat/source refs and recent commits, current selection.
- `GET /api/git/chat/commit?ref=...&source=true|false`: on-demand commit details.
- `GET /api/git/chat/pull-requests`: open GitHub PRs.
- `GET /api/git/chat/pull-requests/:number`: full PR details.
- `POST /api/git/chat/switch`: `{ expectedHead, expectedBranch, target }`.
  - Branch/commit target: `{ kind: "branch" | "commit", ref, source?, branch?, expectedHash? }`.
  - PR target: `{ kind: "pull-request", number, branch, expectedHash? }`.
  - `expectedHash` is the selected object ID (tag object ID for annotated tags; head SHA for PRs). New branch names must not already exist in the chat. Moved/stale selections return HTTP 409.

The legacy `/api/git/checkout` also requires a chat and uses the guarded switch service. The older project-scoped `/api/git/selection` and `POST /api/sessions` with `git: { ref, branch, expectedHash? }` remain available for explicit initial-chat creation; the active-chat control no longer uses them.

## Provider mode visibility

Backend provider status includes `execution: { modes, defaultMode }`. The shared contract is in `shared/src/provider-execution.ts`; the reusable themed control is `ProviderExecutionModes.svelte`.

**Execution location means where workspace tools run, not where model inference runs.** For example, calling an OpenAI API model does not make Kory's local filesystem tools a cloud agent.

- Single-mode adapters: no execution-mode dropdown.
- Multiple declared modes: display the selector using `KorySelect`; unavailable modes carry a reason.
- Missing capabilities: hide the selector instead of guessing.
- No wired selection handler: the control is read-only/disabled, never a cosmetic toggle that silently fails to route work.

Today, the integrated CLI adapters are local-only. Hoplite describes both local and cloud execution, but its delegation adapter is deliberately unavailable, so Settings displays a **disabled** dual-mode control with an explanation. This change does **not** enable cloud delegation, persist a runnable cloud choice, or bypass the provider's approval requirements.

Before enabling dual-mode execution for an adapter, implement the real execution route, approval flow, session-scoped mode persistence and backend validation, cancellation/status tracking, and result import. Then wire the selector's value/change handler to that authority and mark only implemented modes available.
