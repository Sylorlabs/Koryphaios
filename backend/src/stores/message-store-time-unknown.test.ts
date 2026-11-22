import { beforeAll, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { db, initDb, messages, sessions } from '../db';
import { MessageStore } from './message-store';
import { withDisplayParts } from '../routes/v1/messages';

beforeAll(async () => {
  await initDb();
});

async function newSession(label: string): Promise<string> {
  const sessionId = `time-unknown-${label}-${Date.now()}-${Math.random()}`;
  await db.insert(sessions).values({
    id: sessionId,
    title: 'Time unknown',
    createdAt: new Date(1_000),
    updatedAt: new Date(1_000),
  });
  return sessionId;
}

describe('MessageStore timeUnknown', () => {
  it('round-trips timeUnknown through a meta block that never leaks into text', async () => {
    const sessionId = await newSession('round-trip');
    const store = new MessageStore();
    await store.add(sessionId, {
      id: 'tu-user', sessionId, role: 'user', content: 'When did I say this?', timeUnknown: true, createdAt: 2_000,
    });
    await store.add(sessionId, {
      id: 'tu-known', sessionId, role: 'assistant', content: 'Known time.', createdAt: 3_000,
    });

    const [row] = await db.select().from(messages).where(eq(messages.id, 'tu-user')).limit(1);
    const blocks = JSON.parse(row.content) as Array<{ type: string; text?: string; timeUnknown?: boolean }>;
    expect(blocks).toEqual([
      { type: 'text', text: 'When did I say this?' },
      { type: 'kory_message_meta', timeUnknown: true },
    ]);

    const unknown = await store.getById(sessionId, 'tu-user');
    expect(unknown?.content).toBe('When did I say this?');
    expect(unknown?.timeUnknown).toBe(true);
    const known = await store.getById(sessionId, 'tu-known');
    expect(known?.timeUnknown).toBeUndefined();

    // The messages API projection carries the flag.
    const projection = await store.getDisplayProjection(sessionId, 50);
    const api = projection.messages.map(withDisplayParts);
    expect(api.find((m) => m.id === 'tu-user')?.timeUnknown).toBe(true);
    expect(api.find((m) => m.id === 'tu-known')?.timeUnknown).toBeUndefined();
    expect(api.find((m) => m.id === 'tu-user')?.content).toBe('When did I say this?');
  });

  it('reads a row written by the CLI import path with the meta block after parts', async () => {
    const sessionId = await newSession('import-layout');
    const store = new MessageStore();
    await store.add(sessionId, { id: 'seed', sessionId, role: 'user', content: 'seed', createdAt: 1_500 });
    await db.update(messages).set({
      content: JSON.stringify([
        { type: 'text', text: 'Imported answer' },
        { type: 'kory_transcript_parts', parts: [{ kind: 'text', text: 'Imported answer', startedAt: 1 }] },
        { type: 'kory_message_meta', timeUnknown: true },
      ]),
    }).where(eq(messages.id, 'seed'));
    const stored = await store.getById(sessionId, 'seed');
    expect(stored?.content).toBe('Imported answer');
    expect(stored?.timeUnknown).toBe(true);
    expect(stored?.parts).toEqual([{ kind: 'text', text: 'Imported answer', startedAt: 1 }]);
  });
});
