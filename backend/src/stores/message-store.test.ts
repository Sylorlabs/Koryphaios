import { describe, expect, it } from 'bun:test';
import { db, sessions } from '../db';
import { MessageStore } from './message-store';

describe('MessageStore history editing', () => {
  it('replaces the selected user message and atomically removes later turns', async () => {
    const suffix = `${Date.now()}-${Math.random()}`;
    const sessionId = `edit-${suffix}`;
    const firstUserId = `u1-${suffix}`;
    await db.insert(sessions).values({
      id: sessionId,
      title: 'Edit test',
      createdAt: new Date(1_000),
      updatedAt: new Date(1_000),
    });
    const store = new MessageStore();
    await store.add(sessionId, {
      id: firstUserId,
      sessionId,
      role: 'user',
      content: 'old',
      createdAt: 2_000,
    });
    await store.add(sessionId, {
      id: `a1-${suffix}`,
      sessionId,
      role: 'assistant',
      content: 'answer',
      createdAt: 3_000,
    });
    await store.add(sessionId, {
      id: `u2-${suffix}`,
      sessionId,
      role: 'user',
      content: 'later',
      createdAt: 4_000,
    });

    expect(await store.replaceAndTruncate(sessionId, firstUserId, 'edited')).toBe(2);
    expect(await store.getAll(sessionId)).toMatchObject([
      { id: firstUserId, role: 'user', content: 'edited' },
    ]);
  });

  it('persists image attachments and preserves them when the message text is edited', async () => {
    const suffix = `${Date.now()}-${Math.random()}`;
    const sessionId = `image-edit-${suffix}`;
    const messageId = `image-user-${suffix}`;
    await db.insert(sessions).values({
      id: sessionId,
      title: 'Image edit test',
      createdAt: new Date(1_000),
      updatedAt: new Date(1_000),
    });
    const store = new MessageStore();
    await store.add(sessionId, {
      id: messageId,
      sessionId,
      role: 'user',
      content: 'inspect this',
      attachments: [
        {
          type: 'image',
          data: Buffer.from('image-bytes').toString('base64'),
          name: 'screen.png',
          mimeType: 'image/png',
        },
      ],
      createdAt: 2_000,
    });

    expect((await store.getAll(sessionId))[0]?.attachments).toHaveLength(1);
    await store.replaceAndTruncate(sessionId, messageId, 'inspect this edited version');
    expect((await store.getAll(sessionId))[0]).toMatchObject({
      content: 'inspect this edited version',
      attachments: [{ type: 'image', name: 'screen.png', mimeType: 'image/png' }],
    });
  });
});
