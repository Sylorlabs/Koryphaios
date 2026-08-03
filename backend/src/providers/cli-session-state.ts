// Conversation-rewrite generation shared by Koryphaios and stateful native
// CLI adapters. Most CLIs receive the complete persisted history on every
// invocation. Providers that resume a native conversation must compare this
// generation before reusing it, otherwise an edited message can remain in the
// provider-owned transcript after Koryphaios has pruned its own history.
//
// The revision is persisted in the sessions table (conversation_revision
// column) so it survives server restarts and is consistent across all
// processes. An in-memory cache avoids a DB round-trip on every
// getCliConversationRevision call (hot path during streaming).

import { db } from '../db';
import { sessions } from '../db/schema';
import { eq, sql } from 'drizzle-orm';

const cache = new Map<string, number>();

export async function getCliConversationRevision(
  sessionId: string | undefined,
): Promise<number> {
  if (!sessionId) return 0;
  const cached = cache.get(sessionId);
  if (cached !== undefined) return cached;
  const row = await db
    .select({ revision: sessions.conversationRevision })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  const revision = row[0]?.revision ?? 0;
  cache.set(sessionId, revision);
  return revision;
}

export async function markCliConversationRewritten(sessionId: string): Promise<number> {
  const row = await db
    .update(sessions)
    .set({
      conversationRevision: sql`${sessions.conversationRevision} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(sessions.id, sessionId))
    .returning({ revision: sessions.conversationRevision })
    .limit(1);
  const next = row[0]?.revision ?? 1;
  cache.set(sessionId, next);
  return next;
}

/** Test-only reset; deliberately not used by runtime code. */
export function resetCliConversationRevisions(): void {
  cache.clear();
}
