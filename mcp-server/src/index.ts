#!/usr/bin/env node

/**
 * Main entry point for the Koryphaios MCP Server
 * Provides AI agents with error detection, debugging, and console log monitoring
 */

import { KoryphaiosMCPServer } from './server/mcp-server.js';
import { ConfigManager } from './utils/config-manager.js';
import { Logger } from './utils/logger.js';

async function main(): Promise<void> {
  try {
    // Initialize configuration
    const configManager = new ConfigManager();
    const config = await configManager.loadConfig();

    // Initialize logger - completely disable logging for MCP mode to avoid protocol interference
    const logger = new Logger(config.server.logLevel, {
      enableConsole: false, // Always disable console logging to avoid MCP protocol interference
      enableFile: false, // Disable file logging too for now
      logFile: undefined,
    });

    // Only log to stderr in development mode with TTY
    if (process.env['NODE_ENV'] === 'development' && process.stdin.isTTY) {
      process.stderr.write(`Starting Koryphaios MCP Server ${config.server.version}\n`);
    }

    // Create and start server
    const server = new KoryphaiosMCPServer(config, logger);

    // Set up error handling
    server.on('server:error', (error: Error) => {
      logger.error('Server error:', error);
    });

    server.on('server:started', (info: any) => {
      logger.info('Server started successfully', info);
    });

    server.on('server:stopped', () => {
      logger.info('Server stopped');
    });

    // Handle process signals
    process.on('SIGINT', async () => {
      logger.info('Received SIGINT, shutting down gracefully...');
      await server.stop();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      logger.info('Received SIGTERM, shutting down gracefully...');
      await server.stop();
      process.exit(0);
    });

    process.on('uncaughtException', error => {
      logger.error('Uncaught exception:', error);
      process.exit(1);
    });

    process.on('unhandledRejection', (reason, promise) => {
      logger.error('Unhandled rejection', { promise, reason });
      process.exit(1);
    });

    // Start the server
    await server.start();
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Run the server
main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});

