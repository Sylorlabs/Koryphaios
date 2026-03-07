// Memory Management and Cleanup
// Domain: Centralized cleanup orchestration, memory leak prevention, resource disposal

import { serverLog } from "../logger";

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface CleanupHook {
  name: string;
  priority: number; // Lower = runs first (0-100)
  cleanup: () => void | Promise<void>;
}

export interface MemoryStats {
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
}

// ─── Cleanup Registry ───────────────────────────────────────────────────────────

/**
 * Central registry for cleanup hooks.
 * Ensures all resources are properly disposed on shutdown.
 */
class CleanupRegistry {
  private hooks = new Map<string, CleanupHook>();
  private isShuttingDown = false;

  register(hook: CleanupHook): void {
    this.hooks.set(hook.name, hook);
    serverLog.debug({ hook: hook.name, priority: hook.priority }, "Cleanup hook registered");
  }

  unregister(name: string): void {
    this.hooks.delete(name);
  }

  /**
   * Execute all cleanup hooks in priority order.
   * Critical resources (low priority) are cleaned up first.
   */
  async shutdown(): Promise<void> {
    if (this.isShuttingDown) {
      serverLog.warn("Shutdown already in progress");
      return;
    }

    this.isShuttingDown = true;
    serverLog.info({ hooksCount: this.hooks.size }, "Starting cleanup shutdown");

    // Sort by priority (lower = first)
    const sortedHooks = Array.from(this.hooks.values()).sort((a, b) => a.priority - b.priority);

    for (const hook of sortedHooks) {
      try {
        serverLog.debug({ hook: hook.name }, "Running cleanup hook");
        await Promise.resolve(hook.cleanup());
      } catch (err) {
        serverLog.error({ err, hook: hook.name }, "Cleanup hook failed");
      }
    }

    this.hooks.clear();
    serverLog.info("Cleanup shutdown complete");
  }

  getHooks(): CleanupHook[] {
    return Array.from(this.hooks.values());
  }
}

// ─── Memory Monitor ─────────────────────────────────────────────────────────────

/**
 * Memory usage monitoring with configurable thresholds.
 */
class MemoryMonitor {
  private checkInterval: Timer | null = null;
  private lastAlertTime = 0;
  private readonly ALERT_COOLDOWN_MS = 60000; // 1 minute
  private readonly WARNING_THRESHOLD = 0.75; // 75%
  private readonly CRITICAL_THRESHOLD = 0.90; // 90%

  constructor(
    private getStats: () => MemoryStats,
    private onMemoryPressure: (level: "warning" | "critical", stats: MemoryStats) => void
  ) {}

  start(intervalMs = 30000): void {
    if (this.checkInterval) return;

    this.checkInterval = setInterval(() => {
      try {
        this.checkMemory();
      } catch (err) {
        serverLog.error(err, "Memory check failed");
      }
    }, intervalMs);

    serverLog.debug({ intervalMs }, "Memory monitor started");
  }

  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
      serverLog.debug("Memory monitor stopped");
    }
  }

  private checkMemory(): void {
    const stats = this.getStats();
    const usage = stats.nodeHeap.percentage;

    // Check warning threshold
    if (usage >= this.WARNING_THRESHOLD && usage < this.CRITICAL_THRESHOLD) {
      const now = Date.now();
      if (now - this.lastAlertTime >= this.ALERT_COOLDOWN_MS) {
        this.lastAlertTime = now;
        serverLog.warn(
          { usage: `${usage.toFixed(1)}%`, used: stats.nodeHeap.used, total: stats.nodeHeap.total },
          "High memory usage detected"
        );
        this.onMemoryPressure("warning", stats);
      }
    }

    // Check critical threshold
    if (usage >= this.CRITICAL_THRESHOLD) {
      const now = Date.now();
      if (now - this.lastAlertTime >= this.ALERT_COOLDOWN_MS) {
        this.lastAlertTime = now;
        serverLog.error(
          { usage: `${usage.toFixed(1)}%`, used: stats.nodeHeap.used, total: stats.nodeHeap.total },
          "Critical memory usage detected"
        );
        this.onMemoryPressure("critical", stats);
      }
    }
  }

  forceGC(): void {
    // Force garbage collection if --expose-gc is enabled
    if (typeof global.gc === "function") {
      const before = this.getStats().nodeHeap.used;
      global.gc();
      const after = this.getStats().nodeHeap.used;
      const freed = before - after;
      serverLog.info(
        { before, after, freed: `${((freed / before) * 100).toFixed(2)}%` },
        "Forced garbage collection"
      );
    } else {
      serverLog.debug("--expose-gc not enabled, cannot force GC");
    }
  }
}

// ─── Session Tracker ────────────────────────────────────────────────────────────

/**
 * Track active sessions and trigger cleanup for abandoned ones.
 */
class SessionTracker {
  private activeSessions = new Map<string, { lastActivity: number; data: Record<string, unknown> }>();
  private cleanupInterval: Timer | null = null;
  private readonly SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

