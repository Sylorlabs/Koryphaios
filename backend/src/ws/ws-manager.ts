import type { ServerWebSocket } from 'bun';
import {
  hasRequiredSessionIdentity,
  type SessionHistoryPrunedPayload,
  type WSMessage,
} from '@koryphaios/shared';
import { serverLog } from '../logger';
import {
  getOrderedEventLog,
  prunedBoundaryAhead,
  type ReplayPageBudget,
} from './ordered-event-log';
import { mergePayload } from './stream-coalescer';

interface WSClientData {
  id: string;
  sessionId?: string;
  userId?: string;
}

// 64KB — when a client's outbound buffer exceeds this, treat it as overloaded:
// skip non-critical messages and queue terminal events for retry. This keeps a
// single slow client from blocking the event loop on broadcast.
const BACKPRESSURE_THRESHOLD = 64 * 1024;

// Terminal events must be delivered. If they are dropped (e.g. because the
// client was overloaded at broadcast time), the frontend's busy/Stop state
// gets stuck. These events are always queued per-client and retried on a
// separate timer until they can be sent.
//
// `agent.status` is terminal ONLY when the payload status is one of the
// terminal statuses (done/error/idle). Workers finish via `agent.status:
// done` (runAgentThread emits it directly), so without this rule a worker's
// completion event is dropped under backpressure and the WorkerCard stays
// pinned on "Thinking…" until the 15s watchdog fires. The watchdog is a
// fallback, not a substitute for delivering the event reliably.
// Non-terminal statuses (thinking, streaming, tool_calling) must NOT be
// queued — delivering a stale "thinking" after "done" would resurrect a
// dead run in the frontend reducer.
const TERMINAL_EVENT_TYPES = new Set<string>([
  'stream.complete',
  'agent.completed',
  'agent.error',
  'process.exited',
  'system.error',
  'session.timeline_rewritten',
  'session.changes_resolved',
  'kory.ask_user_resolved',
  'turn.provider_completed',
  'run.settled',
  // A shell exiting must reach the UI even under backpressure; output may be dropped
  // because the client resynchronizes from the scrollback by sequence.
  'terminal.exit',
]);

// Lifecycle events that stop the UI spinner. Under backpressure they are never
// held or merged: the session's pending deltas flush first, then they go out at once.
const IMMEDIATE_EVENT_TYPES = new Set<string>(['turn.provider_completed', 'run.settled']);

const TERMINAL_AGENT_STATUSES = new Set<string>(['done', 'error', 'idle']);

/**
 * Whether a message is a terminal event that must be queued for retry under
 * backpressure. Pure type/payload inspection — no side effects, safe to call
 * on every broadcast.
 */
function isTerminalEvent(message: WSMessage): boolean {
  if (TERMINAL_EVENT_TYPES.has(message.type)) return true;
  if (message.type === 'run.state') {
    // Every aggregate revision is critical. If an older active snapshot is
    // delivered after a newer terminal one, the renderer rejects it by
    // revision; dropping the only current snapshot would be worse.
    return true;
  }
  if (message.type === 'agent.status') {
    const status = (message.payload as { status?: string }).status;
    return !!status && TERMINAL_AGENT_STATUSES.has(status);
  }
  return false;
}

// Retry interval for queued terminal events. This is a separate timer from the
// heartbeat — the heartbeat checks for stale connections; this timer drains
// queued terminal events once backpressure clears.
const TERMINAL_RETRY_MS = 2_000;

// Session replay page size. Reconnects page through history in small batches
// through the same overload guard as live delivery instead of blasting up to
// 2_048 events per tick over raw ws.send at a slow client.
const REPLAY_PAGE_SIZE = 256;
/** Replay pages also stop at this many serialized bytes (B6). A page keeps at least one event. */
export const REPLAY_PAGE_MAX_BYTES = 512 * 1024;

