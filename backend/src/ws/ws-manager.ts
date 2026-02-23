import type { ServerWebSocket } from "bun";
import type { WSMessage } from "@koryphaios/shared";
import { serverLog } from "../logger";

export interface WSClientData {
  id: string;
  userId: string;
  sessionId?: string;
}

interface WSClient {
  ws: ServerWebSocket<WSClientData>;
  subscribedSessions: Set<string>;
  messageQueue: WSMessage[];
  isPaused: boolean;
  lastPing: number;
  reconnectAttempts: number;
}

interface WSManagerConfig {
  maxQueueSize?: number;
  pingInterval?: number;
  maxReconnectAttempts?: number;
  reconnectDelay?: number;
}

const DEFAULT_CONFIG: Required<WSManagerConfig> = {
  maxQueueSize: 1000,
  pingInterval: 30000, // 30 seconds
  maxReconnectAttempts: 5,
  reconnectDelay: 1000, // 1 second
};

export class WSManager {
  private clients = new Map<string, WSClient>();
  private config: Required<WSManagerConfig>;
  private pingInterval?: ReturnType<typeof setInterval>;

  constructor(config: WSManagerConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.startPingInterval();
  }

  private startPingInterval() {
    this.pingInterval = setInterval(() => {
      this.pingAllClients();
    }, this.config.pingInterval);

    // Don't keep the process alive just for pinging
    if (this.pingInterval.unref) this.pingInterval.unref();
  }

  private pingAllClients() {
    const now = Date.now();
    for (const [id, client] of this.clients) {
      // Check for stale connections
      if (now - client.lastPing > this.config.pingInterval * 2) {
        serverLog.warn({ clientId: id }, "Stale WebSocket connection detected, closing");
        client.ws.close(1000, "Stale connection");
        this.remove(client.ws);
        continue;
      }

      // Send ping
      try {
        if (client.ws.readyState === 1) {
          client.ws.send(JSON.stringify({ type: "ping", timestamp: now }));
        }
      } catch (err) {
        serverLog.warn({ clientId: id, error: String(err) }, "Failed to send ping");
      }
    }
  }

  add(ws: ServerWebSocket<WSClientData>) {
    const id = ws.data.id;
    this.clients.set(id, {
      ws,
      subscribedSessions: new Set(),
      messageQueue: [],
      isPaused: false,
      lastPing: Date.now(),
      reconnectAttempts: 0,
    });

    serverLog.debug({ clientId: id, totalClients: this.clients.size }, "WebSocket client added");
  }

  remove(ws: ServerWebSocket<WSClientData>) {
    const id = ws.data.id;
    this.clients.delete(id);
    serverLog.debug({ clientId: id, totalClients: this.clients.size }, "WebSocket client removed");
  }

  subscribeClientToSession(clientId: string, sessionId: string) {
    const client = this.clients.get(clientId);
    if (client) {
      client.subscribedSessions.add(sessionId);
      serverLog.debug({ clientId, sessionId }, "Client subscribed to session");
    }
  }

  unsubscribeClientFromSession(clientId: string, sessionId: string) {
    const client = this.clients.get(clientId);
    if (client) {
      client.subscribedSessions.delete(sessionId);
      serverLog.debug({ clientId, sessionId }, "Client unsubscribed from session");
    }
  }

  pauseClient(clientId: string) {
    const client = this.clients.get(clientId);
    if (client) {
      client.isPaused = true;
      serverLog.debug({ clientId }, "Client paused (backpressure management)");
    }
  }

  resumeClient(clientId: string) {
    const client = this.clients.get(clientId);
    if (client) {
      client.isPaused = false;
      this.flushQueue(client);
      serverLog.debug({ clientId }, "Client resumed");
    }
  }

  private flushQueue(client: WSClient) {
    while (client.messageQueue.length > 0 && !client.isPaused) {
      const message = client.messageQueue.shift();
      if (message) {
        try {
          client.ws.send(JSON.stringify(message));
        } catch (err) {
          serverLog.warn({ clientId: client.ws.data.id, error: String(err) }, "Failed to send queued message");
          // Re-queue the message
          client.messageQueue.unshift(message);
          break;
        }
      }
    }
  }

