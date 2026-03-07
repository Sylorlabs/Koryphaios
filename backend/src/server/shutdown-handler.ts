// Shutdown Handler
// Domain: Graceful shutdown sequence and resource cleanup
// Extracted from server.ts lines 1332-1398

import type { Server } from "bun";
import type { KoryManager } from "../kory/manager";
import type { WSManager } from "../ws/ws-manager";
import { shutdownAllBrokers } from "../pubsub";
import { messagingGateway, stopCreditPolling } from "../messaging";
import type { RateLimiter } from "../security/rate-limit";
import { serverLog } from "../logger";

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface ShutdownHandlerDependencies {
  server: Server;
  kory: KoryManager;
  wsManager: WSManager;
  rateLimiter: RateLimiter;
}

// ─── Shutdown Handler Class ─────────────────────────────────────────────────────

export class ShutdownHandler {
  private server: Server;
  private kory: KoryManager;
  private wsManager: WSManager;
  private rateLimiter: RateLimiter;
  private isShuttingDown = false;

  constructor(deps: ShutdownHandlerDependencies) {
    this.server = deps.server;
    this.kory = deps.kory;
    this.wsManager = deps.wsManager;
    this.rateLimiter = deps.rateLimiter;
  }

  /**
   * Perform graceful shutdown sequence.
   *
   * @param signal - Shutdown signal (SIGTERM, SIGINT, etc.)
   */
  async gracefulShutdown(signal: string): Promise<void> {
    if (this.isShuttingDown) {
      serverLog.warn("Shutdown already in progress, forcing exit");
      process.exit(1);
    }

    this.isShuttingDown = true;
    serverLog.info({ signal }, "Received shutdown signal, starting graceful shutdown");

    try {
      // 1. Notify WebSocket clients of impending shutdown
      this.wsManager.broadcast({
        type: "system.info",
        payload: { message: "Server shutting down gracefully" },
        timestamp: Date.now(),
      });
      serverLog.info("Notified WebSocket clients of shutdown");

      // 2. Stop accepting new connections (but let existing requests complete)
      this.server.stop(true);
      serverLog.info("Server stopped accepting new connections");

      // 3. Wait for in-flight requests to complete (grace period)
      await this.delay(2000);

      // 4. Shutdown WebSocket manager (closes all connections)
      this.wsManager.shutdown();
      serverLog.info("WebSocket manager shut down");

      // 5. Shutdown KoryManager (cancels all agents, cleans up sessions)
      this.kory.shutdown();
      serverLog.info("KoryManager shut down");

      // 6. Shutdown all pub/sub brokers (cleans up subscribers)
      shutdownAllBrokers();
      serverLog.info("All pub/sub brokers shut down");

      // 7. Stop messaging gateway
      messagingGateway.stop();
      serverLog.info("Messaging gateway stopped");

      // 8. Stop credit polling timer
      stopCreditPolling();
      serverLog.info("Credit polling stopped");

      // 9. Clean up rate limiter (close Redis connections)
      this.rateLimiter.destroy();
      serverLog.info("Rate limiter cleaned up");

      serverLog.info("Graceful shutdown complete");
      process.exit(0);
    } catch (err) {
      serverLog.error(err, "Error during graceful shutdown");
      process.exit(1);
    }
  }

  /**
   * Register signal handlers for graceful shutdown.
   */
  registerSignalHandlers(): void {
    process.on("SIGTERM", () => this.gracefulShutdown("SIGTERM"));
    process.on("SIGINT", () => this.gracefulShutdown("SIGINT"));
  }

  /**
   * Register error handlers for uncaught errors and rejections.
   */
  registerErrorHandlers(): void {
    process.on("uncaughtException", (err) => {
      serverLog.fatal(err, "Uncaught exception");
      this.gracefulShutdown("uncaughtException");
    });

    process.on("unhandledRejection", (reason) => {
      serverLog.error({ reason }, "Unhandled promise rejection (server will continue)");
    });
  }

  /**
   * Helper to delay execution.
   *
   * @param ms - Milliseconds to delay
   * @returns Promise that resolves after delay
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ─── Convenience Function ────────────────────────────────────────────────────────

/**
 * Setup shutdown handlers for a server instance.
 *
 * @param deps - Shutdown handler dependencies
 * @returns ShutdownHandler instance
 */
export function setupShutdownHandlers(deps: ShutdownHandlerDependencies): ShutdownHandler {
  const handler = new ShutdownHandler(deps);
  handler.registerSignalHandlers();
  handler.registerErrorHandlers();
  return handler;
}
