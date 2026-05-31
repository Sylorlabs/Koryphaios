/**
 * Debug context tracking utility for comprehensive debugging information
 */

import { Logger } from './logger.js';

export interface DebugContext {
  id: string;
  type: string;
  startTime: number;
  metadata: Record<string, unknown>;
  operations: DebugOperation[];
  parent?: string | undefined;
  children: string[];
}

export interface DebugOperation {
  id: string;
  name: string;
  startTime: number;
  endTime?: number;
  status: 'pending' | 'success' | 'error';
  result?: unknown;
  error?: Error | undefined;
  metadata?: Record<string, unknown>;
}

export interface DebugSnapshot {
  timestamp: number;
  contexts: DebugContext[];
  systemInfo: {
    memory: NodeJS.MemoryUsage;
    uptime: number;
    platform: string;
    nodeVersion: string;
  };
  activeOperations: number;
  totalOperations: number;
}

export class DebugContextTracker {
  private contexts: Map<string, DebugContext> = new Map();
  private operations: Map<string, DebugOperation> = new Map();
  private logger: Logger;
  private operationCounter = 0;

  constructor(logger?: Logger) {
    this.logger = logger || new Logger('debug', { logFile: undefined });
  }

  // Context management
  createContext(type: string, metadata: Record<string, unknown> = {}, parentId?: string): string {
    const id = `ctx_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const context: DebugContext = {
      id,
      type,
      startTime: Date.now(),
      metadata: { ...metadata },
      operations: [],
      parent: parentId,
      children: [],
    };

    this.contexts.set(id, context);

    // Add to parent's children if parent exists
    if (parentId && this.contexts.has(parentId)) {
      this.contexts.get(parentId)!.children.push(id);
    }

    this.logger.createContext(id, type, metadata);
    this.logger.logMethodEntry('DebugContextTracker', 'createContext', { id, type, parentId });

    return id;
  }

  updateContext(contextId: string, updates: Record<string, unknown>): void {
    const context = this.contexts.get(contextId);
    if (!context) {
      this.logger.warn(`Context ${contextId} not found for update`);
      return;
    }

    Object.assign(context.metadata, updates);
    this.logger.updateContext(contextId, updates);
  }

  destroyContext(contextId: string, reason?: string): void {
    const context = this.contexts.get(contextId);
    if (!context) {
      this.logger.warn(`Context ${contextId} not found for destruction`);
      return;
    }

    // Destroy all child contexts first
    for (const childId of context.children) {
      this.destroyContext(childId, 'parent destroyed');
    }

    // Complete any pending operations
    for (const operation of context.operations) {
      if (operation.status === 'pending') {
        this.completeOperation(operation.id, 'error', undefined, new Error('Context destroyed'));
      }
    }

    // Remove from parent's children
    if (context.parent && this.contexts.has(context.parent)) {
      const parent = this.contexts.get(context.parent)!;
      const index = parent.children.indexOf(contextId);
      if (index !== -1) {
        parent.children.splice(index, 1);
      }
    }

    this.contexts.delete(contextId);
    this.logger.destroyContext(contextId, reason);
    this.logger.logMethodExit(
      'DebugContextTracker',
      'destroyContext',
      undefined,
      Date.now() - context.startTime
    );
  }

  // Operation tracking
  startOperation(contextId: string, name: string, metadata: Record<string, unknown> = {}): string {
    const context = this.contexts.get(contextId);
    if (!context) {
      this.logger.warn(`Context ${contextId} not found for operation ${name}`);
      return '';
    }

    const operationId = `op_${++this.operationCounter}_${Date.now()}`;
    const operation: DebugOperation = {
      id: operationId,
      name,
      startTime: Date.now(),
      status: 'pending',
      metadata: { ...metadata },
    };

    this.operations.set(operationId, operation);
    context.operations.push(operation);

    this.logger.logAsyncOperation(name, 'start', { operationId, contextId, metadata });

    return operationId;
  }

  completeOperation(
    operationId: string,
    status: 'success' | 'error',
    result?: unknown,
    error?: Error
  ): void {
    const operation = this.operations.get(operationId);
    if (!operation) {
      this.logger.warn(`Operation ${operationId} not found for completion`);
      return;
    }

    operation.endTime = Date.now();
    operation.status = status;
    operation.result = result;
    operation.error = error;

    const duration = operation.endTime - operation.startTime;
    this.logger.logAsyncOperation(operation.name, status === 'success' ? 'complete' : 'error', {
      operationId,
      duration,
      result: result ? 'present' : 'none',
      error: error?.message,
    });

    if (status === 'error' && error) {
      this.logger.logError(error, { operationId, operationName: operation.name });
    }
  }

  // Information retrieval
  getContext(contextId: string): DebugContext | undefined {
    return this.contexts.get(contextId);
  }

  getOperation(operationId: string): DebugOperation | undefined {
    return this.operations.get(operationId);
  }

  getAllContexts(): DebugContext[] {
    return Array.from(this.contexts.values());
  }

  getActiveOperations(): DebugOperation[] {
    return Array.from(this.operations.values()).filter(op => op.status === 'pending');
  }

  getContextTree(rootContextId?: string): DebugContext[] {
    const roots = rootContextId
      ? ([this.contexts.get(rootContextId)].filter(Boolean) as DebugContext[])
      : Array.from(this.contexts.values()).filter(ctx => !ctx.parent);

    return roots;
  }

  // Debugging utilities
  createSnapshot(): DebugSnapshot {
    return {
      timestamp: Date.now(),
      contexts: this.getAllContexts(),
      systemInfo: {
        memory: process.memoryUsage(),
        uptime: process.uptime(),
        platform: process.platform,
        nodeVersion: process.version,
      },
      activeOperations: this.getActiveOperations().length,
      totalOperations: this.operations.size,
    };
  }

  logSnapshot(contextId?: string): void {
    const snapshot = this.createSnapshot();
    const context = contextId ? this.getContext(contextId) : undefined;

    this.logger.debug(
      'Debug snapshot',
      {
        snapshot: {
          ...snapshot,
          contexts: context ? [context] : snapshot.contexts.length,
        },
      },
      'debug-snapshot'
    );
  }

  // Performance monitoring
  measurePerformance<T>(
    contextId: string,
    operationName: string,
    fn: () => T | Promise<T>
  ): T | Promise<T> {
    const operationId = this.startOperation(contextId, operationName);
    const startTime = Date.now();

    try {
      const result = fn();

      if (result instanceof Promise) {
        return result
          .then(value => {
            this.completeOperation(operationId, 'success', value);
            this.logger.logPerformance(operationName, Date.now() - startTime);
            return value;
          })
          .catch(error => {
            this.completeOperation(operationId, 'error', undefined, error);
            throw error;
          });
      } else {
        this.completeOperation(operationId, 'success', result);
        this.logger.logPerformance(operationName, Date.now() - startTime);
        return result;
      }
    } catch (error) {
      this.completeOperation(operationId, 'error', undefined, error as Error);
      throw error;
    }
  }

  // Cleanup
  cleanup(): void {
    const activeContexts = Array.from(this.contexts.keys());
    for (const contextId of activeContexts) {
      this.destroyContext(contextId, 'cleanup');
    }

    this.operations.clear();
    this.logger.info('Debug context tracker cleaned up', {
      destroyedContexts: activeContexts.length,
      timestamp: Date.now(),
    });
  }
}

// Global instance for convenience
export const globalDebugTracker = new DebugContextTracker();
