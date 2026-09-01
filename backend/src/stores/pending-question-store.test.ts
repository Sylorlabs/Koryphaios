import { describe, expect, test } from 'bun:test';
import { SessionStore } from './session-store';
import { SessionStateService } from '../kory/services/SessionStateService';
import {
  answerPendingQuestion,
  createPendingQuestion,
  getPendingQuestion,
  listPendingQuestionSessionIds,
  listQuestionDecisions,
} from './pending-question-store';

const sessions = new SessionStore();

describe('durable pending questions', () => {
  test('round-trips a pending question and its answer through SQLite', async () => {
    const session = await sessions.create('local-user', 'Question persistence');
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
    await sessions.update(session.id, { interactionMode: 'plan', planNoteId: 'note-stable' });
    const reloaded = await new SessionStore().get(session.id);
    expect(reloaded).toMatchObject({ interactionMode: 'plan', planNoteId: 'note-stable' });
  });

  test('retains the question when a fresh runtime has no suspended resolver', async () => {
    const session = await sessions.create('local-user', 'Restart recovery');
    const created = await createPendingQuestion(session.id, {
      question: 'Keep the desktop runtime?',
      options: ['Yes', 'No'],
      allowOther: true,
    });
    const restartedRuntime = new SessionStateService();
    expect(restartedRuntime.hasPendingInput(session.id)).toBe(false);
    expect(await getPendingQuestion(session.id)).toEqual(created);
  });

  test('lists only session ids with a durable actionable question', async () => {
    const waiting = await sessions.create('local-user', 'Background question index');
    const resolved = await sessions.create('local-user', 'Resolved question index');
    await createPendingQuestion(waiting.id, {
      question: 'Continue in the background?',
      options: ['Continue', 'Stop'],
      allowOther: false,
    });
    const answered = await createPendingQuestion(resolved.id, {
      question: 'Keep this visible?',
      options: ['Yes', 'No'],
      allowOther: false,
    });
    await answerPendingQuestion(resolved.id, 'Yes', 'answered', answered.questionId);

    const ids = await listPendingQuestionSessionIds();
    expect(ids).toContain(waiting.id);
    expect(ids).not.toContain(resolved.id);
  });
});
