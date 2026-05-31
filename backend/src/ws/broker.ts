import { wsBroker } from '../pubsub';
import { WSManager } from './ws-manager';

/**
 * Initialize the WebSocket broker.
 * This bridges the global pub/sub broker to the active WebSocket connections.
 */
export function initWSBroker(manager: WSManager): void {
  const stream = wsBroker.subscribe();
  const reader = stream.getReader();

  // Process events from the global broker and broadcast to WebSocket clients
  (async () => {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value && value.payload) {
          if (value.payload.sessionId) {
            manager.broadcastToSession(value.payload.sessionId, value.payload);
          } else {
            manager.broadcast(value.payload);
          }
        }
      }
    } catch (err) {
      // Ignore errors in the bridge loop, but log them
    }
  })();
}
