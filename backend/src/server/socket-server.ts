// Unix Domain Socket Server utilities
import { existsSync, unlinkSync, chmodSync, writeFileSync } from 'fs';
import { join } from 'path';
import { PROJECT_ROOT } from '../runtime/paths';
import { serverLog } from '../logger';

export interface SocketInfo {
  readonly path: string;
  readonly type: 'unix' | 'tcp_fallback';
  readonly url: string;
}

export function getSocketPath(projectRoot: string, name = 'koryphaios'): SocketInfo {
  if (process.platform === 'win32') {
    return {
      path: `\\\\.\\pipe\\${name}`,
      type: 'tcp_fallback',
      url: 'http://127.0.0.1:0',
    };
  }

  const socketDir = join(projectRoot, '.koryphaios');
  const socketPath = join(socketDir, `${name}.sock`);

  return {
    path: socketPath,
    type: 'unix',
    url: `http://unix:${socketPath}:`,
  };
}

export function cleanupExistingSocket(socketPath: string): void {
  if (process.platform === 'win32') return;
  try {
    if (existsSync(socketPath)) {
      unlinkSync(socketPath);
    }
  } catch (err) {
    serverLog.warn({ err }, 'Failed to cleanup socket');
  }
}

export function restrictSocketPermissions(socketPath: string): void {
  if (process.platform === 'win32') return;
  try {
    chmodSync(socketPath, 0o600);
  } catch (err) {
    serverLog.warn({ err }, 'Failed to restrict socket permissions');
  }
}

export function createSocketServerConfig(projectRoot: string): {
  unix?: string;
  port?: number;
  hostname?: string;
} {
  const socketInfo = getSocketPath(projectRoot);
  cleanupExistingSocket(socketInfo.path);

  if (socketInfo.type === 'unix') {
    return { unix: socketInfo.path };
  }

  return { port: 0, hostname: '127.0.0.1' };
}

export function writeSocketInfo(
  projectRoot: string,
  socketInfo: SocketInfo,
  actualPort?: number,
): void {
  const infoPath = join(projectRoot, '.koryphaios', '.socket-info.json');
  const info = {
    type: socketInfo.type,
    path: socketInfo.path,
    url: actualPort ? `http://127.0.0.1:${actualPort}` : socketInfo.url,
    created: Date.now(),
    pid: process.pid,
  };
  writeFileSync(infoPath, JSON.stringify(info, null, 2), { mode: 0o600 });
}

export function cleanupSocket(projectRoot: string): void {
  const socketInfo = getSocketPath(projectRoot);
  cleanupExistingSocket(socketInfo.path);
  try {
    const infoPath = join(projectRoot, '.koryphaios', '.socket-info.json');
    if (existsSync(infoPath)) unlinkSync(infoPath);
  } catch {}
}