  private sendWithBackpressure(client: WSClient, message: WSMessage): boolean {
    // Check if client is paused
    if (client.isPaused) {
      if (client.messageQueue.length < this.config.maxQueueSize) {
        client.messageQueue.push(message);
        return true;
      }
      serverLog.warn({ clientId: client.ws.data.id }, "Client queue full, dropping message");
      return false;
    }

    // Try to send immediately
    try {
      client.ws.send(JSON.stringify(message));
      return true;
    } catch (err) {
      // Buffer is full, pause the client and queue the message
      client.isPaused = true;
      if (client.messageQueue.length < this.config.maxQueueSize) {
        client.messageQueue.push(message);
        serverLog.debug({ clientId: client.ws.data.id }, "Client paused due to backpressure");
        return true;
      }
      serverLog.warn({ clientId: client.ws.data.id, error: String(err) }, "Failed to send message, queue full");
      return false;
    }
  }

  broadcast(message: WSMessage, options?: { sessionId?: string; skipClientId?: string }) {
    let successCount = 0;
    let failCount = 0;
    let skippedCount = 0;

    for (const [id, client] of this.clients) {
      // Skip specific client if requested
      if (options?.skipClientId === id) {
        skippedCount++;
        continue;
      }

      // Filter by session if specified
      if (options?.sessionId) {
        if (!client.subscribedSessions.has(options.sessionId) && client.subscribedSessions.size > 0) {
          skippedCount++;
          continue;
        }
      }

      // Check connection state
      if (client.ws.readyState !== 1) {
        failCount++;
        continue;
      }

      // Send with backpressure handling
      if (this.sendWithBackpressure(client, message)) {
        successCount++;
      } else {
        failCount++;
      }
    }

    if (failCount > 0 || skippedCount > 0) {
      serverLog.debug({ successCount, failCount, skippedCount }, "Broadcast complete");
    }
  }

  broadcastToSession(sessionId: string, message: WSMessage) {
    return this.broadcast(message, { sessionId });
  }

  sendToClient(clientId: string, message: WSMessage): boolean {
    const client = this.clients.get(clientId);
    if (!client || client.ws.readyState !== 1) {
      return false;
    }
    return this.sendWithBackpressure(client, message);
  }

  /**
   * Handle a pong message from a client — call this from the server's WS message handler.
   * Bun's ServerWebSocket does not support .on("message") on the socket itself;
   * pong handling must be routed through the server-level websocket.message callback.
   */
  handlePong(clientId: string) {
    const client = this.clients.get(clientId);
    if (client) {
      client.lastPing = Date.now();
    }
  }

  get clientCount() {
    return this.clients.size;
  }

  getClientIds(): string[] {
    return Array.from(this.clients.keys());
  }

  getSessionSubscribers(sessionId: string): string[] {
    const subscribers: string[] = [];
    for (const [id, client] of this.clients) {
      if (client.subscribedSessions.has(sessionId)) {
        subscribers.push(id);
      }
    }
    return subscribers;
  }

  /**
   * Gracefully close all connections.
   */
  closeAll(code: number = 1000, reason: string = "Server shutting down") {
    clearInterval(this.pingInterval);

    for (const [id, client] of this.clients) {
      try {
        client.ws.close(code, reason);
      } catch (err) {
        serverLog.warn({ clientId: id, error: String(err) }, "Failed to close WebSocket connection");
      }
    }

    this.clients.clear();
    serverLog.info("All WebSocket connections closed");
  }

  /**
   * Get statistics about connected clients.
   */
  getStats() {
    let pausedCount = 0;
    let totalQueuedMessages = 0;

    for (const client of this.clients.values()) {
      if (client.isPaused) pausedCount++;
      totalQueuedMessages += client.messageQueue.length;
    }

    return {
      totalClients: this.clients.size,
      pausedClients: pausedCount,
      totalQueuedMessages,
      averageQueueSize: this.clients.size > 0 ? totalQueuedMessages / this.clients.size : 0,
    };
  }
}
