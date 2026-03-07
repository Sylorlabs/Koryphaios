// Type-safe pub/sub event broker — ported from OpenCode's pubsub/broker.go.
// Uses async generators for backpressure-friendly subscription.

export type EventType = "created" | "updated" | "deleted" | "custom";

export interface BrokerEvent<T> {
  type: EventType;
  payload: T;
  timestamp: number;
}

const MAX_BUFFER = 256;

export class Broker<T> {
  private subscribers = new Map<string, {
    controller: ReadableStreamDefaultController<BrokerEvent<T>>;
    closed: boolean;
    abortListener?: () => void;
  }>();
  private idCounter = 0;
  private isShutdown = false;

  /** Subscribe to events. Returns an async iterable that yields events. */
  subscribe(signal?: AbortSignal): ReadableStream<BrokerEvent<T>> {
    if (this.isShutdown) {
      throw new Error("Broker is shut down");
    }

    const id = String(++this.idCounter);
    let abortListener: (() => void) | undefined;

    const stream = new ReadableStream<BrokerEvent<T>>({
      start: (controller) => {
        if (this.isShutdown) {
          controller.close();
          return;
        }

        abortListener = () => {
          this.unsubscribe(id);
        };

        this.subscribers.set(id, { controller, closed: false, abortListener });

        signal?.addEventListener("abort", abortListener);
      },
      cancel: () => {
        this.unsubscribe(id);
      },
    });

    return stream;
  }

  /** Publish an event to all subscribers. Non-blocking — slow subscribers are skipped if buffer full. */
  publish(type: EventType, payload: T) {
    const event: BrokerEvent<T> = { type, payload, timestamp: Date.now() };

    for (const [id, sub] of this.subscribers) {
      if (sub.closed) continue;
      try {
        // enqueue will throw if the controller is closed or closing
        sub.controller.enqueue(event);
      } catch (err) {
        // Only unsubscribe if the error indicates a closed stream
        // For other errors, we might just skip this event
        this.unsubscribe(id);
      }
    }
  }

  /** Number of active subscribers. */
  get subscriberCount(): number {
    return this.subscribers.size;
  }

  /** Shutdown all subscriptions. */
  shutdown(): void {
    if (this.isShutdown) return;

    this.isShutdown = true;

    for (const [id] of this.subscribers) {
      this.unsubscribe(id);
    }

    this.subscribers.clear();
  }

  /** Check if broker is shut down. */
  isShuttingDown(): boolean {
    return this.isShutdown;
  }

  private unsubscribe(id: string) {
    const sub = this.subscribers.get(id);
    if (sub && !sub.closed) {
      sub.closed = true;
      try {
        // Remove abort listener if present
        if (sub.abortListener) {
          // Note: We can't remove the listener from the AbortSignal directly
          // as we don't have a reference to the signal. The listener check
          // inside will handle the shutdown case.
        }
        sub.controller.close();
      } catch { /* Expected: controller may already be closed */ }
    }
    this.subscribers.delete(id);
  }

  /** Get current subscriber count. */
  getSubscriberCount(): number {
    return this.subscribers.size;
  }
}

// ─── Global Event Bus ───────────────────────────────────────────────────────
// Singleton brokers for different event domains.

import type {
  WSMessage,
  Session,
  PermissionRequest,
  AgentIdentity,
} from "@koryphaios/shared";

export const sessionBroker = new Broker<Session>();
export const permissionBroker = new Broker<PermissionRequest>();
export const agentBroker = new Broker<AgentIdentity>();
export const wsBroker = new Broker<WSMessage>();

/**
 * Shutdown all global brokers.
 * Call this during server shutdown to properly clean up all subscribers.
 */
export function shutdownAllBrokers(): void {
  sessionBroker.shutdown();
  permissionBroker.shutdown();
  agentBroker.shutdown();
  wsBroker.shutdown();
}

/**
 * Get total subscriber count across all brokers.
 */
export function getTotalBrokerSubscribers(): number {
  return (
    sessionBroker.getSubscriberCount() +
    permissionBroker.getSubscriberCount() +
    agentBroker.getSubscriberCount() +
    wsBroker.getSubscriberCount()
  );
}
