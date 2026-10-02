// Cross-store fan-out for "this chat no longer exists".
//
// Erasure has to reach every window, and it has three entry points: the DELETE
// response in the window that clicked, the delete-all sweep, and the
// session.deleted broadcast the server fans out to every other window. Stores
// holding per-chat state (goal snapshots, cached transcripts) subscribe here so
// all three paths converge on one notification.
//
// This module deliberately imports nothing. Subscribing happens at module scope,
// and the store graph is cyclic (sessions -> websocket -> feed/goals ->
// sessions), so registering through a store would evaluate a binding that is
// still in its temporal dead zone.

export type SessionRemovalListener = (sessionId: string) => void;

const listeners: SessionRemovalListener[] = [];

/** Subscribe to chat removal. Returns an unsubscribe function. */
export function onSessionRemoved(listener: SessionRemovalListener): () => void {
  listeners.push(listener);
  return () => {
    const index = listeners.indexOf(listener);
    if (index >= 0) listeners.splice(index, 1);
  };
}

/** Announce that a chat was erased. Safe to call more than once for the same id. */
export function notifySessionRemoved(sessionId: string): void {
  for (const listener of [...listeners]) {
    try {
      listener(sessionId);
    } catch (error) {
      // The row is already gone server-side. One store failing to reconcile must
      // not strand the others, nor surface as a failed deletion.
      console.error('Session removal listener failed:', error);
    }
  }
}
