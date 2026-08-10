// Conversation-rewrite generation shared by Koryphaios and stateful native
// CLI adapters. Most CLIs receive the complete persisted history on every
// invocation. Providers that resume a native conversation must compare this
// generation before reusing it, otherwise an edited message can remain in the
// provider-owned transcript after Koryphaios has pruned its own history.
//
// The revision is persisted independently from the active context-compaction
// revision so invalidating a provider transcript cannot accidentally hide or
// expose a different set of local messages. Reads intentionally consult
// SQLite so a rewrite performed by another backend process is observed.

import { db } from '../db';
import { sessions } from '../db/schema';
import { eq, sql } from 'drizzle-orm';

export async function getCliConversationRevision(sessionId: string | undefined): Promise<number> {
  if (!sessionId) return 0;
  const row = await db
    .select({ revision: sessions.providerConversationRevision })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  const revision = row[0]?.revision ?? 0;
  return revision;
}

export async function markCliConversationRewritten(sessionId: string): Promise<number> {
  const row = await db
    .update(sessions)
    .set({
      providerConversationRevision: sql`COALESCE(${sessions.providerConversationRevision}, 0) + 1`,
      updatedAt: new Date(),
    })
    .where(eq(sessions.id, sessionId))
    .returning({ revision: sessions.providerConversationRevision })
    .limit(1);
  if (!row[0]) throw new Error('Session not found');
  const next = row[0].revision ?? 1;
  return next;
}

/** Backward-compatible test helper; revisions no longer use process-local state. */
export function resetCliConversationRevisions(): void {
  // Intentionally empty.
}
