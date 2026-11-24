# Chat forks

A fork is a new chat that starts from a finished point of another chat's history.
The source chat is never changed by forking. Its result can be merged back later.

## Fork points

- Any finished message can be a fork point: completed turns, failed turns (a user
  message whose reply was never persisted), interrupted turns and cancelled turns.
- A message that belongs to a turn still running is refused (`409`). Its reply is
  not durable yet, so the copy would be incomplete.
- Without a message, the fork takes the source's latest finished point. If a turn is
  running, the fork steps back past that turn.
- A chat with no finished message cannot be forked (`400`).

## What is copied

- The lineage from the root down to the fork point. Copied rows get fresh ids and
  zero tokens and cost, so spend is not counted twice.
- Content verbatim. Persisted `parts` (the ordered transcript) and inline attachments,
  including images, are part of the stored content, so a reload renders the same.
- Variant siblings of copied responses, so the alternatives stay available.
- Compaction checkpoints, with their ids remapped.
- Client feed errors at or before the fork point, and message hide markers.
- Working folder, interaction mode (plan/act) and agent overrides.

## What is not copied

- The source's isolated Git workspace. Its lifecycle belongs to the source.
- The Plan note.
- Provider-native conversation state. See the table below.
- In-flight turn ledger rows, and tombstones for event targets (sequence based).

## Lineage

Stored on the `sessions` row (migration `0060`) and exposed on the shared `Session`:

| Field | Meaning |
| --- | --- |
| `forkedFromSessionId` | Source chat id. |
| `forkedFromMessageId` | The source message the fork ends at (source id). |
| `forkedAt` | Epoch ms when the fork was created. |
| `forkMergedAt` | Epoch ms when the fork was merged back. Absent until then. |

`parentSessionId` is also set to the source, as before. Internally the fork's own copy
of its fork point is kept as the merge base (`forked_base_message_id`); it is not part
of the public contract.

## Provider-native continuity

A fork never resumes or writes a parent's native CLI session. Fork state is keyed by the
new session id, and the fork starts with `providerConversationRevision` 0.

| Provider | Native resume today | Fork behaviour | Native fork flag used |
| --- | --- | --- | --- |
| Claude Code (`claude-code.ts`) | None: `resume: false`, no session id stored. Every turn rebuilds the prompt from Kory's history. | Starts fresh and replays Kory's transcript. | None. There is no `--resume`, so `--fork-session` is not used. |
| Codex (`codex-cli.ts`) | None: `codex exec --ephemeral` each turn, no thread id captured. | Starts fresh and replays. | None. |
| OpenCode (`opencode-cli.ts`) | None: a new ACP session per turn, id never stored. | Starts fresh and replays. | None. `session/fork` is not used. |
| Antigravity (`antigravity.ts`) | Yes: `--conversation <id>` kept in an in-process map keyed by `sessionId` and role, gated by `providerConversationRevision` and a context fingerprint. | The fork's new id has no entry, so the first fork turn creates a new agy conversation. The source's conversation is never resumed or extended. | None. |
| Jules (`jules-runner.ts`) | Remote session id stored in the chat's `metadata.jules`. | Not copied (the fork's metadata allowlist excludes it). The fork gets a new Jules session. | None. |
| Devin, Freebuff, Codebuff, others | Own per-turn sessions or no resume; no native id reused across chats. | Starts fresh and replays. | None. |

If a provider later declares native resume, its resume handle must not be copied into a
fork, and any native fork flag it offers must be used rather than resuming the parent.
Update this table when `lifecycle` changes.

## Merge back

`POST /api/sessions/:id/merge-fork` (`:id` is the fork) appends one host-authored entry
to the source chat, then marks the fork merged. A fork merges once.

- `summary`: a deterministic digest of the fork's new work: its first request and last
  reply, plus a count. No model call is made.
- `messages`: the fork's new messages, newest first within a 12k-character budget.
  Each message is clipped to 2k characters, and omitted earlier messages are noted.

"New" means the messages after the fork's base. The entry is a `system` message that
begins with `[KORY_FORK_MERGE]`. It is not a user turn and starts no provider run. Its id
is `forkmerge-<forkId>` and it is written with the idempotent message write path, so a
retry after a crash finds the same row.

Both chats' mutation barriers are held for the write. A source with a running turn is
refused (`409`).

## Events

- `session.updated` (lifecycle, not session-bound): the new fork, and both chats after a merge.
- `session.forked` (session-bound, `sessionId` = source): a fork was created.
- `session.merged` (session-bound, `sessionId` = source): a merge landed. Clients should
  reload the source history to show the entry.

## Agent tool

`fork_chat { sessionId?, messageId?, title? }` (manager only, also `kory__fork_chat` on the
MCP bridge). It returns the new session id. It is an interaction tool, like `rename_session`,
so it is allowed in every permission mode. It does not change the workspace.
