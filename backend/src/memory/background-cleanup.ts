// Background Cleanup Service
// Domain: Periodic cleanup of abandoned resources to prevent memory leaks

import type { KoryManager } from '../kory/manager';
import type { WSManager } from '../ws/ws-manager';
import {
  sessionTracker,
  initMemoryMonitor,
  getMemoryMonitor,
  getHeapStats,
  createDefaultMemoryPressureHandler,
} from './cleanup';
import { getTotalBrokerSubscribers } from '../pubsub';
import { serverLog } from '../logger';

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface BackgroundCleanupConfig {
  /** Interval between cleanup runs (default: 5 minutes) */
  cleanupIntervalMs?: number;
  /** Interval between memory monitoring checks (default: 30 seconds) */
  memoryCheckIntervalMs?: number;
  /** Whether to enable automatic GC on memory pressure (default: true) */
  autoGC?: boolean;
  /** Checkpoint retention period in days. Checkpoints older than this are pruned. @default 30 */
  checkpointRetentionDays?: number;
  /** Interval between git resource prune runs (default: 1 hour). Pruning
   *  scans checkpoint refs, so it runs less frequently than session cleanup. */
  pruneIntervalMs?: number;
}

// ─── Background Cleanup Service ───────────────────────────────────────────────────

export class BackgroundCleanupService {
  private cleanupInterval: Timer | null = null;
  private pruneInterval: Timer | null = null;
  private isRunning = false;
  private config: Required<BackgroundCleanupConfig>;

  constructor(
    private kory: KoryManager,
    private wsManager: WSManager,
    config: BackgroundCleanupConfig = {},
  ) {
    this.config = {
      cleanupIntervalMs: config.cleanupIntervalMs ?? 5 * 60 * 1000, // 5 minutes
      memoryCheckIntervalMs: config.memoryCheckIntervalMs ?? 30 * 1000, // 30 seconds
      autoGC: config.autoGC ?? true,
      checkpointRetentionDays: config.checkpointRetentionDays ?? 30,
      pruneIntervalMs: config.pruneIntervalMs ?? 60 * 60 * 1000, // 1 hour
    };
  }

  /**
   * Start the background cleanup service.
   */
  start(): void {
    if (this.isRunning) {
      serverLog.warn('Background cleanup service already running');
      return;
    }

    this.isRunning = true;

    // Start session tracker cleanup
    sessionTracker.startCleanup(this.config.cleanupIntervalMs);

    // Start memory monitoring
    initMemoryMonitor(() => this.getMemoryStats(), createDefaultMemoryPressureHandler());

    // Start periodic resource cleanup (session cleanup — every 5 min)
    this.cleanupInterval = setInterval(() => {
      this.performCleanup();
    }, this.config.cleanupIntervalMs);

    // Start periodic git resource pruning (checkpoint/worktree refs — every 1 hour).
    // Runs on a slower interval because it scans git refs, which is more expensive
    // than the in-memory session cleanup.
    this.pruneInterval = setInterval(() => {
      void this.kory.pruneResources(this.config.checkpointRetentionDays).catch((err) => {
        serverLog.warn({ err: err instanceof Error ? err.message : String(err) }, 'Periodic prune failed');
      });
    }, this.config.pruneIntervalMs);

    serverLog.info(
      {
        cleanupInterval: `${this.config.cleanupIntervalMs / 1000}s`,
        pruneInterval: `${this.config.pruneIntervalMs / 1000}s`,
        memoryCheckInterval: `${this.config.memoryCheckIntervalMs / 1000}s`,
      },
      'Background cleanup service started',
    );
  }

  /**
   * Stop the background cleanup service.
   */
  stop(): void {
    if (!this.isRunning) return;

    this.isRunning = false;

    // Stop cleanup interval
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    // Stop prune interval
    if (this.pruneInterval) {
      clearInterval(this.pruneInterval);
      this.pruneInterval = null;
    }

    // Stop session tracker
    sessionTracker.stopCleanup();

    // Stop memory monitor
    const monitor = getMemoryMonitor();
    if (monitor) {
      monitor.stop();
    }

    serverLog.info('Background cleanup service stopped');
  }

