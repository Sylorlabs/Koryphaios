// Memory Management Module
// Domain: Memory leak prevention, resource cleanup, monitoring

// Export all cleanup utilities
export {
  cleanupRegistry,
  sessionTracker,
  initMemoryMonitor,
  getMemoryMonitor,
  createDefaultMemoryPressureHandler,
  registerShutdownHandlers,
  getHeapStats,
  createCleanupHook,
  safeCleanup,
} from "./cleanup";

// Export background cleanup service
export {
  BackgroundCleanupService,
  startBackgroundCleanup,
} from "./background-cleanup";

// Export types
export type { CleanupHook, MemoryStats } from "./cleanup";
export type { BackgroundCleanupConfig } from "./background-cleanup";
