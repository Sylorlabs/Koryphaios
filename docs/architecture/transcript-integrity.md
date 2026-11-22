# Transcript integrity

This document is the contract for how a chat transcript is built, saved and
reloaded. Two classes of bug kept coming back and both are structural:

- **Reasoning out of order / missing after reload.** The live view and the
  reload view were built by different code from different data. Only the last
  provider call's reasoning was persisted, as one joined string placed before
  the text, and the reload path re-attached live rows to persisted rows by
  matching normalized text.
- **One chat's rows appearing in another.** Session identity was optional on
  realtime messages and on store mutations, and many writers defaulted to "the
  chat that is open now".

The invariants below remove the mechanism, not the instances.

## Invariant 1 — one reducer builds every assistant turn

`shared/src/transcript/` owns `TranscriptPart` and `reduceTurnParts()`, a pure
function from (parts, turn event) to parts. It is the **only** code that decides
how reasoning, text and tool activity are ordered inside an assistant turn.

- The backend folds every manager stream event of a turn through it and persists
  the result as the message's `parts`.
- The frontend folds the same live events through it and renders the turn with
  `partsToFeedEntries()`.
- History rendering uses the same `partsToFeedEntries()` on the persisted parts.

So live view == reload view by construction. Never add ordering logic to the
feed store, the history loader, or the message store; change the reducer and its
tests.

Ordering rule: a delta extends the last part only when the last part has the
same kind. Reasoning → tool → reasoning → text is four parts, in that order.

## Invariant 2 — a turn has one identity from its first event