  /**
   * Perform a one-time cleanup run.
   * Can be called manually to trigger immediate cleanup.
   */
  performCleanup(): void {
    try {
      const beforeStats = this.getMemoryStats();

      // Cleanup abandoned resources in KoryManager
      this.kory.cleanupAbandonedResources();

      // A process can lose a claimed answered-question handoff without the
      // backend itself restarting (for example, a provider stack crashes while
      // the server remains alive). Periodically requeue expired leases so the
      // durable command does not depend on another deployment to make progress.
      void this.kory.recoverDurableQuestionHandoffs().catch((err) => {
        serverLog.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'Durable answered-question handoff recovery failed',
        );
      });

      // Note: git resource pruning (worktree refs, old checkpoints) runs on
      // a separate slower interval (pruneIntervalMs, default 1h) via
      // pruneInterval — see start(). It's not triggered here because it
      // scans git refs, which is more expensive than in-memory cleanup.

      // Get memory stats after cleanup
      const afterStats = this.getMemoryStats();

      serverLog.debug(
        {
          before: {
            heapUsed: `${(beforeStats.nodeHeap.used / 1024 / 1024).toFixed(2)}MB`,
            activeSessions: beforeStats.resources.activeSessions,
          },
          after: {
            heapUsed: `${(afterStats.nodeHeap.used / 1024 / 1024).toFixed(2)}MB`,
            activeSessions: afterStats.resources.activeSessions,
          },
          freed: `${((beforeStats.nodeHeap.used - afterStats.nodeHeap.used) / 1024 / 1024).toFixed(2)}MB`,
        },
        'Background cleanup completed',
      );
    } catch (err) {
      serverLog.error(err, 'Background cleanup failed');
    }
  }

  /**
   * Get current memory statistics.
   */
  getMemoryStats(): {
    nodeHeap: {
      total: number;
      used: number;
      limit: number;
      percentage: number;
    };
    resources: {
      activeSessions: number;
      pendingInputs: number;
      websocketClients: number;
      brokerSubscribers: number;
    };
  } {
    const koryStats = this.kory.getMemoryStats();
    const heap = getHeapStats();

    return {
      nodeHeap: heap,
      resources: {
        activeSessions: koryStats.activeWorkers,
        pendingInputs: koryStats.pendingUserInputs,
        websocketClients: this.wsManager.clientCount,
        brokerSubscribers: getTotalBrokerSubscribers(),
      },
    };
  }

  /**
   * Force garbage collection (if --expose-gc is enabled).
   */
  forceGC(): void {
    if (typeof global.gc === 'function') {
      const before = this.getMemoryStats();
      global.gc();
      const after = this.getMemoryStats();
      const freed = before.nodeHeap.used - after.nodeHeap.used;
      serverLog.info(
        {
          before: `${(before.nodeHeap.used / 1024 / 1024).toFixed(2)}MB`,
          after: `${(after.nodeHeap.used / 1024 / 1024).toFixed(2)}MB`,
          freed: `${(freed / 1024 / 1024).toFixed(2)}MB`,
        },
        'Forced garbage collection',
      );
    } else {
      serverLog.warn('--expose-gc not enabled, cannot force GC');
    }
  }
}

// ─── Convenience Function ────────────────────────────────────────────────────────

/**
 * Create and start a background cleanup service.
 *
 * @param kory - KoryManager instance
 * @param wsManager - WSManager instance
 * @param config - Cleanup configuration
 * @returns BackgroundCleanupService instance
 */
export function startBackgroundCleanup(
  kory: KoryManager,
  wsManager: WSManager,
  config?: BackgroundCleanupConfig,
): BackgroundCleanupService {
  const service = new BackgroundCleanupService(kory, wsManager, config);
  service.start();
  return service;
}
