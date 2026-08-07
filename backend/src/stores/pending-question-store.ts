import type { KoryAskUserPayload } from '@koryphaios/shared';
import { and, desc, eq } from 'drizzle-orm';
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
    if (record?.status === 'pending') return record.payload;
  }
  return null;
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
    if (record?.status !== 'pending') continue;
    await db
      .update(userInputs)
      .set({
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
