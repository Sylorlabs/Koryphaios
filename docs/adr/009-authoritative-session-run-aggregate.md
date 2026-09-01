# ADR-009: Authoritative, revisioned SessionRun aggregate

## Status

Accepted

## Context

Koryphaios previously had no backend object that could answer “is this session
run alive?” The renderer inferred that answer from stream chunks, agent status,
heartbeats, pending questions, process events, local Stop clicks, watchdogs, and
replay order. `sessions.workflow_state` was descriptive and was overwritten on
many unrelated paths; it had no run identity, revision, or legal-transition
rules.

This produced recurring families of bugs rather than isolated defects:

- a late chunk or heartbeat could resurrect a completed run;
- a dropped terminal event left the composer stuck on Stop;
- reconnect replay could temporarily walk through obsolete lifecycle states;
- process waits and user waits looked terminal to some consumers and active to
  others;
- a backend crash could leave no durable explanation of what was interrupted;
- fixes accumulated as watchdogs, tombstones, retry queues, and event-specific
  frontend guards.

Transport ordering and terminal-event retry are valuable, but neither is a
domain transaction. A run transition could still be lost between changing
backend state and appending its WebSocket event.

## Decision

1. `SessionRun` is the authoritative lifecycle aggregate for a chat session.
   It owns `runId`, monotonic `revision`, phase, status, wait reason, active
   agent IDs, timestamps, and terminal reason.
2. Legal transitions are defined by the pure reducer in
   `shared/src/run/SessionRun.ts`. Every non-start command carries both an
   `expectedRunId` and `expectedRevision`; stale callbacks are rejected instead
   of applied to a newer revision of the same run. Phase changes may originate
   only from active state, and resume must name the exact waiting phase.
3. A transition writes both `session_runs` and a `session_run_events` outbox row
   in one SQLite `IMMEDIATE` transaction. Publication occurs only after commit.
4. Outbox publication is at-least-once. The payload revision makes duplicate
   delivery harmless. Startup recovery and a runtime retry pump drain pending
   rows. The existing ordered WebSocket log remains the transport replay
   mechanism; it is not the aggregate store.
5. `run.state` is the renderer's authoritative lifecycle projection. Once a
   session has received it, legacy stream/status events may still update the
   transcript and agent detail, but may not mutate session lifecycle.
6. Subscription sends the current snapshot after ordered replay. A reconnect
   therefore converges on current truth without replay inference.
7. Every waiting run owns one durable continuation. A user wait atomically
   commits the question, continuation, run revision, and outbox row; answering,
   cancelling, or timing out closes all of them in the same transaction. A
   process wait persists the exact owned agent-process IDs and may resume only
   after every one has an authoritative terminal row.
8. Backend startup marks active provider/compaction runs as failed with
   `backend_restarted_during_active_run`. Durable user/process waits remain
   waiting only while their continuation is structurally valid. Orphaned waits
   fail closed. Already-terminal process continuations are reconstructed from
   persisted process rows; recovered session-cancellation evidence cancels the
   run instead of waking a provider.
9. HTTP message and image routes reserve an opaque, single-use manager
   admission before persisting work. A busy reservation returns conflict with
   no message/variant mutation. Dispatch consumes the token synchronously and
   reuses the already-started run, so an accepted response cannot silently
   double-start or bypass cancellation/erasure barriers.
10. Every existing and newly inserted session receives an idle run row.
    Durability migrations run under one immediate transaction, validate their
    actual SQLite shape before ledgering, and recheck the ledger under the write
    lock. Malformed outbox rows are dead-lettered individually and published
    history is retained for a bounded period.
11. `sessions.workflow_state`, heartbeats, legacy `agent.status`, and the client
   watchdog remain compatibility projections only. New code must not consult
   them to decide whether a run is active.

## Invariants

- At most one active or waiting run exists per session.
- A new start is illegal until the prior run is terminal.
- Revisions increase exactly once per material lifecycle transition.
- Snapshot and outbox transition either both commit or neither commits.
- A terminal run cannot return to an active phase.
- A command for an old `runId` cannot mutate the current run.
- A command for an old revision of the current run cannot mutate it.
- Waiting state can be resumed only by its exact durable continuation.
- A pending question and its waiting run revision cannot disagree after a
  transaction commits.
- A route cannot persist a promised user turn until manager admission succeeds.
- An admission token can be dispatched or rejected exactly once.
- Publication failure never erases a committed transition.
- Renderer event order cannot override a newer aggregate revision.

## Consequences

- The Stop/send state, waits, restart recovery, and reconnect behavior now have
  one durable owner.
- Token streaming does not create lifecycle write amplification; duplicate
  phase reports are no-ops.
- There are temporarily two vocabularies at the edge (`run.state` and legacy
  agent/stream events). This is an intentional strangler seam, not shared
  authority.
- Manager-local run maps are leases/caches only. Losing them cannot lose or
  change the durable lifecycle fact.
- Features that create session-scoped work must transition `SessionRun` rather
  than invent another busy flag or teach the frontend another inference rule.
- Chat image jobs use the same manager claim, abort signal, run transitions, and
  erasure barrier as text turns. They do not write into the unscoped Image
  Studio history.
- Permanent session deletion is available only through coordinated erasure;
  the store no longer exposes direct deletion shortcuts around live producer
  barriers and filesystem receipts.

## Follow-up boundary

The aggregate does not make `KoryManager` acceptably small. The next extraction
is a `TurnRuntime` application service that owns provider streaming, tool-loop
execution, and the SessionRun lease. After that, provider capability interfaces
and generated HTTP contracts can be split without reintroducing lifecycle
ambiguity.
