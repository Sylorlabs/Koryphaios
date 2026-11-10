# Universal source control and workspace stack

Status: Milestone 2 neutral roots, repositories, and adapter contracts

## Product contract

A project is a collection of explicit roots. Git is one source-control
strategy, not the project model. A task selects which roots are read-write,
read-only, excluded, generated, dependent, or publishable. The selected scope
becomes part of authorization, sandbox mounts, context discovery, diffs,
checkpoints, recovery, and publication evidence.

## Current scope layers

The code already has three meaningful scopes, but they are mostly represented
by paths:

1. **Project/source root** — resolved by `request-project.ts` and used by
   project-scoped revision selection.
2. **Persistent chat checkout** — represented by `Session.gitWorkspace` and
   owned by `session-workspace.ts`.
3. **Disposable worker worktree** — created and reconciled by
   `WorkspaceManager` for parallel agent work.

These scopes must remain distinct. A persistent chat repository is not a worker
worktree, and a selected subdirectory is not always the Git repository root.

## Current inventory

| Concern                  | Current authority                                  | Migration note                                        |
| ------------------------ | -------------------------------------------------- | ----------------------------------------------------- |
| Project path             | `getRequestProjectRoot()`                          | Canonicalize and wrap as `ProjectRoot`                |
| Effective task directory | `getRequestWorkspaceRoot()` and session resolution | Wrap as `TaskScope`; never accept model paths         |
| Chat revision checkout   | `GitWorkspace`, `ChatGit`, `Session.gitWorkspace`  | Preserve compare-and-swap and ownership checks        |
| Panel Git operations     | `GitManager` and `routes/v1/git.ts`                | Compatibility adapter for first facade                |
| Worker isolation         | `WorkspaceManager`                                 | Keep lifecycle, recovery, and validation intact       |
| Raw Git execution        | `GitExecutor`                                      | Remain the only subprocess/mutex boundary             |
| Git route generations    | `routes/v1/git.ts` and `server/handlers/git.ts`    | Make v1 service authority, then thin-adapt old routes |
| Checkpoints              | Git shadow repositories and worker recovery        | Add neutral root-level result model later             |

## Transitional backend types

The first seam should be backend-internal:

```ts
interface ProjectRoot {
  path: string;
  identity: string;
}

interface TaskScope {
  sessionId: string;
  project: ProjectRoot;
  workingDirectory: string;
  taskId?: string;
}
```

`ProjectRoot.path` is the canonical user-selected source directory. The
`workingDirectory` can instead be an owned chat checkout or worker worktree.
The scope must be constructed by trusted host code after session and ownership
validation.

## Transitional service facade

Introduce a thin `SourceControlService` that delegates to existing strategies:

- inspect/create project revisions through `GitWorkspace`;
- chat operations through `ChatGit`;
- panel operations through the existing owned-checkout redirect and
  `GitManager`;
- worker isolation through `WorkspaceManager`.

Do not expose raw Git commands or replace the current implementations in the
first phase. The facade exists to centralize scope-to-strategy selection while
the behavior remains characterized by existing tests.

## Neutral future model

The implementation now defines and persists `ProjectId`, `RootId`,
`RepositoryId`, `TaskWorkspaceId`, `RevisionId`, `SnapshotId`, and `ChangeId`
conceptually through shared contracts and the `project_roots` /
`source_control_repositories` tables. The selected root allocation is explicit;
Git fields remain compatibility projections until all callers migrate.

Existing Git fields such as
`workingDirectory`, `gitWorkspace.path`, `branch`, `baseCommit`, and
`repositoryPath` become compatibility projections. A source-control adapter
should own detect, inspect, status, diff, workspace creation, snapshot,
restore, reconcile, fetch, update, and publish for its root allocation.

Forge/review adapters remain separate from local source-control adapters.
Normalized `ChangeRequest`, `Review`, and `Publication` types must support
pull requests, merge requests, patchsets, shelved changelists, local patches,
archives, and coordinated multi-root publication.

## Safety invariants

- explicit task roots are narrower than the containing project directory;
- read-only roots cannot be mutated by tools or publication;
- canonical containment uses the backend platform module and existing ownership
  checks;
- persistent and disposable workspace lifecycles never share cleanup code by
  accident;
- stale revisions fail compare-and-swap rather than silently overwriting;
- partial checkpoints and publications report root-level outcomes honestly;
- locks move from one global Git mutex toward host → repository → checkout →
  task-operation keys without weakening the current executor boundary.
