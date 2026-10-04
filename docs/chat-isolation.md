# Chat workspace isolation

Every project-backed chat gets a durable **independent Git repository**, including chats created without the revision picker. This is deliberately stronger than a linked Git worktree: linked worktrees share stashes, refs, tags, remotes and configuration.

## Source project versus execution checkout

- `Session.workingDirectory` remains the source project identity for grouping, navigation and project settings.
- `Session.gitWorkspace.path` is the execution directory. A selected project subdirectory remains the corresponding subdirectory of the new checkout.
- Independent repositories live under `~/.koryphaios/chat-repositories/<id>/checkout`. Ownership/settings metadata is stored outside the agent-writable checkout.
- Git-backed chats start at the selected commit, or committed `HEAD` for ordinary new chats. Uncommitted source edits and untracked/ignored source files are **not** transferred. The original index and working directory are untouched.
- Non-Git and unborn projects receive an independent initial snapshot. Git is initialized in the copy, not the source. `node_modules`, `.git`, `.trees`, `.koryphaios`, `.env*`, and common credential directories/files are excluded from that snapshot.
- Chats without a selected project receive an empty private repository on first execution, rather than copying the backend's data directory.
- Dependencies and environment files are not symlinked back to the source. Install dependencies in the isolated checkout as needed.
- Source remotes are not carried into the copy. Publishing/merging back is an explicit human action; there is no automatic cross-chat merge or writeback to the source repository.

The Git panel, file mentions, chat-relative images, native tool bridge, checkpoints and worker recovery APIs resolve the active session checkout. The new-chat revision picker intentionally reads the source project. Project policy/preferences remain source-owned, not controlled by a copied `koryphaios.json`.

Clean legacy sessions are migrated on first execution, preserving the original directory and source settings identity. Migration **refuses dirty or unreadable Git checkouts** rather than making unfinished work disappear from the chat; commit/recover that work first, or start a new isolated chat. Historical keep/reject decisions remain bound to their recorded original checkout and cannot silently roll back a new repository. A missing or redirected isolated checkout fails closed rather than falling back to the source.

## Write enforcement

Owned-chat tool calls have a mandatory write boundary independent of approval mode and optional sandbox preferences. YOLO, `workspace.sandbox: off`, and disabled path toggles do not authorize writing into another chat/source checkout.

- File-mutating tools validate canonical paths, including symlinked parents of newly created files. Actual mutations run in a kernel-confined helper, so a symlink swap during UI streaming cannot turn the later backend write into an outside-workspace write.
- Shell tools use macOS Seatbelt or Linux bubblewrap with a fixed host-selected root and private scratch directory. Changing shell cwd, using `git -C`, setting `GIT_DIR`, or invoking a script does not expand that grant.
- Backend Git operations also run inside the chat's write boundary; an agent-controlled Git hook, filter or fsmonitor helper does not inherit unrestricted backend filesystem access.
- Missing/disabled kernel enforcement refuses confined mutations, shell execution and backend Git operations. Windows currently has no supported kernel engine for these calls.
- CLI bridge grants bind the host-selected chat/worker directory; the bridge does not trust a client-supplied working directory.
- Supported outer-jailed CLI turns require confinement. Codex, Codex Auth and Devin native turns currently refuse isolated-chat execution because their native execution paths do not yet meet this boundary. API providers remain available. Native slash-command adapters also refuse execution until they support the boundary.
- Sandboxed background shell execution remains unsupported and is refused, rather than spawning outside confinement.

This is **write isolation**, not a promise that all host files are unreadable: macOS runtime sandboxes permit broad reads. It also does not isolate external services or prevent ordinary merge conflicts when a human later combines independently developed changes. Explicit human/manual processes remain privileged actions, not agent tool grants.

## Workers and recovery

Delegated workers still use temporary worktrees, now within their parent chat's independent repository. Worker file/shell grants remain narrower than the chat checkout; shell Git operations needing writes to the parent's shared Git directory are denied. Host-owned reconciliation commits and merges the worker's result into that chat only. Another chat has a different Git common directory.

Chat repositories are preserved across shutdown and session deletion for manual recovery; they are not disposable worker worktrees. Remove them only after saving/publishing their work.

If a worker's recovery commit fails at shutdown, its dirty checkout and manifest entry are retained. A later resolution retries the recovery commit before removing the checkout or merging its branch. If that retry fails, no working files are removed.
