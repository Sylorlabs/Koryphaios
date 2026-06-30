import type { WSMessage } from '@koryphaios/shared';
import { wsBroker } from '../pubsub';
import { WSManager } from './ws-manager';
import { StreamCoalescer } from './stream-coalescer';

/**
 * Initialize the WebSocket broker.
 * This bridges the global pub/sub broker to the active WebSocket connections.
 */
export function initWSBroker(manager: WSManager): void {
  const stream = wsBroker.subscribe();
  const reader = stream.getReader();

  const publish = (message: WSMessage) => {
    if (message.sessionId) {
      manager.broadcastToSession(message.sessionId, message);
    } else {
      manager.broadcast(message);
    }
  };

  const coalescer = new StreamCoalescer(publish);

  // Process events from the global broker and broadcast to WebSocket clients
  (async () => {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value?.payload) {
          coalescer.enqueue(value.payload);
        }
      }
    } catch {
      // Bridge loop ended
    } finally {
      coalescer.dispose();
    }
  })();
}
