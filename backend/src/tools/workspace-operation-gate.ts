/** Serializes a chat-wide checkout against parallel bridge tool executions.
 * Permission approval happens before acquiring a lease, so awaiting approval
 * never blocks the chat. Ordinary tools may run concurrently with each other. */
const readers = new Map<string, number>();
const exclusive = new Set<string>();

export function hasExclusiveWorkspaceOperation(sessionId: string): boolean {
  return exclusive.has(sessionId);
}

export function tryAcquireWorkspaceOperation(
  sessionId: string,
  mutation = false,
): { release(): void } | null {
  if (exclusive.has(sessionId) || (mutation && (readers.get(sessionId) ?? 0) > 0)) return null;
  if (mutation) exclusive.add(sessionId);
  else readers.set(sessionId, (readers.get(sessionId) ?? 0) + 1);
  let held = true;
  return {
    release() {
      if (!held) return;
      held = false;
      if (mutation) exclusive.delete(sessionId);
      else {
        const remaining = (readers.get(sessionId) ?? 1) - 1;
        if (remaining) readers.set(sessionId, remaining);
        else readers.delete(sessionId);
      }
    },
  };
}
