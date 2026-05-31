/**
 * Tests for DebugContextTracker utility
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DebugContextTracker } from '../../../src/utils/debug-context.js';
import { Logger } from '../../../src/utils/logger.js';

describe('DebugContextTracker', () => {
  let tracker: DebugContextTracker;
  let mockLogger: Logger;

  beforeEach(() => {
    mockLogger = {
      createContext: vi.fn(),
      updateContext: vi.fn(),
      destroyContext: vi.fn(),
      logMethodEntry: vi.fn(),
      logMethodExit: vi.fn(),
      logAsyncOperation: vi.fn(),
      logError: vi.fn(),
      logPerformance: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    } as any;

    tracker = new DebugContextTracker(mockLogger);
  });

  describe('Constructor', () => {
    it('should create tracker with provided logger', () => {
      const customTracker = new DebugContextTracker(mockLogger);
      expect(customTracker).toBeDefined();
    });

    it('should create tracker with default logger when none provided', () => {
      const defaultTracker = new DebugContextTracker();
      expect(defaultTracker).toBeDefined();
    });
  });

  describe('Context Management', () => {
    it('should create a new context', () => {
      const metadata = { test: 'value' };
      const contextId = tracker.createContext('test-type', metadata);

      expect(contextId).toMatch(/^ctx_\d+_[a-z0-9]+$/);
      expect(mockLogger.createContext).toHaveBeenCalledWith(contextId, 'test-type', metadata);
      expect(mockLogger.logMethodEntry).toHaveBeenCalledWith(
        'DebugContextTracker',
        'createContext',
        { id: contextId, type: 'test-type', parentId: undefined }
      );
    });

    it('should create context with parent relationship', () => {
      const parentId = tracker.createContext('parent-type');
      const childId = tracker.createContext('child-type', {}, parentId);

      expect(childId).toBeDefined();
      expect(mockLogger.createContext).toHaveBeenCalledTimes(2);
    });

    it('should update context metadata', () => {
      const contextId = tracker.createContext('test-type');
      const updates = { newField: 'newValue' };

      tracker.updateContext(contextId, updates);

      expect(mockLogger.updateContext).toHaveBeenCalledWith(contextId, updates);
    });

    it('should warn when updating non-existent context', () => {
      tracker.updateContext('non-existent', { test: 'value' });

      expect(mockLogger.warn).toHaveBeenCalledWith('Context non-existent not found for update');
    });

    it('should destroy context and its children', () => {
      const parentId = tracker.createContext('parent');
      const childId = tracker.createContext('child', {}, parentId);

      tracker.destroyContext(parentId, 'test reason');

      expect(mockLogger.destroyContext).toHaveBeenCalledWith(childId, 'parent destroyed');
      expect(mockLogger.destroyContext).toHaveBeenCalledWith(parentId, 'test reason');
    });

    it('should warn when destroying non-existent context', () => {
      tracker.destroyContext('non-existent');

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Context non-existent not found for destruction'
      );
    });
  });

  describe('Operation Tracking', () => {
    it('should start operation in existing context', () => {
      const contextId = tracker.createContext('test-type');
      const metadata = { operation: 'test' };

      const operationId = tracker.startOperation(contextId, 'test-operation', metadata);

      expect(operationId).toMatch(/^op_\d+_\d+$/);
      expect(mockLogger.logAsyncOperation).toHaveBeenCalledWith('test-operation', 'start', {
        operationId,
        contextId,
        metadata,
      });
    });

    it('should warn when starting operation in non-existent context', () => {
      const operationId = tracker.startOperation('non-existent', 'test-operation');

      expect(operationId).toBe('');
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Context non-existent not found for operation test-operation'
      );
    });

    it('should complete operation successfully', () => {
      const contextId = tracker.createContext('test-type');
      const operationId = tracker.startOperation(contextId, 'test-operation');
      const result = { success: true };

      tracker.completeOperation(operationId, 'success', result);

      // Check the second call (completion call)
      expect(mockLogger.logAsyncOperation).toHaveBeenNthCalledWith(
        2,
        'test-operation',
        'complete',
        expect.objectContaining({
          operationId,
          duration: expect.any(Number),
          result: 'present',
        })
      );
    });

    it('should complete operation with error', () => {
      const contextId = tracker.createContext('test-type');
      const operationId = tracker.startOperation(contextId, 'test-operation');
      const error = new Error('Test error');

      tracker.completeOperation(operationId, 'error', undefined, error);

      // Check the second call (completion call)
      expect(mockLogger.logAsyncOperation).toHaveBeenNthCalledWith(
        2,
        'test-operation',
        'error',
        expect.objectContaining({
          operationId,
          duration: expect.any(Number),
          result: 'none',
          error: 'Test error',
        })
      );
    });

    it('should warn when completing non-existent operation', () => {
      tracker.completeOperation('non-existent', 'success');

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Operation non-existent not found for completion'
      );
    });
  });

  describe('Context Retrieval', () => {
    it('should get context by id', () => {
      const contextId = tracker.createContext('test-type', { test: 'value' });

      const context = tracker.getContext(contextId);

      expect(context).toBeDefined();
      expect(context?.id).toBe(contextId);
      expect(context?.type).toBe('test-type');
      expect(context?.metadata.test).toBe('value');
    });

    it('should return undefined for non-existent context', () => {
      const context = tracker.getContext('non-existent');

      expect(context).toBeUndefined();
    });

    it('should get all contexts', () => {
      const id1 = tracker.createContext('type1');
      const id2 = tracker.createContext('type2');

      const contexts = tracker.getAllContexts();

      expect(contexts).toHaveLength(2);
      expect(contexts.map(c => c.id)).toContain(id1);
      expect(contexts.map(c => c.id)).toContain(id2);
    });

    it('should get context tree', () => {
      const parentId = tracker.createContext('parent');
      const childId = tracker.createContext('child', {}, parentId);

      const tree = tracker.getContextTree();

      expect(tree).toHaveLength(1);
      expect(tree[0].id).toBe(parentId);
    });
  });

  describe('Operation Retrieval', () => {
    it('should get operation by id', () => {
      const contextId = tracker.createContext('test-type');
      const operationId = tracker.startOperation(contextId, 'test-operation');

      const operation = tracker.getOperation(operationId);

      expect(operation).toBeDefined();
      expect(operation?.id).toBe(operationId);
      expect(operation?.name).toBe('test-operation');
      expect(operation?.status).toBe('pending');
    });

    it('should return undefined for non-existent operation', () => {
      const operation = tracker.getOperation('non-existent');

      expect(operation).toBeUndefined();
    });

    it('should get active operations', () => {
      const contextId = tracker.createContext('test-type');
      const op1 = tracker.startOperation(contextId, 'op1');
      const op2 = tracker.startOperation(contextId, 'op2');
      tracker.completeOperation(op1, 'success');

      const activeOps = tracker.getActiveOperations();

      expect(activeOps).toHaveLength(1);
      expect(activeOps[0].id).toBe(op2);
    });
  });

  describe('Snapshot Generation', () => {
    it('should create debug snapshot', () => {
      const contextId = tracker.createContext('test-type');
      const operationId = tracker.startOperation(contextId, 'test-operation');

      const snapshot = tracker.createSnapshot();

      expect(snapshot).toBeDefined();
      expect(snapshot.timestamp).toBeGreaterThan(0);
      expect(snapshot.contexts).toHaveLength(1);
      expect(snapshot.systemInfo).toBeDefined();
      expect(snapshot.systemInfo.memory).toBeDefined();
      expect(snapshot.systemInfo.uptime).toBeGreaterThan(0);
      expect(snapshot.systemInfo.platform).toBeDefined();
      expect(snapshot.systemInfo.nodeVersion).toBeDefined();
      expect(snapshot.activeOperations).toBe(1);
      expect(snapshot.totalOperations).toBe(1);
    });
  });

  describe('Performance Measurement', () => {
    it('should measure synchronous function performance', () => {
      const contextId = tracker.createContext('test-type');
      const testFn = vi.fn(() => 'result');

      const result = tracker.measurePerformance(contextId, 'test-operation', testFn);

      expect(result).toBe('result');
      expect(testFn).toHaveBeenCalled();
    });

    it('should measure asynchronous function performance', async () => {
      const contextId = tracker.createContext('test-type');
      const testFn = vi.fn(async () => 'async-result');

      const result = await tracker.measurePerformance(contextId, 'test-async-operation', testFn);

      expect(result).toBe('async-result');
      expect(testFn).toHaveBeenCalled();
    });

    it('should handle synchronous function errors', () => {
      const contextId = tracker.createContext('test-type');
      const error = new Error('Test error');
      const testFn = vi.fn(() => {
        throw error;
      });

      expect(() => tracker.measurePerformance(contextId, 'test-operation', testFn)).toThrow(error);
    });

    it('should handle asynchronous function errors', async () => {
      const contextId = tracker.createContext('test-type');
      const error = new Error('Async test error');
      const testFn = vi.fn(async () => {
        throw error;
      });

      await expect(
        tracker.measurePerformance(contextId, 'test-async-operation', testFn)
      ).rejects.toThrow(error);
    });
  });

  describe('Logging', () => {
    it('should log snapshot', () => {
      const contextId = tracker.createContext('test-type');

      tracker.logSnapshot(contextId);

      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Debug snapshot',
        expect.objectContaining({
          snapshot: expect.any(Object),
        }),
        'debug-snapshot'
      );
    });

    it('should log snapshot without specific context', () => {
      tracker.createContext('test-type');

      tracker.logSnapshot();

      expect(mockLogger.debug).toHaveBeenCalled();
    });
  });

  describe('Cleanup', () => {
    it('should cleanup all contexts and operations', () => {
      tracker.createContext('type1');
      tracker.createContext('type2');

      tracker.cleanup();

      const contexts = tracker.getAllContexts();
      expect(contexts).toHaveLength(0);
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Debug context tracker cleaned up',
        expect.objectContaining({
          destroyedContexts: 2,
          timestamp: expect.any(Number),
        })
      );
    });
  });

  describe('Global Instance', () => {
    it('should export global debug tracker', async () => {
      const { globalDebugTracker } = await import('../../../src/utils/debug-context.js');
      expect(globalDebugTracker).toBeDefined();
      expect(globalDebugTracker).toBeInstanceOf(DebugContextTracker);
    });
  });
});
