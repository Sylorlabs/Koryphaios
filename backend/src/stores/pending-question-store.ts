import type { KoryAskUserPayload } from '@koryphaios/shared';
import { and, desc, eq, isNull, or } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db, userInputs } from '../db';
import { serverLog } from '../logger';

interface DurableQuestionRecord {
  kind: 'question';
  status: 'pending' | 'answered' | 'cancelled';
  payload: KoryAskUserPayload;
  answer?: string;
  answeredAt?: number;
}

function parse(inputData: string): DurableQuestionRecord | null {
  try {
    const value = JSON.parse(inputData) as DurableQuestionRecord;
    return value?.kind === 'question' ? value : null;
  } catch (err: unknown) {
    serverLog.debug({ err: err instanceof Error ? err.message : String(err) }, 'pending question record parse failed — returning null');
    return null;
  }
}

export async function createPendingQuestion(
  sessionId: string,
  payload: Omit<KoryAskUserPayload, 'questionId'>,
): Promise<KoryAskUserPayload> {
  const existing = await getPendingQuestion(sessionId);
  if (existing) {
    await answerPendingQuestion(sessionId, '__cancelled__', 'cancelled');
  }
  const id = nanoid(16);
  const durablePayload = { ...payload, questionId: id };
  await db.insert(userInputs).values({
    id,
    sessionId,
    inputData: JSON.stringify({ kind: 'question', status: 'pending', payload: durablePayload }),
    status: 'pending',
    createdAt: new Date(),
  });
  return durablePayload;
}

export async function getPendingQuestion(sessionId: string): Promise<KoryAskUserPayload | null> {
  const rows = await db
    .select()
    .from(userInputs)
    .where(eq(userInputs.sessionId, sessionId))
    .orderBy(desc(userInputs.createdAt))
    .limit(50);
  for (const row of rows) {
    const record = parse(row.inputData);
    if (record?.status === 'pending' && (row.status === null || row.status === 'pending')) {
      return record.payload;
    }
  }
  return null;
}

/**
 * Compact startup projection for background waits.  It deliberately exposes
 * session ids only; the question text remains scoped to a normal session
 * subscription after the caller has selected that chat.
 */
export async function listPendingQuestionSessionIds(limit = 200): Promise<string[]> {
  const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
  const rows = await db
    .select({ sessionId: userInputs.sessionId, inputData: userInputs.inputData, status: userInputs.status })
    .from(userInputs)
    .where(or(eq(userInputs.status, 'pending'), isNull(userInputs.status)))
    .orderBy(desc(userInputs.createdAt))
    .limit(safeLimit);
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const record = parse(row.inputData);
    if (
      record?.status === 'pending' &&
      (row.status === null || row.status === 'pending') &&
      !seen.has(row.sessionId)
    ) {
      seen.add(row.sessionId);
      ids.push(row.sessionId);
    }
  }
  return ids;
}

export async function answerPendingQuestion(
  sessionId: string,
  answer: string,
  status: 'answered' | 'cancelled' = 'answered',
  questionId?: string,
): Promise<KoryAskUserPayload | null> {
  const rows = await db
    .select()
    .from(userInputs)
    .where(eq(userInputs.sessionId, sessionId))
    .orderBy(desc(userInputs.createdAt))
    .limit(50);
  for (const row of rows) {
    if (questionId && row.id !== questionId) continue;
    const record = parse(row.inputData);
    if (record?.status !== 'pending' || (row.status !== null && row.status !== 'pending')) continue;
    await db
      .update(userInputs)
      .set({
        status,
        inputData: JSON.stringify({
          ...record,
          status,
          answer,
          answeredAt: Date.now(),
        } satisfies DurableQuestionRecord),
      })
      .where(and(eq(userInputs.id, row.id), eq(userInputs.sessionId, sessionId)));
    return record.payload;
  }
  return null;
}

export async function listQuestionDecisions(sessionId: string): Promise<string[]> {
  const rows = await db
    .select()
    .from(userInputs)
    .where(eq(userInputs.sessionId, sessionId))
    .orderBy(userInputs.createdAt);
  return rows.flatMap((row) => {
    const record = parse(row.inputData);
    return record?.status === 'answered' && record.answer
      ? [`${record.payload.question}\nAnswer: ${record.answer}`]
      : [];
  });
}
