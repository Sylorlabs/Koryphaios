// Persist Jules session IDs per Koryphaios session for continuity across turns.

import { db, sessions } from '../db';
import { eq } from 'drizzle-orm';

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
  } catch {
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
  const row = await db.query.sessions.findFirst({
    where: eq(sessions.id, korySessionId),
    columns: { metadata: true },
  });
  const current = parseMetadata(row?.metadata ?? null);
  current.jules = meta;
  await db
    .update(sessions)
    .set({ metadata: JSON.stringify(current), updatedAt: new Date() })
    .where(eq(sessions.id, korySessionId));
}

export async function clearJulesSessionMeta(korySessionId: string): Promise<void> {
  const row = await db.query.sessions.findFirst({
    where: eq(sessions.id, korySessionId),
    columns: { metadata: true },
  });
  const current = parseMetadata(row?.metadata ?? null);
  delete current.jules;
  await db
    .update(sessions)
    .set({ metadata: JSON.stringify(current), updatedAt: new Date() })
    .where(eq(sessions.id, korySessionId));
}