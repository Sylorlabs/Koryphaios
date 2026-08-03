// Conversation-rewrite generation shared by Koryphaios and stateful native
// CLI adapters. Most CLIs receive the complete persisted history on every
// invocation. Providers that resume a native conversation must compare this
// generation before reusing it, otherwise an edited message can remain in the
// provider-owned transcript after Koryphaios has pruned its own history.

const revisions = new Map<string, number>();

export function getCliConversationRevision(sessionId: string | undefined): number {
  if (!sessionId) return 0;
  return revisions.get(sessionId) ?? 0;
}

export function markCliConversationRewritten(sessionId: string): number {
  const next = getCliConversationRevision(sessionId) + 1;
  revisions.set(sessionId, next);
  return next;
}

/** Test-only reset; deliberately not used by runtime code. */
export function resetCliConversationRevisions(): void {
  revisions.clear();
}
