// Persist Jules session IDs per Koryphaios session for continuity across turns.

import { db, sessions } from '../db';
import { eq, sql } from 'drizzle-orm';
import { serverLog } from '../logger';

export interface JulesSessionMeta {
  sessionId: string;
  url?: string;
  updatedAt: number;
}

export interface SessionMetadataJson {
  jules?: JulesSessionMeta;
  [key: string]: unknown;
}

function parseMetadata(raw: string | null | undefined): SessionMetadataJson {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as SessionMetadataJson)
      : {};
  } catch (err: unknown) {
    serverLog.debug(
      { err: err instanceof Error ? err.message : String(err) },
      'Jules session store: metadata JSON parse failed',
    );
    return {};
  }
}

export async function getJulesSessionMeta(
  korySessionId: string,
): Promise<JulesSessionMeta | undefined> {
  const row = await db.query.sessions.findFirst({
    where: eq(sessions.id, korySessionId),
    columns: { metadata: true },
  });
  return parseMetadata(row?.metadata ?? null).jules;
}

export async function setJulesSessionMeta(
  korySessionId: string,
  meta: JulesSessionMeta,
): Promise<void> {
  // Apply only the provider-owned key to the current row. A read/modify/write
  // can erase a Git workspace or settings persisted by a concurrent request.
  await db
    .update(sessions)
    .set({
      metadata: sql`json_set(CASE WHEN json_valid(${sessions.metadata}) THEN
        CASE WHEN json_type(${sessions.metadata}) = 'object' THEN ${sessions.metadata} ELSE '{}' END
        ELSE '{}' END, '$.jules', json(${JSON.stringify(meta)}))`,
      updatedAt: new Date(),
    })
    .where(eq(sessions.id, korySessionId));
}

export async function clearJulesSessionMeta(korySessionId: string): Promise<void> {
  await db
    .update(sessions)
    .set({
      metadata: sql`json_remove(CASE WHEN json_valid(${sessions.metadata}) THEN
        CASE WHEN json_type(${sessions.metadata}) = 'object' THEN ${sessions.metadata} ELSE '{}' END
        ELSE '{}' END, '$.jules')`,
      updatedAt: new Date(),
    })
    .where(eq(sessions.id, korySessionId));
}
