import { beforeAll, describe, expect, it } from 'bun:test';
import type { TranscriptPart } from '@koryphaios/shared';
import { db, initDb, messages, sessions } from '../db';
import { eq } from 'drizzle-orm';
import { MessageStore } from './message-store';
import { withDisplayParts } from '../routes/v1/messages';

beforeAll(async () => {
  await initDb();
});

async function newSession(label: string): Promise<string> {
  const sessionId = `parts-${label}-${Date.now()}-${Math.random()}`;
  await db.insert(sessions).values({
    id: sessionId,
    title: 'Transcript parts',
    createdAt: new Date(1_000),
    updatedAt: new Date(1_000),
  });
  return sessionId;
}

const parts: TranscriptPart[] = [
  { kind: 'reasoning', text: 'first thought', startedAt: 10, endedAt: 11 },
  {
    kind: 'tool',
    callId: 'c1',
    name: 'read_file',
    input: { path: 'a.ts' },
    startedAt: 12,
    output: 'contents',
    isError: false,
    durationMs: 3,
    endedAt: 13,
  },
  { kind: 'reasoning', text: 'second thought', startedAt: 14, endedAt: 15 },
  { kind: 'text', text: 'The answer.', startedAt: 16 },
];

describe('MessageStore transcript parts', () => {
  it('round-trips ordered parts while text and reasoning stay unchanged', async () => {
    const sessionId = await newSession('round-trip');
    const store = new MessageStore();
    await store.add(sessionId, {
      id: 'turn-1',
      sessionId,
      role: 'assistant',
      content: 'The answer.',
      reasoningContent: 'first thought\nsecond thought',
      parts,
      createdAt: 2_000,
    });

    const byId = await store.getById(sessionId, 'turn-1');
    expect(byId).toMatchObject({
      content: 'The answer.',
      reasoningContent: 'first thought\nsecond thought',
      parts,
    });
    const context = await store.getContextMessages(sessionId);
    expect(context.find((m) => m.id === 'turn-1')).toMatchObject({ content: 'The answer.', parts });
  });

  it('keeps the content column text-only, with the parts block at the end', async () => {
    const sessionId = await newSession('raw');
    await new MessageStore().add(sessionId, {
      id: 'turn-raw',
      sessionId,
      role: 'assistant',
      content: 'Hi',
      parts,
      createdAt: 2_000,
    });
    const [row] = await db.select().from(messages).where(eq(messages.id, 'turn-raw')).limit(1);
    const blocks = JSON.parse(row.content) as Array<{ type: string; text?: string }>;
    expect(blocks.map((b) => b.type)).toEqual(['text', 'kory_transcript_parts']);
    expect(blocks[0]).toEqual({ type: 'text', text: 'Hi' });
  });

  it('round-trips parts together with attachments', async () => {
    const sessionId = await newSession('attachments');
    const store = new MessageStore();
    await store.add(sessionId, {
      id: 'turn-att',
      sessionId,
      role: 'assistant',
      content: 'See image',
      parts,
      attachments: [{ type: 'image', data: 'AAAA', name: 'out.png', mimeType: 'image/png' }],
      createdAt: 2_000,
    });
    const stored = await store.getById(sessionId, 'turn-att');
    expect(stored?.content).toBe('See image');
    expect(stored?.parts).toEqual(parts);
    expect(stored?.attachments).toEqual([
      { type: 'image', data: 'AAAA', name: 'out.png', mimeType: 'image/png' },
    ]);
  });

  it('reads legacy rows without a parts block as before, with parts undefined', async () => {
    const sessionId = await newSession('legacy');
    const store = new MessageStore();
    await store.add(sessionId, {
      id: 'legacy-1',
      sessionId,
      role: 'assistant',
      content: 'Old answer',
      reasoningContent: 'old thought',
      createdAt: 1_000,
    });
    await db
      .update(messages)
      .set({
        content: JSON.stringify([
          { type: 'thinking', thinking: 'old thought' },
          { type: 'text', text: 'Old answer' },
        ]),
      })
      .where(eq(messages.id, 'legacy-1'));
    const stored = await store.getById(sessionId, 'legacy-1');
    expect(stored).toMatchObject({ content: 'Old answer', reasoningContent: 'old thought' });
    expect(stored?.parts).toBeUndefined();
  });

  it('ignores a malformed parts block rather than failing the row', async () => {
    const sessionId = await newSession('malformed');
    await new MessageStore().add(sessionId, {
      id: 'bad-parts',
      sessionId,
      role: 'assistant',
      content: 'Fine',
      createdAt: 1_000,
    });
    await db
      .update(messages)
      .set({
        content: JSON.stringify([
          { type: 'text', text: 'Fine' },
          { type: 'kory_transcript_parts', parts: 'nope' },
        ]),
      })
      .where(eq(messages.id, 'bad-parts'));
    const stored = await new MessageStore().getById(sessionId, 'bad-parts');
    expect(stored?.content).toBe('Fine');
    expect(stored?.parts).toBeUndefined();
  });
});

describe('messages route display parts', () => {
  it('returns parts for assistant rows and legacyTurnParts for rows without them', () => {
    const legacy = withDisplayParts({
      id: 'a',
      sessionId: 's',
      role: 'assistant',
      content: 'Text',
      reasoningContent: 'Why',
      createdAt: 5,
    });
    expect(legacy.parts).toEqual([
      // A legacy row stored the reasoning but never how long it took.
      { kind: 'reasoning', text: 'Why', startedAt: 5, endedAt: 5, timeUnknown: true },
      { kind: 'text', text: 'Text', startedAt: 5 },
    ]);
    const stored = withDisplayParts({
      id: 'b',
      sessionId: 's',
      role: 'assistant',
      content: 'Text',
      parts,
      createdAt: 5,
    });
    expect(stored.parts).toEqual(parts);
    const user = withDisplayParts({
      id: 'u',
      sessionId: 's',
      role: 'user',
      content: 'Hi',
      createdAt: 5,
    });
    expect(user.parts).toBeUndefined();
  });
});