The persisted assistant message id is allocated when the manager turn **starts**,
and every manager `stream.*` event for that turn carries it as
`payload.messageId`. The id is stamped in one place (the manager's emit path),
not at each call site.

The frontend keys a live turn by `messageId`. When persisted history arrives,
a live turn is replaced **by id**. Text comparison between live and persisted
rows is forbidden; if two rows cannot be matched by id, they are different rows.

## Invariant 3 — reasoning for the provider is separate from reasoning for display

`StoredMessage.reasoningContent` stays exactly what it was: provider replay input
(signatures, DeepSeek-style reasoning echo). Display uses `parts`. Do not derive
one from the other in a way that changes what is sent back to a provider.

Legacy rows without `parts` render as `[reasoning(reasoningContent)?, text(content)]`.

## Invariant 4 — session identity is required, never defaulted

- `SESSION_SCOPED_EVENT_TYPES` in `shared/src/websocket/` lists every event that
  touches a chat transcript, agent, run or review. `SessionWSMessage` has a
  required `sessionId`.
- The backend WS manager refuses to publish a session-scoped event without a
  `sessionId` (logs and drops). The frontend drops one too.
- Feed and agent store mutations take `sessionId` as a required first argument.
  No parameter defaults to the open chat, and no `sessionId ?? ''`.
- Any per-agent client state (thinking timers, stream targets, steering queues)
  is keyed by `(sessionId, agentId)`.
- "The open chat" decides only which lane is **displayed**, never where a write
  lands.

## Invariant 5 — per-session server state lives in one object

`KoryManager`'s per-session maps live in a `SessionRuntime` owned by
`SessionRuntimeRegistry`. Deleting or erasing a session disposes the whole
runtime in one call. Do not add a new `Map<sessionId, …>` field to the manager.

## Replay never rebuilds a persisted turn

A fresh renderer (no durable cursor) subscribes and loads the HTTP message
projection in parallel. Since a persisted turn's `parts` are the fold of exactly
its `stream.*` events, replaying those events would rebuild rows the projection
already carries — per token, only to be replaced by id. The subscription's
replay filter therefore suppresses an event only when **both** hold:

- `payload.messageId` names a message already durable well before the subscribe
  (a recency margin keeps a just-committed turn replaying — it may have raced
  the renderer's projection read), and
- `turnEventFromWSMessage(event)` is non-null — i.e. the shared fold itself
  would have consumed the event. The predicate is the fold, not a parallel
  list, so it cannot drift from what `parts` covers.

Everything else keeps replaying: the in-flight turn (unpersisted messageId),
worker/critic streams (never stamped), `kory.*`/`agent.*` operational rows (not
in `parts`), and stamped-but-unfolded types like `stream.usage`. A
cursor-carrying resume is never filtered: events missed for a turn that
persisted while the client was away are the only copy left.

## Turn start is one durable write path

A user turn starts through `KoryManager.startSessionTurn()`. Every non-image
send from `POST /api/messages` does, including sends with no `clientMessageId`,
which get a server-minted `srv_` source id. The rules below are what that path
guarantees.

- **The ledger is the intent record.** The `session_turn_commands` row is written
  before the user input, and it names the input (`user_message_id`) and the
  response (`response_message_id`). A crash cannot leave a message that no command
  explains.
- **Input is idempotent.** The input is written with `messages.addIdempotent`, so
  the same command can never persist its message twice.
- **Receipts replay.** A command that was already admitted returns its stored
  receipt (`replay`, `runId`, `userMessageId`) instead of starting a second turn.
  A different payload under the same id is a 409, never a replay.
- **A never-persisted input can be reclaimed.** If admission failed before the
  input was written, no side effect happened. The same id and the same canonical
  input reclaim the command and run it once. Any other input is still a conflict.
- **A persisted but interrupted turn is never replayed automatically.** Once the
  input is durable and its run is lost (for example to a restart), the receipt
  reports `command_execution_was_interrupted; explicit retry required`, and
  nothing re-runs the provider on its own. When the run's terminal reason is
  `backend_restarted_during_active_run`, the composer shows a one-click **Resume**
  row that sends an explicit continuation as a new command. No verified CLI can
  resume a provider conversation across a restart (`docs/architecture/provider-lifecycle.md`),
  so the explicit continuation is the honest behavior.
- **A user send never bounces off recoverable work.** `startSessionTurn` for
  `source: 'user'` never returns `session_busy` while the blocker is
  recoverable. A stale aborted claim or an orphaned durable run is
  terminalized and reclaimed; cancellable local work whose snapshot is
  `waiting` (a parked question or process wait) is cancelled first. The send
  then runs as a new command. A durable mutation barrier (Time Travel,
  erasure) is never superseded, and non-user producers (`goal`,
  `collaboration`, `internal`) keep the strict reject-on-busy contract.
- **A live run is steered at a checkpoint, not cancelled mid-flight.** When a
  genuinely live local run holds the session, a user send is parked behind
  it: the message persists eagerly, a durable `usrsteer_<sourceCommandId>`
  row is enqueued in `agent_steering_commands` under the manager identity,
  and the turn loop samples the park at the same checkpoints a stop uses —
  after the current tool call or provider turn, never mid-edit or
  mid-stream. The run then settles `steered_by_user`, unexecuted tool calls
  in its last batch receive synthetic "skipped" results so no `tool_call` is
  left dangling, and `drainManagerSteeringQueue` admits the parked send as
  the next turn through the normal command-ledger path. The parked row id is
  deterministic, so a retry replays the same receipt; a restart drains the
  row from its durable content. Explicit **Stop** still aborts immediately
  and cancels parked rows, so a stop cannot resurrect a queued send.
- **Superseded turns are silent.** When an old run loses ownership to a newer
  one (`TurnOwnershipLostError`), its stack publishes no terminal decision and
  no `system.error`; only the owning run may report state.
- **Image turns and regeneration steer too.** `processImageMessage` and the
  regenerate routes reserve through `reserveSessionTurnAfterSteer`, which
  supersedes cancellable work before reserving. Image generation itself is
  not a provider chat loop and has no ledger-backed dispatch yet, so it keeps
  the admitted path (`reserveSessionTurn` plus `messages.add`) after the
  steer.

New producers of user turns call `startSessionTurn`; never write a user message
and dispatch separately.

## Enforcement

- `shared/src/transcript/*.test.ts` — reducer ordering rules.
- Backend turn parity test — a fake provider emits reasoning → tool → reasoning →
  text; the persisted `parts` equal `reduceTurnParts` over the emitted events.
- Frontend reload parity test — the same events applied live, then the session
  reloaded from persisted history, produce identical feed rows (ignoring row ids).
- Backend and frontend tests that a session-scoped event without `sessionId` is
  dropped.
