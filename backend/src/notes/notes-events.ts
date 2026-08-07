import { getContext } from '../context';
import { serverLog } from '../logger';

export type NotesMutationAction = 'create' | 'update' | 'delete' | 'link' | 'unlink';

export function broadcastNotesNetworkUpdate(
  action: NotesMutationAction,
  noteId?: string,
  sessionId?: string,
): void {
  try {
    const { wsManager } = getContext();
    wsManager.broadcast({
      type: 'notes.updated',
      payload: { action, noteId },
      timestamp: Date.now(),
      ...(sessionId ? { sessionId } : {}),
    });
  } catch (err: unknown) {
    // App context unavailable in tests/CLI
    serverLog.debug({ err: err instanceof Error ? err.message : String(err) }, 'notes network broadcast skipped — app context unavailable');
  }
}