import type { WSMessage } from "@koryphaios/shared";
import { serverLog } from "../logger";

interface WSClient {
  ws: any;
  subscribedSessions: Set<string>;
}

export class WSManager {
  private clients = new Map<string, WSClient>();

  add(ws: any) {
    const id = ws.data.id;
    this.clients.set(id, { ws, subscribedSessions: new Set() });
    serverLog.debug({ clientId: id, totalClients: this.clients.size }, "WebSocket client added");
  }

  remove(ws: any) {
    const id = ws.data.id;
    this.clients.delete(id);
    serverLog.debug({ clientId: id, totalClients: this.clients.size }, "WebSocket client removed");
  }

  subscribeClientToSession(clientId: string, sessionId: string) {
    const client = this.clients.get(clientId);
    if (client) client.subscribedSessions.add(sessionId);
  }

  broadcast(message: WSMessage) {
    const data = JSON.stringify(message);
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
        serverLog.warn({ error: String(err) }, "Failed to send WebSocket message to client");
      }
    }

    if (failCount > 0) {
      serverLog.debug({ successCount, failCount }, "Broadcast complete with failures");
    }
  }

  broadcastToSession(sessionId: string, message: WSMessage) {
    const data = JSON.stringify(message);
    let targetCount = 0;

    for (const [, client] of this.clients) {
      if (client.subscribedSessions.has(sessionId) || client.subscribedSessions.size === 0) {
        try {
          if (client.ws.readyState === 1) {
            client.ws.send(data);
            targetCount++;
          }
        } catch (err) {
          serverLog.warn({ sessionId, error: String(err) }, "Failed to send session message to client");
        }
      }
    }

    serverLog.debug({ sessionId, targetCount }, "Session broadcast complete");
  }

  get clientCount() {
    return this.clients.size;
  }
}
