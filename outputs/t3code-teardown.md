# t3code teardown: what to take, what to beat

Research date 2026-11-11. t3code was read at commit
[`32882540`](https://github.com/pingdotgg/t3code/tree/32882540fb1296bd1870253f3fe32bc8369f8a17)
(shallow clone). All t3code links below are pinned to that commit. Koryphaios paths are relative to
this repository on branch `refactor/transcript-integrity`.

---

## 0. One-paragraph summary

t3code's real advantage is its **write path**, not its feature count. Every state change is a
command that the
[Orchestrator](https://github.com/pingdotgg/t3code/blob/32882540fb1296bd1870253f3fe32bc8369f8a17/apps/server/src/orchestration-v2/Orchestrator.ts) turns into events. The
[EventSink](https://github.com/pingdotgg/t3code/blob/32882540fb1296bd1870253f3fe32bc8369f8a17/apps/server/src/orchestration-v2/EventSink.ts) then commits the events, the
projections, a command receipt and the follow-up side effects in **one SQLite transaction**. A
separate [EffectWorker](https://github.com/pingdotgg/t3code/blob/32882540fb1296bd1870253f3fe32bc8369f8a17/apps/server/src/orchestration-v2/EffectWorker.ts) does the provider work
after that commit. So restart recovery, retries and reconnects all work from one durable record.
Koryphaios already has most of the read side: a sequenced, replayable event log
(`backend/src/ws/ordered-event-log.ts`), one reducer for each turn
(`shared/src/transcript/TranscriptParts.ts`) and session-scoped state
(`backend/src/kory/services/SessionRuntime.ts`). What it lacks is that single durable write path. On
the UX side, t3code is built for power users who drive agents all day, and it pays for that in
complexity: drag-between-sections sidebars, inverted modifier shortcuts, and per-provider permission
fallbacks that change modes without telling you. Koryphaios can win by matching t3code's durability
and keeping a calm default surface.

---

## 1. Backend: where t3code's architecture is better

Each item: what t3code does → what Koryphaios does → the change to adopt, with effort and risk.

### B1. One transaction for events, projections, receipt and outbox

- **t3code.** [`docs/internals/overview.md` § Durable intent and side effects](https://github.com/pingdotgg/t3code/blob/32882540fb1296bd1870253f3fe32bc8369f8a17/docs/internals/overview.md)
  says: the orchestrator "serializes commands and decides events without performing provider or
  filesystem work", and `EventSink` "commits events, persisted projections, the accepted command
  receipt, and outbox effects in one database transaction". The side-effect kinds are typed in
  [`EffectOutbox.ts`](https://github.com/pingdotgg/t3code/blob/32882540fb1296bd1870253f3fe32bc8369f8a17/apps/server/src/orchestration-v2/EffectOutbox.ts) (`provider-turn.start`,
  `provider-turn.interrupt`, `provider-session.detach`, …). Each row moves through the states
  `pending` → `running` → `succeeded`/`failed`/`cancelled`.
- **Koryphaios.** The transcript is written through `backend/src/stores/message-store.ts`. That
  happens separately from appending the realtime event in `backend/src/ws/ordered-event-log.ts`,
  which has its own `BEGIN IMMEDIATE` transaction only for sequence allocation. The provider call
  is made inline from `backend/src/kory/manager.ts` (10,479 lines). If the process crashes between
  the message write, the event append and the provider spawn, you get states that no single record
  explains.
- **Adopt.** Add a small `kory_effects` outbox table and a `CommandSink.commit(events, projectionWrites, effects)`
  that runs them in one `db.transaction()`. Start with exactly two effect kinds, `turn.start` and
  `turn.interrupt`. Move the provider spawn in `ManagerRunLifecycle.ts` out of the request handler
  and into a worker that claims `pending` rows.
- **Effort:** M–L (2–3 weeks: one effect kind end to end first). **Risk:** medium. It touches the
  hottest path, but it can land behind the existing `ManagerTurnAdmission` boundary
  (`backend/src/kory/services/ManagerTurnAdmission.test.ts` already covers admission).

### B2. Idempotent commands with client-supplied ids

- **t3code.** Dispatch is receipt-backed: "Duplicate command ids must return the same
  receipt-backed result without re-running provider side effects"
  ([`docs/orchestration-v2/README.md`](https://github.com/pingdotgg/t3code/blob/32882540fb1296bd1870253f3fe32bc8369f8a17/docs/orchestration-v2/README.md),
  [`CommandReceiptStore.ts`](https://github.com/pingdotgg/t3code/blob/32882540fb1296bd1870253f3fe32bc8369f8a17/apps/server/src/orchestration-v2/CommandReceiptStore.ts)). Mobile
  can therefore queue messages offline and replay them safely
  ([`docs/user/composer.md` § Queue messages offline](https://github.com/pingdotgg/t3code/blob/32882540fb1296bd1870253f3fe32bc8369f8a17/docs/user/composer.md)).
- **Koryphaios.** `POST /api/messages` creates the user message id on the server
  (`backend/src/routes/v1/messages.ts:201`, `id: nanoid(...)`) and writes it at line 221. A client
  retry after a timeout or reconnect sends the message twice, and that starts two turns.
- **Adopt.** Have the client send a required `clientMessageId` (a ULID). Store it in a
  `command_receipts(session_id, client_id, result_json)` table under a unique key. When a duplicate
  arrives, return the stored result. This is also the identity the feed should use for its
  optimistic user row, which is the user-message counterpart of transcript Invariant 2.
- **Effort:** S (2–3 days). **Risk:** low. **Leverage:** high, because it makes reconnect and
  offline queueing safe.

### B3. Restart _continuation_, not just terminalization

- **t3code.**
  [`ProviderRuntimeRecoveryService.ts`](https://github.com/pingdotgg/t3code/blob/32882540fb1296bd1870253f3fe32bc8369f8a17/apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts)
  reconciles each thread on boot. It retires outbox effects that belonged to a lost provider
  process and keeps persisted questions answerable. Then
  [`RestartContinuation.ts`](https://github.com/pingdotgg/t3code/blob/32882540fb1296bd1870253f3fe32bc8369f8a17/apps/server/src/orchestration-v2/RestartContinuation.ts) picks the
  latest running run and resumes it through the provider's native resume primitive. A guard
  ("Settled runs require a live session so stale crash records cannot wake them") stops old crash
  records from restarting work.
- **Koryphaios.** `recoverState()` in `backend/src/kory/manager.ts:1064` marks active work as
  `'Process interrupted (server restart)'` (line 1100). Interrupted runs "require an explicit user
  retry" (line 2069). Durable process waits and question hand-offs are recovered
  (`recoverDurableProcessWaits` line 950, `recoverDurableQuestionHandoffs` line 1988), but the turn
  itself is not.
- **Adopt.** After B1, a turn that was `running` at crash time has a `turn.start` effect with a
  provider resume handle. On boot, for providers that can resume (Claude `--resume`, Codex thread
  ids, OpenCode ACP sessions), enqueue a continuation effect. For providers that cannot, keep
  today's behavior but show a one-click **Resume** row in the feed, not an error.
- **Effort:** M. **Risk:** medium. A turn that resumes when it should not is worse than one that
  stops, so copy t3code's "settled needs live session" guard.

### B4. A full provider adapter contract with declared capabilities

- **t3code.** [`ProviderAdapter.ts`](https://github.com/pingdotgg/t3code/blob/32882540fb1296bd1870253f3fe32bc8369f8a17/packages/provider-core/src/server/ProviderAdapter.ts)
  requires `ensureThread`, `resumeThread`, `startTurn`, `steerTurn`, `interruptTurn`,
  `respondToRuntimeRequest`, `readThreadSnapshot`, `rollbackThread`, `forkThread` and
  `getCapabilities` (lines 674–760). Capabilities are structured and versioned:
  `supportsActiveSteering`, `canRollbackThread`, `terminalStatusQuality: "strong" | "weak" | "none"`,
  and more
  ([`provider-capability-system.md`](https://github.com/pingdotgg/t3code/blob/32882540fb1296bd1870253f3fe32bc8369f8a17/docs/orchestration-v2/provider-capability-system.md)).
  Orchestration branches on capabilities, never on provider names (invariant 7 in
  [`orchestration-v2/README.md`](https://github.com/pingdotgg/t3code/blob/32882540fb1296bd1870253f3fe32bc8369f8a17/docs/orchestration-v2/README.md)).
- **Koryphaios.** `Provider` in `backend/src/providers/types.ts:251` has one operation,
  `streamResponse()` (line 269), plus a few optional flags (`supportsFreshConversation`,
  `imageInputTransport`). Steering, interruption, rollback and approvals are handled by
  provider-specific code in the manager and the CLI bridges. `ProviderHarnessCapabilities` in
  `backend/src/providers/provider-harness.ts:8` describes tooling and isolation, not lifecycle. The
  name sets `NATIVE_PROVIDERS` and `PROVIDERS_WITHOUT_KORY_TOOL_BRIDGE` are provider-name branching.
- **Adopt.** Add an optional `ProviderLifecycle` interface next to `streamResponse`, with methods
  `interrupt`, `steer`, `resume(handle)`, `rollback(toTurn)`, `fork`, and
  `capabilities(): LifecycleCapabilities`. Implement it first for the three verified CLIs (codex,
  claude, opencode). Then replace manager branches with capability checks. Don't copy t3code's
  whole surface; Koryphaios's HTTP-API providers are stateless and get `rollback`/`fork` for free
  through `supportsFreshConversation`.
- **Effort:** L, done incrementally (one method at a time). **Risk:** low per step.

### B5. App ids are identity, provider ids are evidence

- **t3code.**
  [`entity-ids-and-correlation.md`](https://github.com/pingdotgg/t3code/blob/32882540fb1296bd1870253f3fe32bc8369f8a17/docs/orchestration-v2/entity-ids-and-correlation.md)
  defines app-owned `ThreadId / RunId / NodeId / ProviderThreadId / ProviderTurnId / RuntimeRequestId`.
  Native ids are stored only as scoped `ProviderRefs`, and "Never match a native id globally without
  a provider/session/thread scope."
- **Koryphaios.** Transcript Invariant 2 (`docs/architecture/transcript-integrity.md`) already
  gives each turn an app id from its first event, which is the same idea. It stops at the
  assistant message, though. Tool calls, approvals and worker sub-turns still use provider-native
  ids in many adapters.
- **Adopt.** Extend Invariant 2 to tool calls and permission requests. Allocate a `toolCallId` and
  a `requestId` in `EventEmitterService.emit()` (`backend/src/kory/services/EventEmitterService.ts`)
  and keep the native id as `nativeRef`. Add a parity test like `turn-transcript-parity.test.ts`.
- **Effort:** S–M. **Risk:** low.

### B6. Bounded live streams and paged history

- **t3code.** [`LiveStreamBudget.ts`](https://github.com/pingdotgg/t3code/blob/32882540fb1296bd1870253f3fe32bc8369f8a17/apps/server/src/orchestration-v2/LiveStreamBudget.ts)
  caps each subscriber at `LIVE_STREAM_MAX_ITEMS = 1_000`. It coalesces queued full-state events
  and charges delivered bytes until the client ACKs them.
  [`ThreadLiveEventCoalescer.ts`](https://github.com/pingdotgg/t3code/blob/32882540fb1296bd1870253f3fe32bc8369f8a17/apps/server/src/orchestration-v2/ThreadLiveEventCoalescer.ts)
  collapses entity-replacing events while keeping their resume positions.
  [`threadHistoryPaging.ts`](https://github.com/pingdotgg/t3code/blob/32882540fb1296bd1870253f3fe32bc8369f8a17/apps/server/src/orchestration-v2/threadHistoryPaging.ts) pages
  history by a **byte budget** and keeps user turns whole.
  [`WireProjection.ts`](https://github.com/pingdotgg/t3code/blob/32882540fb1296bd1870253f3fe32bc8369f8a17/apps/server/src/orchestration-v2/WireProjection.ts) truncates stored
  diffs to the wire limit and shares one projection across subscribers.
- **Koryphaios.** `ws-manager.ts` replays in pages of `REPLAY_PAGE_SIZE = 256` events
  (`backend/src/ws/ws-manager.ts:72`), counted by events rather than bytes.
  `backend/src/ws/stream-coalescer.ts` coalesces deltas on a timer. Nothing checks socket
  `bufferedAmount` or client ACKs, so one large tool output or diff can stall a slow client.
- **Adopt.** (a) Make replay pages byte-budgeted (for example 512 KiB) and never split a turn.
  (b) Before sending to a client whose `bufferedAmount` is over a threshold, coalesce its pending
  deltas. (c) Truncate tool output and diffs on the wire, with a "load full output" fetch.
- **Effort:** S–M. **Risk:** low. Koryphaios's existing `outputs/harness-*.json` perf baselines
  can measure it.

### B7. Event-log retention

- **t3code.** [`ProjectionMaintenance.ts`](https://github.com/pingdotgg/t3code/blob/32882540fb1296bd1870253f3fe32bc8369f8a17/apps/server/src/orchestration-v2/ProjectionMaintenance.ts)
  keeps about a day of events for reconnect and retries, and keeps high-water marks. A client whose
  cursor falls below the pruned point resumes from a snapshot
  ([overview.md](https://github.com/pingdotgg/t3code/blob/32882540fb1296bd1870253f3fe32bc8369f8a17/docs/internals/overview.md)).
- **Koryphaios.** `ordered_session_events` (`backend/src/db/migrations.ts:682`) is deleted only
  when a session is erased (`backend/src/stores/session-erasure.ts:7`). Nothing else deletes from
  it, so it grows without limit and every stream delta stays forever.
- **Adopt.** A daily prune that keeps the newest N events per session plus anything newer than
  24 h. `subscribe` already handles epoch mismatch by resetting
  (`ws-manager.ts` lines 247–249). Send a `session.snapshot` when the cursor is older than the
  prune mark.
- **Effort:** S. **Risk:** low, provided the snapshot path is tested.

### B8. Provider turn end and run settlement are separate milestones

- **t3code.** "A late checkpoint or diff must not extend the recorded provider duration or keep
  the client showing provider work as active"
  ([overview.md § Turn completion](https://github.com/pingdotgg/t3code/blob/32882540fb1296bd1870253f3fe32bc8369f8a17/docs/internals/overview.md);
  [`RunFinalizationService.ts`](https://github.com/pingdotgg/t3code/blob/32882540fb1296bd1870253f3fe32bc8369f8a17/apps/server/src/orchestration-v2/RunFinalizationService.ts)).
- **Koryphaios.** `ProcessCompletionCoordinator.ts` and `ManagerRunLifecycle.ts` mix "the model
  stopped" with "the follow-up work is done" (critic, checkpoint, review). This is one cause of
  "still working…" spinners after the text has finished.
- **Adopt.** Add separate `turn.provider_completed` and `run.settled` events. The spinner follows
  the first, and a quiet "finalizing" chip follows the second.
- **Effort:** S. **Risk:** low.

### B9. Testing: replay transport, drainable workers, no sleeps

- **t3code.** Provider transports are replaced with recorded transcripts
  ([`packages/provider-testing/src/replayTranscript.ts`](https://github.com/pingdotgg/t3code/blob/32882540fb1296bd1870253f3fe32bc8369f8a17/packages/provider-testing/src/replayTranscript.ts),
  `fakeCli.ts`, `replayGate.ts`). A free "Replay (dev)" provider streams real turns through the UI
  ([AGENTS.md § Verifying](https://github.com/pingdotgg/t3code/blob/32882540fb1296bd1870253f3fe32bc8369f8a17/AGENTS.md)). Lint bans sleeps, polling and wall-clock assertions in
  tests (`t3code/no-real-time-wait-in-tests` and related rules, in
  [`oxlint-plugin-t3code/rules`](https://github.com/pingdotgg/t3code/blob/32882540fb1296bd1870253f3fe32bc8369f8a17/oxlint-plugin-t3code/rules)), and tests wait on
  [`DrainableWorker`](https://github.com/pingdotgg/t3code/blob/32882540fb1296bd1870253f3fe32bc8369f8a17/packages/shared/src/DrainableWorker.ts).
- **Koryphaios.** The parity tests use hand-built fake providers
  (`backend/src/kory/__tests__/turn-transcript-parity.test.ts`). Nothing records and replays a real
  CLI turn, even though the CLI adapters are the least-verified area (cursor and grok are explicitly
  "unverified" in `AGENTS.md`).
- **Adopt.** Record one real turn per verified CLI as JSONL (stdout frames plus timings) and replay
  it through the adapter in CI. Add a `replay` provider in dev builds.
- **Effort:** M. **Risk:** none at runtime. This makes every later backend change safer.

### Where t3code is _not_ better (don't copy)

- `Orchestrator.ts` is 15,399 lines and `ProjectionStore.ts` is 7,856
  (`wc -l` on [`apps/server/src/orchestration-v2/`](https://github.com/pingdotgg/t3code/blob/32882540fb1296bd1870253f3fe32bc8369f8a17/apps/server/src/orchestration-v2)). That is
  no smaller than `manager.ts`. Copy the transaction boundary, not the file layout.
- Pruning means "projections cannot be rebuilt from the log"
  ([overview.md](https://github.com/pingdotgg/t3code/blob/32882540fb1296bd1870253f3fe32bc8369f8a17/docs/internals/overview.md)), so the log isn't a full event store. Koryphaios
  can stay simpler and treat its log as a replay buffer, as B7 proposes.
- Effect-TS everywhere ([`docs/internals/effect-services.md`](https://github.com/pingdotgg/t3code/blob/32882540fb1296bd1870253f3fe32bc8369f8a17/docs/internals/effect-services.md))
  is a big learning-curve tax. Koryphaios gets the same guarantees with `bun:sqlite` transactions.
- Koryphaios is ahead on **enforcement**. Kory gates tools itself through
  `backend/src/tools/permission-policy.ts` and the `kory__*` MCP bridge, while t3code mostly
  forwards each provider's own approvals (see U3). Koryphaios also already has an ordered, cursored
  replay log, a durable steering queue (`backend/src/kory/manager.ts:8698`, `agent.steering_queue`)
  and shadow-repo checkpoints (`backend/src/kory/checkpoint-store.ts`), which match
  [t3code's hidden-ref checkpoints](https://github.com/pingdotgg/t3code/blob/32882540fb1296bd1870253f3fe32bc8369f8a17/apps/server/src/checkpointing/CheckpointStore.ts).

---

## 2. UX: where t3code is too simple, too advanced, or too loud

The user's critique holds up against t3code's own docs. Taking the three failure modes in turn:

### U1. Too much information on the default surface

- **Sidebar as a state machine.** Threads have pinned, active, snoozed and settled sections. You
  move them by dragging between sections, and drops show **Pin / Unpin / Settle / Un-settle / Wake**
  badges, with separate rules for each pair of sections. Its doc takes more than 60 lines to
  explain ([`docs/user/thread-sidebar.md` § Pin and reorder threads](https://github.com/pingdotgg/t3code/blob/32882540fb1296bd1870253f3fe32bc8369f8a17/docs/user/thread-sidebar.md)).
  [`SidebarThreadRow.tsx`](https://github.com/pingdotgg/t3code/blob/32882540fb1296bd1870253f3fe32bc8369f8a17/apps/web/src/components/sidebar/SidebarThreadRow.tsx) alone is
  1,820 lines.
- **The composer as a cockpit.** It has 120+ files in
  [`components/chat/`](https://github.com/pingdotgg/t3code/blob/32882540fb1296bd1870253f3fe32bc8369f8a17/apps/web/src/components/chat), including a stash badge, a usage-limits
  strip, a server-update status, a speech button, a permissions section and a banner stack.
  [`ComposerBannerStack.tsx`](https://github.com/pingdotgg/t3code/blob/32882540fb1296bd1870253f3fe32bc8369f8a17/apps/web/src/components/chat/ComposerBannerStack.tsx) exists
  because there are enough banners that they need a priority system.
- **Koryphaios can do better.** The default chat should show the conversation, the composer and
  one status line. Pin is the only sidebar state shown by default. Settle/snooze can be a filter
  ("Show: Active ▾"), not drag targets. Koryphaios's new progressive toolbar
  (`frontend/src/lib/utils/toolbar-density.ts`) is the right primitive. Extend the same idea to
  banners: at most one banner at a time, and the rest in a "2 more" pill.

### U2. Too advanced in the advanced areas

- **Follow-up semantics are a modifier puzzle.** Queue vs. steer is a client setting. `Cmd+Enter`
  does the opposite of your default, `Cmd+Shift+Enter` steers the oldest queued message, `Shift`
  flips it again under multiline-send, and `Option+Up` edits the last queued message
  ([`docs/user/composer.md` § Send while the agent is working](https://github.com/pingdotgg/t3code/blob/32882540fb1296bd1870253f3fe32bc8369f8a17/docs/user/composer.md)).
- **Settings scopes.** Settings exist per client, per environment and per project, plus "All
  environments", which is described as "an explicit bulk edit … not a durable global default"
  ([overview.md § Settings ownership](https://github.com/pingdotgg/t3code/blob/32882540fb1296bd1870253f3fe32bc8369f8a17/docs/internals/overview.md)). That needs
  `settingsScope*.ts`, `SettingInheritance.tsx` and `SettingsScopeSentence.tsx` in
  [`components/settings/`](https://github.com/pingdotgg/t3code/blob/32882540fb1296bd1870253f3fe32bc8369f8a17/apps/web/src/components/settings), which has about 200 files.
- **Microphone ranking** by device kind with drag and swipe-to-forget
  ([`composer.md` § Voice input on mobile](https://github.com/pingdotgg/t3code/blob/32882540fb1296bd1870253f3fe32bc8369f8a17/docs/user/composer.md)).
- **Koryphaios can do better.** Offer one obvious default with depth on demand. While the agent
  works, **Enter queues** and the queued chip has a **Send now (steer)** button. One shortcut,
  everything else discoverable from the chip. Settings get two scopes, _Everywhere_ and _This
  project_, with an "overridden here" dot. Koryphaios's `SettingsDrawer.svelte` (5,658 lines) and
  `AgentSettings.svelte` (3,707 lines) are already heading toward t3code's sprawl, so put rarely
  used panels behind an "Advanced" disclosure and settings search.

### U3. Too simple where it matters: permissions and trust

- **Modes are labels, not guarantees.** t3code offers four modes and the **default is Full access**
  ([`docs/user/permission-modes.md`](https://github.com/pingdotgg/t3code/blob/32882540fb1296bd1870253f3fe32bc8369f8a17/docs/user/permission-modes.md)). Then, per provider, a
  thread "already set to [another mode] runs in Supervised" (Muse, fx, Grok, Kiro), **Auto** "falls
  back to asking" on OpenCode and Antigravity, and Claude "can still ask in Full access". The user
  picks one mode and gets a different one depending on the provider, with no explanation in the
  composer.
- **Koryphaios can do better.** Koryphaios actually enforces policy at its own boundary
  (`backend/src/tools/permission-policy.ts`, `kory__*` bridge). Make that visible. Show the
  _effective_ posture next to the mode picker, for example "Ask · enforced by Kory" or "Ask · Codex
  native, edits auto-approved". When the provider can't honor the chosen mode, show a one-line
  reason instead of downgrading silently. The composer already has
  `PERMISSION_OPTIONS` (`frontend/src/lib/components/CommandInput.svelte:936`, which defines
  yolo/guarded/edits/ask/custom). Add an "effective" badge computed from
  `getProviderHarnessCapabilities()` (`backend/src/providers/provider-harness.ts`).

### U4. Too simple: what the agent is doing right now

- t3code groups tool activity into collapsible work groups
  ([`MessagesTimeline.tsx`](https://github.com/pingdotgg/t3code/blob/32882540fb1296bd1870253f3fe32bc8369f8a17/apps/web/src/components/chat/MessagesTimeline.tsx), `WorkGroupSection`),
  and its chat header is mostly a breadcrumb
  ([`ChatHeader.tsx`](https://github.com/pingdotgg/t3code/blob/32882540fb1296bd1870253f3fe32bc8369f8a17/apps/web/src/components/chat/ChatHeader.tsx), whose rendered elements are
  mostly `WorkspaceBreadcrumb*` and tooltips). A collapsed group gives no running summary of
  intent, so the information is either hidden or a raw log.
- **Koryphaios can do better.** Collapse each work group into a single live **narrated** line, such
  as "Reading 4 files → editing `auth.ts` → running tests (2/3 passing)", built from the ordered
  `parts` that `reduceTurnParts()` already produces (`shared/src/transcript/TranscriptParts.ts`).
  Clicking it shows the full log. That is progressive disclosure built from data Koryphaios already
  has. `FeedEntry.svelte` already collapses sub-agent activity by default (line 1552).

### U5. Things t3code does well that Koryphaios should match

- **Edit from here** with a choice between keeping and reverting files, and refusal when another
  agent shares the directory ([`composer.md` § Edit an earlier prompt](https://github.com/pingdotgg/t3code/blob/32882540fb1296bd1870253f3fe32bc8369f8a17/docs/user/composer.md)).
  Koryphaios has rewind (`backend/src/routes/v1/sessions.ts:467`). Match the two-choice dialog and
  the shared-directory guard.
- **Undo toasts** for archive, pin and settle, with `mod+z` routed to the latest one
  ([`thread-sidebar.md`](https://github.com/pingdotgg/t3code/blob/32882540fb1296bd1870253f3fe32bc8369f8a17/docs/user/thread-sidebar.md)). It's cheap and noticeably good.
- **Large pastes become attachments** at 32 KiB ([`composer.md`](https://github.com/pingdotgg/t3code/blob/32882540fb1296bd1870253f3fe32bc8369f8a17/docs/user/composer.md)).
- **Onboarding finds what is already installed**: agents, projects from Claude, Codex and Pi
  history ([`docs/user/welcome-page.md`](https://github.com/pingdotgg/t3code/blob/32882540fb1296bd1870253f3fe32bc8369f8a17/docs/user/welcome-page.md)). Koryphaios has
  `CliChatImportPanel.svelte`. Surface it on first run instead of in settings.

---

## 3. Priorities: the shortlist

Ranked by leverage (how visibly superior it makes Koryphaios) divided by cost.

| #   | Move                                                                                  | Why it wins                                                                                     | Effort          | Risk         |
| --- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | --------------- | ------------ |
| 1   | **Idempotent send** with `clientMessageId` + receipts (B2)                            | Removes duplicate turns on reconnect; prerequisite for offline queue and the outbox             | S               | Low          |
| 2   | **Effective-permission badge**, no silent downgrade (U3)                              | A trust advantage t3code structurally lacks; Koryphaios already enforces it                     | S               | Low          |
| 3   | **Outbox + single-transaction commit** for `turn.start`/`turn.interrupt` (B1)         | Ends the "state no record explains" class, the backend analogue of the transcript-integrity fix | M–L             | Medium       |
| 4   | **Restart continuation** for resumable CLIs, a one-click Resume row for the rest (B3) | A server restart stops costing a turn; visible to users immediately                             | M               | Medium       |
| 5   | **Narrated work-group line** built from `parts` (U4)                                  | Simple by default and deep on click, the core of the user's critique                            | S–M             | Low          |
| 6   | **Provider lifecycle interface + capabilities**, replacing name branches (B4)         | Shrinks `manager.ts`; makes steer, interrupt and rollback uniform across providers              | L (incremental) | Low per step |
| 7   | **Byte-budgeted replay, wire truncation, event-log pruning** (B6 + B7)                | Keeps Koryphaios fast on long sessions; fixes unbounded DB growth                               | S–M             | Low          |
| 8   | **Recorded-CLI replay tests + a dev replay provider** (B9)                            | Every later backend change gets safer; free UI testing of real streams                          | M               | None         |

Suggested order: 1 → 2 → 7 → 5 (quick wins, under two weeks together), then 3 → 4 as one
project (the durable write path), then 6 and 8 alongside it.

---

## Sources

- t3code repository at commit `32882540`: <https://github.com/pingdotgg/t3code/tree/32882540fb1296bd1870253f3fe32bc8369f8a17>
- t3code README: <https://github.com/pingdotgg/t3code/blob/32882540fb1296bd1870253f3fe32bc8369f8a17/README.md>
- t3code AGENTS.md: <https://github.com/pingdotgg/t3code/blob/32882540fb1296bd1870253f3fe32bc8369f8a17/AGENTS.md>
- Koryphaios: the paths are cited inline; line numbers are as of this branch's working tree on 2026-11-11.
