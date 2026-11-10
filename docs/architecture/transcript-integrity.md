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

## Enforcement

- `shared/src/transcript/*.test.ts` — reducer ordering rules.
- Backend turn parity test — a fake provider emits reasoning → tool → reasoning →
  text; the persisted `parts` equal `reduceTurnParts` over the emitted events.
- Frontend reload parity test — the same events applied live, then the session
  reloaded from persisted history, produce identical feed rows (ignoring row ids).
- Backend and frontend tests that a session-scoped event without `sessionId` is
  dropped.
