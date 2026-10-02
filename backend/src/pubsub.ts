// Type-safe pub/sub event broker — ported from OpenCode's pubsub/broker.go.
// Uses async generators for backpressure-friendly subscription.

import { serverLog } from './logger';

export type EventType = 'created' | 'updated' | 'deleted' | 'custom';

export interface BrokerEvent<T> {
  type: EventType;
  payload: T;
  timestamp: number;
}

export const MAX_BUFFER = 256;

// Stream chunk types that are safe to drop for a single slow subscriber: the
// next flush (or the terminal completion event, which is never dropped)
// resynchronizes the client. Terminal/completion events must always be queued.
const DROPPABLE_CHUNK_TYPES = new Set(['stream.delta', 'stream.thinking']);

/** A queued payload is full when the subscriber has this many unread events. */
function queueDepth(controller: ReadableStreamDefaultController<unknown>): number | null {
  // Default ReadableStream highWaterMark is 1, so queueSize ≈ 1 - desiredSize.
  const desired = controller.desiredSize;
  return desired === null ? null : 1 - desired;
}

function isDroppableChunk(payload: unknown): boolean {
  return (
    !!payload &&
    typeof payload === 'object' &&
    DROPPABLE_CHUNK_TYPES.has((payload as { type?: string }).type ?? '')
  );
}

export class Broker<T> {
  private subscribers = new Map<
    string,
    {
      controller: ReadableStreamDefaultController<BrokerEvent<T>>;
      closed: boolean;
      abortListener?: () => void;
      /** Non-terminal stream chunks skipped while this subscriber was full. */
      droppedChunks: number;
      /** True after the buffer-full warning was logged; reset once drained. */
      dropWarned: boolean;
    }
  >();
  private idCounter = 0;
  private isShutdown = false;
  /** Cumulative non-terminal stream chunks dropped for full buffers. */
  private totalDroppedChunks = 0;

  /** Subscribe to events. Returns an async iterable that yields events. */
  subscribe(signal?: AbortSignal): ReadableStream<BrokerEvent<T>> {
    if (this.isShutdown) {
      throw new Error('Broker is shut down');
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

        this.subscribers.set(id, {
          controller,
          closed: false,
          abortListener,
          droppedChunks: 0,
          dropWarned: false,
        });

        signal?.addEventListener('abort', abortListener);
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
    const droppable = isDroppableChunk(payload);

    for (const [id, sub] of this.subscribers) {
      if (sub.closed) continue;
      try {
        // Enforce MAX_BUFFER per subscriber: when the unread queue exceeds the
        // limit, drop the oldest-pressure source — incoming non-terminal
        // stream deltas — instead of accumulating indefinitely. Terminal
        // events are always enqueued so completion/error is never lost.
        const depth = queueDepth(sub.controller);
        if (depth !== null && depth > MAX_BUFFER) {
          if (droppable) {
            sub.droppedChunks += 1;
            this.totalDroppedChunks += 1;
            if (!sub.dropWarned) {
              sub.dropWarned = true;
              serverLog.warn(
                { subscriberId: id, queueDepth: depth, maxBuffer: MAX_BUFFER },
                'Broker subscriber buffer full, dropping non-terminal stream deltas',
              );
            }
            continue;
          }
          // Terminal payload for a full buffer: still enqueue (delivery is
          // mandatory), and note the recovery once the queue drains.
        } else if (sub.dropWarned && (depth === null || depth <= MAX_BUFFER)) {
          serverLog.info(
            { subscriberId: id, droppedChunks: sub.droppedChunks },
            'Broker subscriber buffer drained after delta drops',
          );
          sub.dropWarned = false;
          sub.droppedChunks = 0;
        }
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

  /** Cumulative stream deltas dropped for over-full subscriber buffers. */
  get droppedChunkCount(): number {
    return this.totalDroppedChunks;
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
      } catch (err: unknown) {
        serverLog.debug(
          { err: err instanceof Error ? err.message : String(err) },
          'Subscriber controller close failed',
        );
      }
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

import type { WSMessage, Session, PermissionRequest, AgentIdentity } from '@koryphaios/shared';

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