  register(sessionId: string, data: Record<string, unknown> = {}): void {
    this.activeSessions.set(sessionId, {
      lastActivity: Date.now(),
      data,
    });
  }

  updateActivity(sessionId: string): void {
    const session = this.activeSessions.get(sessionId);
    if (session) {
      session.lastActivity = Date.now();
    }
  }

  unregister(sessionId: string): void {
    this.activeSessions.delete(sessionId);
  }

  getActiveCount(): number {
    return this.activeSessions.size;
  }

  getSessionIds(): string[] {
    return Array.from(this.activeSessions.keys());
  }

  /**
   * Start periodic cleanup of abandoned sessions.
   */
  startCleanup(intervalMs = 5 * 60 * 1000): void {
    if (this.cleanupInterval) return;

    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      const toRemove: string[] = [];

      for (const [id, session] of this.activeSessions) {
        const idleTime = now - session.lastActivity;
        if (idleTime > this.SESSION_TIMEOUT_MS) {
          toRemove.push(id);
        }
      }

      if (toRemove.length > 0) {
        serverLog.info(
          { count: toRemove.length, sessions: toRemove },
          "Cleaning up abandoned sessions"
        );
        for (const id of toRemove) {
          this.activeSessions.delete(id);
        }
      }
    }, intervalMs);

    serverLog.debug({ intervalMs }, "Session cleanup started");
  }

  stopCleanup(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
      serverLog.debug("Session cleanup stopped");
    }
  }

  clear(): void {
    this.activeSessions.clear();
  }
}

// ─── Singleton Instances ────────────────────────────────────────────────────────

export const cleanupRegistry = new CleanupRegistry();
export const sessionTracker = new SessionTracker();

let memoryMonitorInstance: MemoryMonitor | null = null;

/**
 * Initialize memory monitoring with stats collector.
 */
export function initMemoryMonitor(
  getStats: () => MemoryStats,
  onMemoryPressure: (level: "warning" | "critical", stats: MemoryStats) => void
): MemoryMonitor {
  if (memoryMonitorInstance) {
    memoryMonitorInstance.stop();
  }

  memoryMonitorInstance = new MemoryMonitor(getStats, onMemoryPressure);
  memoryMonitorInstance.start();

  return memoryMonitorInstance;
}

export function getMemoryMonitor(): MemoryMonitor | null {
  return memoryMonitorInstance;
}

// ─── Memory Response Handler ─────────────────────────────────────────────────────

/**
 * Default memory pressure handler.
 * - Warning: Log and optionally force GC
 * - Critical: Log, force GC, and optionally trigger gentle cleanup
 */
export function createDefaultMemoryPressureHandler(): (
  level: "warning" | "critical",
  stats: MemoryStats
) => void {
  return (level: "warning" | "critical", stats: MemoryStats) => {
    // Force GC if available
    if (typeof global.gc === "function") {
      global.gc();
    }

    // For critical pressure, we could trigger more aggressive cleanup
    if (level === "critical") {
      serverLog.warn(
        {
          activeSessions: stats.resources.activeSessions,
          pendingInputs: stats.resources.pendingInputs,
        },
        "Critical memory pressure: consider session cleanup"
      );
    }
  };
}

// ─── Utility Functions ───────────────────────────────────────────────────────────

/**
 * Get current Node.js heap memory statistics.
 */
export function getHeapStats(): MemoryStats["nodeHeap"] {
  const mem = process.memoryUsage();
  const total = mem.heapTotal;
  const used = mem.heapUsed;
  const limit = mem.heapTotal || 2147483648; // Default 2GB limit if not available
  const percentage = (used / total) * 100;

  return {
    total,
    used,
    limit,
    percentage,
  };
}

/**
 * Create a cleanup hook that runs a function and logs errors.
 */
export function createCleanupHook(
  name: string,
  priority: number,
  cleanup: () => void | Promise<void>
): CleanupHook {
  return {
    name,
    priority,
    cleanup: async () => {
      try {
        await Promise.resolve(cleanup());
      } catch (err) {
        serverLog.error({ err, hook: name }, "Cleanup failed");
        throw err; // Re-throw to ensure it's logged by registry
      }
    },
  };
}

/**
 * Safe cleanup that catches and logs errors.
 */
export async function safeCleanup(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await Promise.resolve(fn());
  } catch (err) {
    serverLog.error({ err, cleanup: name }, "Cleanup failed");
  }
}

// ─── Shutdown Signal Handlers ───────────────────────────────────────────────────

/**
 * Register signal handlers for graceful shutdown.
 */
export function registerShutdownHandlers(): void {
  const shutdown = async (signal: string) => {
    serverLog.info({ signal }, "Received shutdown signal");
    try {
      await cleanupRegistry.shutdown();
      serverLog.info("Graceful shutdown complete");
    } catch (err) {
      serverLog.error(err, "Shutdown failed");
      process.exit(1);
    }
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  serverLog.debug("Shutdown signal handlers registered");
}