// Live stream backpressure (B6). A client whose socket holds more than
// DELTA_BACKPRESSURE_THRESHOLD bytes stops receiving individual stream.delta /
// stream.thinking events. They accumulate per contiguous run (session, agent,
// kind, turn) and go out as one merged frame once the socket drains below
// DELTA_RESUME_THRESHOLD (half the threshold). Sequenced events are never
// dropped or reordered: the frontend reorders strictly by sequence and fills
// gaps by replay, so each merged frame sits at its run's last sequence and the
// earlier sequences get a replay_skipped placeholder.
const DELTA_BACKPRESSURE_THRESHOLD = 4 * 1024 * 1024;
const DELTA_RESUME_THRESHOLD = DELTA_BACKPRESSURE_THRESHOLD / 2;
// A merged frame carries at most about this much text, so one flush cannot queue an unbounded frame.
const MERGED_DELTA_FRAME_CHARS = 64 * 1024;

/** A contiguous run of stream deltas that share one agent, kind and turn. */
interface DeltaRun {
  kind: 'delta';
  sessionId: string;
  key: string;
  messages: WSMessage[];
}

/** A non-delta event that must keep its place behind deltas still queued for its session. */
interface QueuedEvent {
  kind: 'event';
  sessionId: string;
  message: WSMessage;
}

interface WSClient {
  ws: ServerWebSocket<WSClientData>;
  subscribedSessions: Set<string>;
  isAlive: boolean;
  // True while the client's outbound buffer is over BACKPRESSURE_THRESHOLD.
  // Non-terminal messages are skipped and terminal events are queued.
  overloaded: boolean;
  // Terminal events that could not be sent due to backpressure. Drained by
  // retryTerminalEvents() on the TERMINAL_RETRY_MS timer.
  pendingTerminalEvents: WSMessage[];
  // Stream deltas (and events that follow them) held while the socket is over
  // the delta threshold. Drained in order by drainDeliveryQueue().
  deliveryQueue: Array<DeltaRun | QueuedEvent>;
}

function bufferedBytes(client: WSClient): number {
  return client.ws.getBufferedAmount?.() ?? 0;
}

/** Only sequenced stream deltas can merge: their sequence positions the merged frame. */
function isMergeableDelta(message: WSMessage): boolean {
  return (
    (message.type === 'stream.delta' || message.type === 'stream.thinking') &&
    !!message.sessionId &&
    Number.isSafeInteger(message.sequence) &&
    Number.isSafeInteger(message.epoch)
  );
}

function deltaRunKey(message: WSMessage): string {
  const payload = message.payload as { agentId?: string; messageId?: string };
  return `${message.type}\u0000${payload?.agentId ?? ''}\u0000${payload?.messageId ?? ''}`;
}

function deltaTextLength(message: WSMessage): number {
  const payload = message.payload as { content?: string; thinking?: string } | null;
  return (payload?.content?.length ?? 0) + (payload?.thinking?.length ?? 0);
}

/** Take the next chunk of a run, bounded by MERGED_DELTA_FRAME_CHARS (always at least one message). */
function takeDeltaChunk(messages: WSMessage[]): WSMessage[] {
  let chars = 0;
  let count = 0;
  while (count < messages.length) {
    chars += deltaTextLength(messages[count]);
    count++;
    if (chars >= MERGED_DELTA_FRAME_CHARS) break;
  }
  return messages.splice(0, count);
}

/**
 * Frames for one chunk of a delta run: a replay_skipped placeholder at each
 * sequence but the last, then one merged delta at the last sequence carrying
 * the concatenated text. The merged frame keeps payload.messageId, so the turn
 * identity Invariant 2 relies on is unchanged.
 */
function mergeDeltaChunk(chunk: WSMessage[]): WSMessage[] {
  const frames: WSMessage[] = chunk.slice(0, -1).map(
    (message) =>
      ({
        type: 'session.replay_skipped',
        sessionId: message.sessionId,
        epoch: message.epoch,
        sequence: message.sequence,
        timestamp: message.timestamp,
        payload: null,
      }) as WSMessage,
  );
  let payload = chunk[0].payload;
  for (let i = 1; i < chunk.length; i++) payload = mergePayload(payload, chunk[i].payload);
  frames.push({ ...chunk[chunk.length - 1], payload });
  return frames;
}

