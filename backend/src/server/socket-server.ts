// Unix Domain Socket Server - Eliminates TCP attack surface
// Backend only accessible via local socket, not network

import type { Server, ServerWebSocket } from 'bun';
import { existsSync, unlinkSync, chmodSync } from 'fs';
import { join } from 'path';
import { PROJECT_ROOT } from '../runtime/paths';
import { serverLog } from '../logger';

export interface SocketServerConfig {
  readonly projectRoot: string;
  readonly socketName?: string;
}

export interface SocketInfo {
  readonly path: string;
  readonly type: 'unix' | 'windows_pipe' | 'tcp_fallback';
  readonly url: string;
}

/**
 * Detect best available socket type for the platform
 */
export function detectSocketType(): 'unix' | 'windows_pipe' {
  if (process.platform === 'win32') {
    return 'windows_pipe'; // Named pipes on Windows
  }
  return 'unix'; // Unix domain sockets on macOS/Linux
}

/**
 * Get socket path/name for the current platform
 */
export function getSocketPath(projectRoot: string, name = 'koryphaios'): SocketInfo {
  const type = detectSocketType();
  
  if (type === 'windows_pipe') {
    // Windows named pipe
    const pipeName = `\\\\.\\pipe\\${name}-${process.env.USERNAME || 'user'}`;
    return {
      path: pipeName,
      type: 'windows_pipe',
      url: `http://localhost` // Windows fallback - still better than exposing to LAN
    };
  }
  
  // Unix domain socket
  const socketDir = join(projectRoot, '.koryphaios');
  const socketPath = join(socketDir, `${name}.sock`);
  
  return {
    path: socketPath,
    type: 'unix',
    url: `http://unix:${socketPath}:`
  };
}

/**
 * Cleanup existing socket file
 */
export function cleanupExistingSocket(socketPath: string): void {
  if (process.platform === 'win32') return; // Named pipes don't leave files
  
  try {
    if (existsSync(socketPath)) {
      unlinkSync(socketPath);
      serverLog.debug({ socketPath }, 'Cleaned up existing socket');
    }
  } catch (err) {
    serverLog.warn({ socketPath, err }, 'Failed to cleanup socket');
  }
}

/**
 * Restrict socket permissions to owner only (Unix only)
 */
export function restrictSocketPermissions(socketPath: string): void {
  if (process.platform === 'win32') return;
  
  try {
    // 0600 = owner read/write only
    chmodSync(socketPath, 0o600);
    serverLog.debug({ socketPath }, 'Restricted socket permissions');
  } catch (err) {
    serverLog.warn({ socketPath, err }, 'Failed to restrict socket permissions');
  }
}

/**
 * Create socket server configuration for Bun.serve()
 */
export function createSocketServerConfig(
  config: SocketServerConfig
): { unix?: string; port?: number; hostname?: string } {
  const socketInfo = getSocketPath(config.projectRoot, config.socketName);
  
  // Cleanup existing socket
  cleanupExistingSocket(socketInfo.path);
  
  if (socketInfo.type === 'unix') {
    return { unix: socketInfo.path };
  }
  
  // Fallback to localhost-only TCP on Windows
  // Still restricts to local machine, just not as elegant
  return { 
    port: 0, // Random available port
    hostname: '127.0.0.1' // Bind to localhost only
  };
}

/**
 * Write socket info file for frontend to discover
 */
export function writeSocketInfo(
  projectRoot: string,
  socketInfo: SocketInfo,
  actualPort?: number
): void {
  const infoPath = join(projectRoot, '.koryphaios', '.socket-info.json');
  
  const info = {
    type: socketInfo.type,
    path: socketInfo.path,
    url: socketInfo.type === 'windows_pipe' && actualPort 
      ? `http://127.0.0.1:${actualPort}` 
      : socketInfo.url,
    created: Date.now(),
    pid: process.pid,
  };
  
  try {
    const fs = require('fs');
    fs.writeFileSync(infoPath, JSON.stringify(info, null, 2), { mode: 0o600 });
  } catch (err) {
    serverLog.warn({ err }, 'Failed to write socket info');
  }
}

/**
 * Read socket info for frontend connection
 */
export function readSocketInfo(projectRoot: string): SocketInfo | null {
  const infoPath = join(projectRoot, '.koryphaios', '.socket-info.json');
  
  try {
    if (!existsSync(infoPath)) return null;
    
    const fs = require('fs');
    const data = JSON.parse(fs.readFileSync(infoPath, 'utf-8'));
    
    // Verify PID is still running
    try {
      process.kill(data.pid, 0);
    } catch {
      // Process not running
      return null;
    }
    
    return {
      path: data.path,
      type: data.type,
      url: data.url,
    };
  } catch (err) {
    return null;
  }
}

/**
 * Cleanup socket on server shutdown
 */
export function cleanupSocket(projectRoot: string): void {
  const socketInfo = getSocketPath(projectRoot);
  
  cleanupExistingSocket(socketInfo.path);
  
  // Also remove info file
  try {
    const infoPath = join(projectRoot, '.koryphaios', '.socket-info.json');
    if (existsSync(infoPath)) {
      unlinkSync(infoPath);
    }
  } catch (err) {
    // Ignore cleanup errors
  }
}
