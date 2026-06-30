import { getContext } from '../context';

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
  } catch {
    // App context unavailable in tests/CLI
  }
}