/**
 * Custom event emitter implementation for the MCP server
 */

import type { EventEmitter as IEventEmitter, ServerEvents } from '@/types/index.js';

export class EventEmitter implements IEventEmitter<ServerEvents> {
  private listeners: Map<keyof ServerEvents, Array<(...args: any[]) => void>> = new Map();

  on<K extends keyof ServerEvents>(event: K, listener: (...args: ServerEvents[K]) => void): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event)!.push(listener);
  }

  off<K extends keyof ServerEvents>(event: K, listener: (...args: ServerEvents[K]) => void): void {
    const eventListeners = this.listeners.get(event);
    if (eventListeners) {
      const index = eventListeners.indexOf(listener);
      if (index !== -1) {
        eventListeners.splice(index, 1);
      }
    }
  }

  emit<K extends keyof ServerEvents>(event: K, ...args: ServerEvents[K]): void {
    const eventListeners = this.listeners.get(event);
    if (eventListeners) {
      // Create a copy to avoid issues if listeners are modified during emission
      const listenersCopy = [...eventListeners];
      for (const listener of listenersCopy) {
        try {
          listener(...args);
        } catch (error) {
          // Log error but don't stop other listeners
          console.error(`Error in event listener for ${String(event)}:`, error);
        }
      }
    }
  }

  once<K extends keyof ServerEvents>(event: K, listener: (...args: ServerEvents[K]) => void): void {
    const onceWrapper = (...args: ServerEvents[K]): void => {
      this.off(event, onceWrapper);
      listener(...args);
    };
    this.on(event, onceWrapper);
  }

  removeAllListeners<K extends keyof ServerEvents>(event?: K): void {
    if (event) {
      this.listeners.delete(event);
    } else {
      this.listeners.clear();
    }
  }

  listenerCount<K extends keyof ServerEvents>(event: K): number {
    const eventListeners = this.listeners.get(event);
    return eventListeners ? eventListeners.length : 0;
  }

  eventNames(): Array<keyof ServerEvents> {
    return Array.from(this.listeners.keys());
  }

  getMaxListeners(): number {
    return 10; // Default max listeners
  }

  setMaxListeners(_n: number): this {
    // For simplicity, we don't enforce max listeners in this implementation
    return this;
  }
}
