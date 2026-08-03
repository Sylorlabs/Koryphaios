import type { ServerWebSocket } from 'bun';
import type { WSMessage } from '@koryphaios/shared';
import { serverLog } from '../logger';
import { getOrderedEventLog } from './ordered-event-log';

interface WSClientData {
  id: string;
  sessionId?: string;
  userId?: string;
}

interface WSClient {
  ws: ServerWebSocket<WSClientData>;
  subscribedSessions: Set<string>;
  isAlive: boolean;
}

export class WSManager {
  private clients = new Map<string, WSClient>();
  private readonly maxClients = 1000;
  private heartbeatInterval: Timer | null = null;
  private isShutdown = false;

  constructor() {
    // Check for stale connections every 30 seconds
    this.heartbeatInterval = setInterval(() => this.heartbeat(), 30000);
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
    this.clients.set(id, { ws, subscribedSessions: new Set(), isAlive: true });
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
          } catch {
            /* Expected: socket may already be closed */
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
          } catch {
            /* Expected: socket may already be closed */
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

  broadcast(message: WSMessage) {
    const ordered = this.persist(message);
    const data = JSON.stringify(ordered);
    let successCount = 0;
    let failCount = 0;

    for (const [, client] of this.clients) {
      try {
        if (client.ws.readyState === 1) {
          client.ws.send(data);
          successCount++;
        }
      } catch (err) {
        failCount++;
        serverLog.warn({ error: String(err) }, 'Failed to send WebSocket message to client');
      }
    }

    if (failCount > 0) {
      serverLog.debug({ successCount, failCount }, 'Broadcast complete with failures');
    }
    if (successCount > 0) getOrderedEventLog().markDispatched(ordered.eventId);
  }

  broadcastToSession(sessionId: string, message: WSMessage) {
    const ordered = this.persist({ ...message, sessionId });
    const data = JSON.stringify(ordered);
    let targetCount = 0;

    for (const [, client] of this.clients) {
      if (client.subscribedSessions.has(sessionId)) {
        try {
          if (client.ws.readyState === 1) {
            client.ws.send(data);
            targetCount++;
          }
        } catch (err) {
          serverLog.warn(
            { sessionId, error: String(err) },
            'Failed to send session message to client',
          );
        }
      }
    }

    if (targetCount > 0) getOrderedEventLog().markDispatched(ordered.eventId);

    serverLog.debug({ sessionId, targetCount }, 'Session broadcast complete');
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

    // Stop heartbeat
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
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