export class WSManager {
  private clients = new Map<string, WSClient>();
  private erasedSessions = new Set<string>();
  private readonly maxClients = 1000;
  private heartbeatInterval: Timer | null = null;
  private terminalRetryInterval: Timer | null = null;
  private isShutdown = false;
  private readonly sessionEventListeners = new Map<string, Set<(message: WSMessage) => void>>();

  /** In-process session consumers receive the same ordered stream as sockets,
   * including lifecycle events published directly by the run coordinator. */
  onSessionEvent(sessionId: string, listener: (message: WSMessage) => void): () => void {
    const listeners = this.sessionEventListeners.get(sessionId) ?? new Set();
    listeners.add(listener);
    this.sessionEventListeners.set(sessionId, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.sessionEventListeners.delete(sessionId);
    };
  }

  private notifySessionListeners(message: WSMessage): void {
    if (!message.sessionId) return;
    for (const listener of this.sessionEventListeners.get(message.sessionId) ?? []) {
      try {
        listener(message);
      } catch (error) {
        serverLog.error({ error, sessionId: message.sessionId }, 'Session event listener failed');
      }
    }
  }

  constructor() {
    // Heartbeat checks for stale connections every 10s. This is a separate
    // timer from the terminal-event retry — do not couple them.
    this.heartbeatInterval = setInterval(() => this.heartbeat(), 10_000);
    // Drain queued terminal events on a 2s timer, independent of the heartbeat.
    this.terminalRetryInterval = setInterval(
      () => this.drainPendingTerminalEvents(),
      TERMINAL_RETRY_MS,
    );
  }

  add(ws: ServerWebSocket<WSClientData>) {
    if (this.isShutdown) {
      ws.close(1001, 'Server shutting down');
      return;
    }
    if (this.clients.size >= this.maxClients) {
      ws.close(1013, 'Max clients reached');
      return;
    }
    const id = ws.data.id;
    this.clients.set(id, {
      ws,
      subscribedSessions: new Set(),
      isAlive: true,
      overloaded: false,
      pendingTerminalEvents: [],
      deliveryQueue: [],
    });
    serverLog.debug({ clientId: id, totalClients: this.clients.size }, 'WebSocket client added');
  }

  remove(ws: ServerWebSocket<WSClientData>) {
    const id = ws.data.id;
    const client = this.clients.get(id);
    if (client) {
      // Clear subscriptions to prevent memory leaks
      client.subscribedSessions.clear();
    }
    this.clients.delete(id);
    serverLog.debug({ clientId: id, totalClients: this.clients.size }, 'WebSocket client removed');
  }

  handlePong(clientId: string) {
    const client = this.clients.get(clientId);
    if (client) {
      client.isAlive = true;
    }
  }

