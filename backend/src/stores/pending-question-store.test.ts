import { afterAll, describe, expect, test } from 'bun:test';
import { SessionStore } from './session-store';
import { SessionStateService } from '../kory/services/SessionStateService';
import {
  answerPendingQuestion,
  createPendingQuestion,
  getPendingQuestion,
  listQuestionDecisions,
} from './pending-question-store';

const sessions = new SessionStore();
const sessionIds: string[] = [];

afterAll(async () => {
  for (const sessionId of sessionIds) await sessions.delete(sessionId);
});

describe('durable pending questions', () => {
  test('round-trips a pending question and its answer through SQLite', async () => {
    const session = await sessions.create('local-user', 'Question persistence');
    sessionIds.push(session.id);
    const created = await createPendingQuestion(session.id, {
      question: 'Which runtime?',
      options: ['Desktop', 'Browser'],
      allowOther: true,
      allowKeepChatting: true,
    });
    expect(created.questionId).toBeTruthy();
    expect(await getPendingQuestion(session.id)).toEqual(created);
    expect(await answerPendingQuestion(session.id, 'Desktop')).toEqual(created);
    expect(await getPendingQuestion(session.id)).toBeNull();
    expect(await listQuestionDecisions(session.id)).toEqual(['Which runtime?\nAnswer: Desktop']);
  });

  test('persists Plan mode and its note identity in session metadata', async () => {
    const session = await sessions.create('local-user', 'Planning persistence');
    sessionIds.push(session.id);
    await sessions.update(session.id, { interactionMode: 'plan', planNoteId: 'note-stable' });
    const reloaded = await new SessionStore().get(session.id);
    expect(reloaded).toMatchObject({ interactionMode: 'plan', planNoteId: 'note-stable' });
  });

  test('retains the question when a fresh runtime has no suspended resolver', async () => {
    const session = await sessions.create('local-user', 'Restart recovery');
    sessionIds.push(session.id);
    const created = await createPendingQuestion(session.id, {
      question: 'Keep the desktop runtime?',
      options: ['Yes', 'No'],
      allowOther: true,
    });
    const restartedRuntime = new SessionStateService();
    expect(restartedRuntime.hasPendingInput(session.id)).toBe(false);
    expect(await getPendingQuestion(session.id)).toEqual(created);
  });
});
