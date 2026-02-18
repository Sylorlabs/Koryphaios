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
  }>();
  private idCounter = 0;

  /** Subscribe to events. Returns an async iterable that yields events. */
  subscribe(signal?: AbortSignal): ReadableStream<BrokerEvent<T>> {
    const id = String(++this.idCounter);

    const stream = new ReadableStream<BrokerEvent<T>>({
      start: (controller) => {
        this.subscribers.set(id, { controller, closed: false });

        signal?.addEventListener("abort", () => {
          this.unsubscribe(id);
        });
      },
      cancel: () => {
        this.unsubscribe(id);
      },
    });

    return stream;
  }

  /** Publish an event to all subscribers. Non-blocking — slow subscribers are skipped. */
  publish(type: EventType, payload: T) {
    const event: BrokerEvent<T> = { type, payload, timestamp: Date.now() };

    for (const [id, sub] of this.subscribers) {
      if (sub.closed) continue;
      try {
        sub.controller.enqueue(event);
      } catch {
        // Subscriber's buffer full or closed — skip
        this.unsubscribe(id);
      }
    }
  }

  /** Number of active subscribers. */
  get subscriberCount(): number {
    return this.subscribers.size;
  }

  /** Shutdown all subscriptions. */
  shutdown() {
    for (const [id] of this.subscribers) {
      this.unsubscribe(id);
    }
  }

  private unsubscribe(id: string) {
    const sub = this.subscribers.get(id);
    if (sub && !sub.closed) {
      sub.closed = true;
      try {
        sub.controller.close();
      } catch {}
    }
    this.subscribers.delete(id);
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