  private heartbeat() {
    try {
      for (const [id, client] of this.clients) {
        if (client.isAlive === false) {
          serverLog.debug({ clientId: id }, 'Terminating inactive WebSocket client');
          try {
            client.ws.close();
          } catch (err: unknown) {
            /* Expected: socket may already be closed */
            serverLog.debug(
              { clientId: id, err: err instanceof Error ? err.message : String(err) },
              'WebSocket close failed during inactive client termination',
            );
          }
          this.clients.delete(id);
          continue;
        }

        client.isAlive = false;
        try {
          client.ws.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));
        } catch (err) {
          // If send fails, assume dead and remove next tick
          serverLog.warn({ clientId: id, error: String(err) }, 'Failed to send ping');
          this.clients.delete(id);
          try {
            client.ws.close();
          } catch (err: unknown) {
            /* Expected: socket may already be closed */
            serverLog.debug(
              { clientId: id, err: err instanceof Error ? err.message : String(err) },
              'WebSocket close failed after ping failure',
            );
          }
        }
      }
    } catch (err) {
      serverLog.error({ error: String(err) }, 'Heartbeat loop error');
    }
  }

  /**
   * Replays a session in sequence order. `replayFilter` may suppress stale
   * operational projections when a durable current-state lookup proves they
   * are no longer actionable. Replace each filtered row with an ephemeral
   * placeholder at that same sequence so ordered clients can advance safely.
   *
   * Replay honors the same backpressure guard as the live path: every event
   * goes through deliverToClient (never raw ws.send), pages are capped at
   * REPLAY_PAGE_SIZE, and the loop stops as soon as the client reports
   * overloaded — terminal events are queued for retry while non-terminal
   * history is skipped, so a slow client can never be replay-flooded.
   */
  subscribeClientToSession(
    clientId: string,
    sessionId: string,
    cursor?: { epoch?: number; sequence?: number },
    replayFilter?: (event: WSMessage) => boolean,
    replayHistory = true,
  ) {
    const client = this.clients.get(clientId);
    if (!client) return;
    // Never subscribe a client to or replay events for a session that has
    // been erased.  The ordered event log still holds rows for deleted
    // sessions (only the cursor/cause metadata is cleared), so without this
    // guard a reconnect would replay stale `session.updated` events and
    // resurrect the deleted chat in the frontend sidebar.
    if (this.erasedSessions.has(sessionId)) return;
    client.subscribedSessions.add(sessionId);

    // Reconnects and full page refreshes recover every event that was durably
    // appended before publication. A fresh renderer starts at sequence zero;
    // an in-app reconnect resumes from its last applied sequence.
    const log = getOrderedEventLog();
    const current = log.getCursor(sessionId);
    const epoch = current.epoch;
    let after = replayHistory
      ? cursor?.epoch === current.epoch
        ? Math.max(0, cursor?.sequence ?? 0)
        : 0
      : current.latestSequence;
    if (replayHistory) {
      // The replay below re-sends everything after the cursor, including any
      // deltas this client was still holding. Keeping the held copies too would duplicate them.
      client.deliveryQueue = client.deliveryQueue.filter((item) => item.sessionId !== sessionId);
      // Pruned history cannot be replayed. Tell this client where the retained
      // history begins without rotating the epoch: the marker jumps its cursor
      // to the mark, and replay continues from there. Rotating would discard
      // causal links for in-flight tool results and would reset every reload.
      const pruned = prunedBoundaryAhead(log.getPruneMark(sessionId), current, cursor);
      if (pruned) {
        this.sendHistoryPruned(client, sessionId, epoch, pruned.sequence);
        after = pruned.sequence;
      }
    }
    // A freshly opened chat already loads its durable message/context
    // projection over HTTP, and the subscription's replayFilter suppresses
    // stream events whose turn is persisted as `parts` — replay then carries
    // only operational state plus the in-flight turn. Live events after this
    // point still deliver normally.
    const budget: ReplayPageBudget = {
      maxEvents: REPLAY_PAGE_SIZE,
      maxBytes: REPLAY_PAGE_MAX_BYTES,
    };
    while (after < current.latestSequence) {
      const events = log.getPage(sessionId, epoch, after, budget);
      if (events.length === 0) break;
      for (const event of events) {
        if (client.ws.readyState !== 1) return;
        const replayed: WSMessage = !replayFilter || replayFilter(event)
          ? { ...event, replayed: true }
          : {
              type: 'session.replay_skipped',
              sessionId,
              epoch: event.epoch,
              sequence: event.sequence,
              timestamp: event.timestamp,
              payload: null,
              replayed: true,
            };
        this.deliverToClient(client, replayed, JSON.stringify(replayed));
        after = event.sequence ?? after;
        // Same overload guard as the live path: stop flooding a slow client.
        // Queued terminal events drain on the retry timer; the client resumes
        // remaining history from its cursor on the next subscribe.
        if (client.overloaded) return;
      }
    }
  }

  /**
   * Unsequenced control event: the retained history of `epoch` begins after
   * `throughSequence`. The client jumps its cursor there and reloads persisted
   * messages only if it had already applied part of that epoch. Sent straight
   * to one client, ahead of any replay page, and never queued.
   */
  private sendHistoryPruned(
    client: WSClient,
    sessionId: string,
    epoch: number,
    throughSequence: number,
  ): void {
    if (client.ws.readyState !== 1) return;
    const marker: WSMessage<SessionHistoryPrunedPayload> = {
      type: 'session.history_pruned',
      sessionId,
      epoch,
      timestamp: Date.now(),
      payload: { epoch, throughSequence },
    };
    try {
      client.ws.send(JSON.stringify(marker));
    } catch (err) {
      serverLog.warn(
        { sessionId, error: err instanceof Error ? err.message : String(err) },
        'Failed to send history-pruned marker',
      );
    }
  }

  private persist(message: WSMessage): WSMessage {
    // Fire-and-forget durability: per-token disk work must never block or
    // break live delivery. High-frequency stream chunks already arrive
    // pre-batched (one persist per coalescer window, not per token), and a
    // persist failure here falls back to delivering the unsequenced message
    // rather than throwing before send.
    try {
      return message.sessionId ? getOrderedEventLog().append(message) : message;
    } catch (err) {
      serverLog.error(
        {
          type: message.type,
          sessionId: message.sessionId,
          error: err instanceof Error ? err.message : String(err),
        },
        'Ordered-event persist failed, delivering without sequence',
      );
      return message;
    }
  }

  /**
   * Check whether a client is currently over the backpressure threshold.
   * The optional chaining handles test mocks and sockets that don't implement
   * getBufferedAmount.
   */
  private isClientOverloaded(client: WSClient): boolean {
    const buffered = client.ws.getBufferedAmount?.() ?? 0;
    return buffered > BACKPRESSURE_THRESHOLD;
  }

  /**
   * Attempt to deliver a single (already-serialized) message to one client,
   * honoring backpressure. Returns true if the message was sent.
   *
   * - If the client is overloaded: terminal events are queued in
   *   pendingTerminalEvents for retry; non-terminal events are skipped
   *   (dropped for this client). Never block the event loop on a slow client.
   * - If the client is not overloaded: send immediately.
   */
  private deliverToClient(client: WSClient, message: WSMessage, data: string): boolean {
    if (client.ws.readyState !== 1) return false;

    const buffered = bufferedBytes(client);
    client.overloaded = buffered > BACKPRESSURE_THRESHOLD;

    if (message.sessionId && IMMEDIATE_EVENT_TYPES.has(message.type)) {
      return this.sendImmediately(client, message);
    }

    // Per-session order is strict. A message joins whichever queue already
    // holds undelivered messages for its session, so it cannot overtake them.
    const queuedIn = message.sessionId ? this.queueHolding(client, message.sessionId) : null;
    if (queuedIn === 'delivery') {
      this.enqueueDelivery(client, message);
      this.drainDeliveryQueue(client);
      return false;
    }
    if (queuedIn === 'terminal') {
      this.retryTerminalEvents(client.ws.data.id, client);
      if (this.queueHolding(client, message.sessionId!) === 'terminal') {
        client.pendingTerminalEvents.push(message);
        return false;
      }
    }

    if (isMergeableDelta(message)) {
      // Deltas keep flowing up to the delta threshold, then accumulate for a merged flush.
      if (buffered > DELTA_BACKPRESSURE_THRESHOLD) {
        this.enqueueDelivery(client, message);
        return false;
      }
    } else if (client.overloaded) {
      if (isTerminalEvent(message)) {
        client.pendingTerminalEvents.push(message);
      }
      // Non-terminal events are intentionally dropped for overloaded clients.
      return false;
    }

    try {
      client.ws.send(data);
      return true;
    } catch (err) {
      serverLog.warn({ error: String(err) }, 'Failed to send WebSocket message to client');
      return false;
    }
  }

  /** Which queue, if any, still holds undelivered messages for this session. */
  private queueHolding(client: WSClient, sessionId: string): 'delivery' | 'terminal' | null {
    if (client.deliveryQueue.some((item) => item.sessionId === sessionId)) return 'delivery';
    if (client.pendingTerminalEvents.some((event) => event.sessionId === sessionId)) {
      return 'terminal';
    }
    return null;
  }

  /**
   * Send a spinner-stopping lifecycle event now. Everything already held for
   * its session goes first, in order, regardless of buffer level, so the event
   * never overtakes the text it follows. A send failure falls back to the
   * terminal retry queue.
   */
  private sendImmediately(client: WSClient, message: WSMessage): boolean {
    const sessionId = message.sessionId!;
    try {
      const held = client.deliveryQueue.filter((item) => item.sessionId === sessionId);
      client.deliveryQueue = client.deliveryQueue.filter((item) => item.sessionId !== sessionId);
      for (const item of held) {
        if (item.kind === 'event') {
          client.ws.send(JSON.stringify(item.message));
          continue;
        }
        while (item.messages.length > 0) {
          for (const frame of mergeDeltaChunk(takeDeltaChunk(item.messages))) {
            client.ws.send(JSON.stringify(frame));
          }
        }
      }
      const heldTerminal = client.pendingTerminalEvents.filter(
        (event) => event.sessionId === sessionId,
      );
      client.pendingTerminalEvents = client.pendingTerminalEvents.filter(
        (event) => event.sessionId !== sessionId,
      );
      for (const event of heldTerminal) client.ws.send(JSON.stringify(event));
      client.ws.send(JSON.stringify(message));
      return true;
    } catch (err) {
      serverLog.warn(
        { type: message.type, error: String(err) },
        'Failed to deliver lifecycle event immediately; queued for retry',
      );
      client.pendingTerminalEvents.push(message);
      return false;
    }
  }

  private enqueueDelivery(client: WSClient, message: WSMessage): void {
    const sessionId = message.sessionId!;
    if (!isMergeableDelta(message)) {
      client.deliveryQueue.push({ kind: 'event', sessionId, message });
      return;
    }
    // Only the newest run can grow, so merged text never jumps over another event.
    const key = deltaRunKey(message);
    const last = client.deliveryQueue[client.deliveryQueue.length - 1];
    if (last?.kind === 'delta' && last.sessionId === sessionId && last.key === key) {
      last.messages.push(message);
      return;
    }
    client.deliveryQueue.push({ kind: 'delta', sessionId, key, messages: [message] });
  }

  /** Send queued deliveries in order while the socket is at or below the resume threshold. */
  private drainDeliveryQueue(client: WSClient): void {
    while (client.deliveryQueue.length > 0 && bufferedBytes(client) <= DELTA_RESUME_THRESHOLD) {
      const head = client.deliveryQueue[0];
      let chunk: WSMessage[] = [];
      try {
        if (head.kind === 'event') {
          client.ws.send(JSON.stringify(head.message));
          client.deliveryQueue.shift();
          continue;
        }
        chunk = takeDeltaChunk(head.messages);
        for (const frame of mergeDeltaChunk(chunk)) client.ws.send(JSON.stringify(frame));
        if (head.messages.length === 0) client.deliveryQueue.shift();
      } catch (err) {
        // Put an unsent chunk back. Frames the client already applied are
        // recognised by sequence on resend.
        if (head.kind === 'delta' && chunk.length > 0) head.messages.unshift(...chunk);
        serverLog.warn({ error: String(err) }, 'Failed to flush queued stream deltas');
        return;
      }
    }
  }

  broadcast(message: WSMessage) {
    if (message.sessionId && this.erasedSessions.has(message.sessionId)) return;
    // Invariant 4: a session-scoped event without its session is never published.
    if (!hasRequiredSessionIdentity(message)) {
      serverLog.error({ type: message.type }, 'Dropped session-scoped event without sessionId');
      return;
    }
    const ordered = this.persist(message);
    this.notifySessionListeners(ordered);
    const data = JSON.stringify(ordered);
    let successCount = 0;

    for (const [, client] of this.clients) {
      if (this.deliverToClient(client, ordered, data)) successCount++;
    }

    if (successCount > 0) getOrderedEventLog().markDispatched(ordered.eventId);
  }

  broadcastToSession(sessionId: string, message: WSMessage) {
    if (this.erasedSessions.has(sessionId)) return;
    const ordered = this.persist({ ...message, sessionId });
    this.deliverPersistedToSession(sessionId, ordered);
  }

  /** Atomically begin a rewritten ordered-event epoch and publish its durable
   * sequence-one control row to every subscriber. Old queued terminal rows
   * belong to the discarded branch and must not be retried ahead of it. */
  rewriteSessionTimeline(sessionId: string): { epoch: number; latestSequence: number } {
    if (this.erasedSessions.has(sessionId)) {
      throw new Error(`Cannot rewrite erased session ${sessionId}`);
    }
    const ordered = getOrderedEventLog().rewriteTimeline(sessionId);
    for (const client of this.clients.values()) {
      client.pendingTerminalEvents = client.pendingTerminalEvents.filter(
        (event) => event.sessionId !== sessionId,
      );
      client.deliveryQueue = client.deliveryQueue.filter((item) => item.sessionId !== sessionId);
    }
    this.deliverPersistedToSession(sessionId, ordered);
    return { epoch: ordered.epoch!, latestSequence: ordered.sequence! };
  }

  private deliverPersistedToSession(sessionId: string, ordered: WSMessage): void {
    this.notifySessionListeners(ordered);
    const data = JSON.stringify(ordered);
    let targetCount = 0;

    for (const [, client] of this.clients) {
      if (client.subscribedSessions.has(sessionId)) {
        if (this.deliverToClient(client, ordered, data)) targetCount++;
      } else if (ordered.type === 'run.state') {
        // Sidebar outcomes must stay live for unvisited chats too. Send only
        // the current projection: no transcript, transition, or ordered cursor.
        // A later real subscription still replays its durable history normally.
        const payload = ordered.payload as { snapshot: unknown };
        const projection = {
          type: 'run.state', sessionId, timestamp: ordered.timestamp,
          payload: { snapshot: payload.snapshot, transition: null },
        } as WSMessage;
        this.deliverToClient(client, projection, JSON.stringify(projection));
      }
    }

    if (targetCount > 0) getOrderedEventLog().markDispatched(ordered.eventId);

    serverLog.debug({ sessionId, targetCount }, 'Session broadcast complete');
  }

  /** Deliver a lifecycle notice without recreating a deleted session's event log. */
  broadcastEphemeral(message: WSMessage): void {
    const data = JSON.stringify(message);
    for (const [, client] of this.clients) this.deliverToClient(client, message, data);
  }

  /** Send a current projection to one subscriber without adding replay history. */
  sendToClientEphemeral(clientId: string, message: WSMessage): boolean {
    const client = this.clients.get(clientId);
    if (!client) return false;
    return this.deliverToClient(client, message, JSON.stringify(message));
  }

  /** Live, non-replayed session traffic (terminal output). Delivered only to
   *  clients subscribed to the session. Never persisted, so a reconnecting client
   *  restores from the terminal's scrollback instead of replaying the stream. */
  broadcastEphemeralToSession(sessionId: string, message: WSMessage): void {
    if (this.erasedSessions.has(sessionId)) return;
    const stamped = { ...message, sessionId };
    const data = JSON.stringify(stamped);
    for (const client of this.clients.values()) {
      if (client.subscribedSessions.has(sessionId)) this.deliverToClient(client, stamped, data);
    }
  }

  /** True when this socket has subscribed to the session and it is not erased. */
  isClientSubscribedTo(clientId: string, sessionId: string): boolean {
    const client = this.clients.get(clientId);
    return !!client && client.subscribedSessions.has(sessionId) && !this.erasedSessions.has(sessionId);
  }

  /** Drop subscriptions and queued payloads, then reject stale post-delete events. */
  forgetSession(sessionId: string): void {
    this.erasedSessions.add(sessionId);
    for (const client of this.clients.values()) {
      client.subscribedSessions.delete(sessionId);
      client.pendingTerminalEvents = client.pendingTerminalEvents.filter(
        (event) => event.sessionId !== sessionId,
      );
      client.deliveryQueue = client.deliveryQueue.filter((item) => item.sessionId !== sessionId);
      if (client.ws.data.sessionId === sessionId) client.ws.data.sessionId = undefined;
    }
  }

  /**
   * Retry queued terminal events for a single client. Called by the
   * TERMINAL_RETRY_MS timer for all clients, and exposed for direct use in
   * tests. If backpressure has cleared, queued terminal events are sent in
   * order; if still overloaded, they remain queued for the next tick.
   */
  retryTerminalEvents(clientId: string, client: WSClient): void {
    if (client.pendingTerminalEvents.length === 0) {
      // Still refresh the overloaded flag so callers observe current state.
      client.overloaded = this.isClientOverloaded(client);
      return;
    }

    const stillOverloaded = this.isClientOverloaded(client);
    client.overloaded = stillOverloaded;
    if (stillOverloaded) return;

    const remaining: WSMessage[] = [];
    for (const event of client.pendingTerminalEvents) {
      if (client.ws.readyState !== 1) {
        remaining.push(event);
        continue;
      }
      try {
        client.ws.send(JSON.stringify(event));
      } catch (err) {
        serverLog.warn(
          { clientId, error: String(err), type: event.type },
          'Failed to deliver queued terminal event',
        );
        remaining.push(event);
      }
    }
    client.pendingTerminalEvents = remaining;
  }

  private drainPendingTerminalEvents(): void {
    if (this.isShutdown) return;
    for (const [id, client] of this.clients) {
      try {
        this.drainDeliveryQueue(client);
        this.retryTerminalEvents(id, client);
      } catch (err) {
        serverLog.error({ clientId: id, error: String(err) }, 'Terminal-event retry loop error');
      }
    }
  }

  get clientCount() {
    return this.clients.size;
  }

  /**
   * Shutdown the WebSocket manager.
   * Closes all connections and clears the heartbeat interval.
   */
  shutdown(): void {
    if (this.isShutdown) return;

    serverLog.info({ clientCount: this.clients.size }, 'Shutting down WebSocket manager');
    this.isShutdown = true;
    this.sessionEventListeners.clear();

    // Stop heartbeat and terminal-event retry timers.
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (this.terminalRetryInterval) {
      clearInterval(this.terminalRetryInterval);
      this.terminalRetryInterval = null;
    }

    // Close all connections
    for (const [id, client] of this.clients) {
      try {
        client.ws.close(1001, 'Server shutting down');
        client.subscribedSessions.clear();
      } catch (err) {
        serverLog.warn(
          { clientId: id, error: String(err) },
          'Failed to close WebSocket connection',
        );
      }
    }

    // Clear all clients
    this.clients.clear();
    this.erasedSessions.clear();

    serverLog.info('WebSocket manager shutdown complete');
  }

  /**
   * Check if the manager is shut down.
   */
  isShuttingDown(): boolean {
    return this.isShutdown;
  }
}

export type { WSClientData };

// Singleton instance for modules that need to broadcast without direct access
export let wsManager: WSManager | null = null;

export function setWsManager(manager: WSManager) {
  wsManager = manager;
}
