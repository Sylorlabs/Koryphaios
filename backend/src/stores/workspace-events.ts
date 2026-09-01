// Workspace navigation push events — every authoritative mutation is
// broadcast so connected clients reconcile immediately instead of polling.

import type { WorkspaceNavigationSnapshot } from './workspace-navigation-store';
import { getContext } from '../context';
import { serverLog } from '../logger';

export function broadcastWorkspaceUpdate(snapshot: WorkspaceNavigationSnapshot): void {
  let manager: { broadcast(message: unknown): void };
  try {
    manager = getContext().wsManager;
  } catch (err: unknown) {
    // App context unavailable in tests/CLI
    serverLog.debug(
      { err: err instanceof Error ? err.message : String(err) },
      'workspace broadcast skipped — app context unavailable',
    );
    return;
  }
  try {
    manager.broadcast({
      type: 'workspace.updated' as const,
      payload: snapshot,
      timestamp: Date.now(),
    });
  } catch (err: unknown) {
    serverLog.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'workspace broadcast failed',
    );
  }
}
