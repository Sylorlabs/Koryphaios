#!/usr/bin/env node

/**
 * Main entry point for the Koryphaios MCP Server
 * Provides AI agents with error detection, debugging, and console log monitoring
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Server } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { KoryphaiosMCPServer } from './server/mcp-server.js';
import { ConfigManager } from './utils/config-manager.js';
import { Logger } from './utils/logger.js';

/**
 * Detects whether Koryphaios is active (orchestrated/invoked within Koryphaios context)
 * or if the user is running a CLI tool natively from their terminal.
 */
export function isKoryphaiosActive(): boolean {
  // Explicit activation flags
  if (
    process.env['KORYPHAIOS_ACTIVE'] === '1' ||
    process.env['KORYPHAIOS_ACTIVE'] === 'true' ||
    process.env['KORYPHAIOS'] === '1' ||
    process.env['KORYPHAIOS'] === 'true' ||
    process.env['KORYPHAIOS_MCP_ENABLED'] === '1' ||
    process.env['KORYPHAIOS_MCP_ENABLED'] === 'true'
  ) {
    return true;
  }

  // Koryphaios CLI bridge / grant environment variables
  if (
    Boolean(process.env['KORY_BACKEND_URL']) ||
    Boolean(process.env['KORY_BRIDGE_AUTH_FILE']) ||
    Boolean(process.env['KORYPHAIOS_SESSION_ID']) ||
    Boolean(process.env['KORY_SESSION_ID'])
  ) {
    return true;
  }

  // Explicit CLI argument flags
  if (
    process.argv.includes('--koryphaios') ||
    process.argv.includes('--kory-active') ||
    process.argv.includes('--kory')
  ) {
    return true;
  }

  return false;
}

/**
 * Serves a lightweight, zero-overhead passive MCP responder on stdio.
 * When the user runs CLI tools (Devin, Claude, OpenCode, Cursor) natively without Koryphaios,
 * this responds immediately to protocol discovery without starting heavy background watchers,
 * file analyzers, or Playwright, preventing timeouts and zombie node processes.
 */
export async function runPassiveServer(): Promise<void> {
  const server = new Server(
    {
      name: 'koryphaios',
      version: '0.2.0',
    },
    {
      capabilities: {
        tools: {},
        prompts: {},
        resources: {},
      },
    }
  );

  // Return empty capabilities instantly with zero delay
  server.setRequestHandler('tools/list', async () => ({ tools: [] }));
  server.setRequestHandler('prompts/list', async () => ({ prompts: [] }));
  server.setRequestHandler('resources/list', async () => ({ resources: [] }));

  // Serve over stdio
  const stdioHandle = serveStdio(() => server);

  // Ensure clean exit when parent process disconnects
  process.on('SIGINT', async () => {
    await stdioHandle.close().catch(() => {});
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    await stdioHandle.close().catch(() => {});
    process.exit(0);
  });
  process.stdin.on('end', () => {
    process.exit(0);
  });
  process.stdin.on('close', () => {
    process.exit(0);
  });
}

export async function main(): Promise<void> {
  // If native CLI usage (Koryphaios not active), run passive responder
  if (!isKoryphaiosActive()) {
    await runPassiveServer();
    return;
  }

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
    process.stderr.write(`Failed to start Koryphaios MCP server: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

// Keep importing the library side-effect free. The executable is registered in
// CLI MCP configs, while tests and embedding applications import the server
// factory without accidentally claiming stdin/stdout.
const entrypoint = process.argv[1] ? resolve(process.argv[1]) : '';
if (entrypoint === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`Fatal error in Koryphaios MCP server: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
