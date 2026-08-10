import type { ServerWebSocket } from 'bun';
import type { WSMessage } from '@koryphaios/shared';
import { serverLog } from '../logger';
import { getOrderedEventLog } from './ordered-event-log';

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
]);

const TERMINAL_AGENT_STATUSES = new Set<string>(['done', 'error', 'idle']);

/**
 * Whether a message is a terminal event that must be queued for retry under
 * backpressure. Pure type/payload inspection — no side effects, safe to call
 * on every broadcast.
 */
function isTerminalEvent(message: WSMessage): boolean {
  if (TERMINAL_EVENT_TYPES.has(message.type)) return true;
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
}

export class WSManager {
  private clients = new Map<string, WSClient>();
  private erasedSessions = new Set<string>();
  private readonly maxClients = 1000;
  private heartbeatInterval: Timer | null = null;
  private terminalRetryInterval: Timer | null = null;
  private isShutdown = false;

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

  subscribeClientToSession(
    clientId: string,
    sessionId: string,
    cursor?: { epoch?: number; sequence?: number },
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
    let after = cursor?.epoch === current.epoch ? Math.max(0, cursor?.sequence ?? 0) : 0;
    while (after < current.latestSequence) {
      const events = log.getAfter(sessionId, epoch, after, 2_048);
      if (events.length === 0) break;
      for (const event of events) {
        if (client.ws.readyState !== 1) return;
        client.ws.send(JSON.stringify({ ...event, replayed: true } satisfies WSMessage));
        after = event.sequence ?? after;
      }
    }
  }

  private persist(message: WSMessage): WSMessage {
    return message.sessionId ? getOrderedEventLog().append(message) : message;
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

    const overloaded = this.isClientOverloaded(client);
    client.overloaded = overloaded;
    if (overloaded) {
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

  broadcast(message: WSMessage) {
    if (message.sessionId && this.erasedSessions.has(message.sessionId)) return;
    const ordered = this.persist(message);
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
    const data = JSON.stringify(ordered);
    let targetCount = 0;

    for (const [, client] of this.clients) {
      if (client.subscribedSessions.has(sessionId)) {
        if (this.deliverToClient(client, ordered, data)) targetCount++;
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

  /** Drop subscriptions and queued payloads, then reject stale post-delete events. */
  forgetSession(sessionId: string): void {
    this.erasedSessions.add(sessionId);
    for (const client of this.clients.values()) {
      client.subscribedSessions.delete(sessionId);
      client.pendingTerminalEvents = client.pendingTerminalEvents.filter(
        (event) => event.sessionId !== sessionId,
      );
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
