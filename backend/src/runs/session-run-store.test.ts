import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  SessionRunTransitionError,
  type KoryAskUserPayload,
  type WSMessage,
} from '@koryphaios/shared';
import { MIGRATIONS } from '../db/migrations';
import { SessionRunCoordinator } from './session-run-coordinator';
import { canonicalSessionTurnInputHash, SessionRunStore } from './session-run-store';

const SESSION_ID = 'session-run-test';

function createDatabase(): Database {
  const sqlite = new Database(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      active_message_id TEXT,
      provider_conversation_revision INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER,
      updated_at INTEGER
    );
    CREATE TABLE user_inputs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      input_data TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );
    CREATE TABLE supervised_processes (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      status TEXT NOT NULL,
      provenance TEXT NOT NULL,
      supervision TEXT NOT NULL,
      is_background INTEGER NOT NULL,
      terminal_reason TEXT
    );
    INSERT INTO sessions (id, title, created_at, updated_at)
    VALUES ('${SESSION_ID}', 'Run test', 1, 1);
  `);
  for (const version of ['0032', '0033', '0037', '0038', '0043']) {
    const migration = MIGRATIONS.find((item) => item.version === version);
    if (!migration) throw new Error(`${version} migration missing`);
    sqlite.exec(migration.up);
  }
  return sqlite;
}

const QUESTION: Omit<KoryAskUserPayload, 'questionId'> = {
  question: 'Which runtime?',
  options: ['Desktop', 'Browser'],
  allowOther: true,
  allowKeepChatting: true,
};

describe('SessionRunStore', () => {
  let sqlite: Database;
  let store: SessionRunStore;

  beforeEach(() => {
    sqlite = createDatabase();
    store = new SessionRunStore(sqlite);
  });

  afterEach(() => sqlite.close());

  test('atomically binds one producer identity to one canonical payload', () => {
    const input = {
      sessionId: SESSION_ID,
      source: 'collaboration' as const,
      sourceCommandId: 'relay-prompt-42',
      inputHash: canonicalSessionTurnInputHash({
        attachments: [{ name: 'proof.txt', data: 'evidence' }],
        userMessage: 'Apply the approved request.',
      }),
    };
    const started = store.beginSessionTurnCommand(input, 100);

    expect(started.disposition).toBe('started');
    expect(started.command).toMatchObject({
      sessionId: SESSION_ID,
      source: 'collaboration',
      sourceCommandId: 'relay-prompt-42',
      inputHash: input.inputHash,
      status: 'active',
      createdAt: 100,
      updatedAt: 100,
    });
    expect(started.command.userMessageId).toBe(`command-user-${started.command.commandKey}`);
    expect(started.command.responseMessageId).toBe(
      `command-response-${started.command.commandKey}`,
    );
    expect(started.runTransition?.payload.snapshot.runId).toBe(started.command.runId);

    const reconstructed = new SessionRunStore(sqlite);
    expect(() =>
      reconstructed.beginSessionTurnCommand(
        {
          ...input,
          inputHash: canonicalSessionTurnInputHash({
            attachments: [{ name: 'proof.txt', data: 'changed' }],
            userMessage: 'Apply the approved request.',
          }),
        },
        200,
      ),
    ).toThrow(
      expect.objectContaining({
        code: 'INPUT_HASH_MISMATCH',
      }),
    );
    expect(
      sqlite.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM session_run_events').get()
        ?.count,
    ).toBe(1);
  });

  test('fails closed on a crash-left-active command instead of replaying it', async () => {
    const input = {
      sessionId: SESSION_ID,
      source: 'goal' as const,
      sourceCommandId: 'goal-attempt-item-turn',
      inputHash: canonicalSessionTurnInputHash({ userMessage: 'Perform this step once.' }),
    };
    const started = store.beginSessionTurnCommand(input, 100);
    const reconstructed = new SessionRunStore(sqlite);
    const receipt = reconstructed.beginSessionTurnCommand(input, 200);

    expect(receipt).toMatchObject({
      disposition: 'existing',
      runTransition: null,
      command: {
        commandKey: started.command.commandKey,
        runId: started.command.runId,
        status: 'active',
        updatedAt: 100,
      },
    });
    expect(
      sqlite.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM session_run_events').get()
        ?.count,
    ).toBe(1);

    const coordinator = new SessionRunCoordinator(reconstructed, () => undefined);
    expect(await coordinator.recoverInterruptedRuns()).toBe(1);
    expect(reconstructed.getSessionTurnCommand(started.command.commandKey)).toMatchObject({
      status: 'failed',
      terminalReason: 'backend_restarted_during_active_run',
    });
  });

  test('returns a durable completed receipt without starting another run', async () => {
    const coordinator = new SessionRunCoordinator(store, () => undefined);
    const input = {
      sessionId: SESSION_ID,
      source: 'internal' as const,
      sourceCommandId: 'internal-command-7',
      inputHash: canonicalSessionTurnInputHash({
        fastMode: false,
        userMessage: 'Complete this exactly once.',
      }),
    };
    const started = await coordinator.beginSessionTurnCommand(input, 100);
    const snapshot = started.runTransition?.payload.snapshot;
    if (!snapshot?.runId) throw new Error('Command did not start a SessionRun');
    const finished = await coordinator.finishSessionTurnCommand(
      {
        commandKey: started.command.commandKey,
        expectedRunId: snapshot.runId,
        expectedRevision: snapshot.revision,
        status: 'completed',
        terminalReason: 'provider_response_persisted',
      },
      200,
    );

    expect(finished).toMatchObject({
      disposition: 'finished',
      command: {
        runId: snapshot.runId,
        status: 'completed',
        terminalReason: 'provider_response_persisted',
        finishedAt: 200,
      },
    });
    const reconstructed = new SessionRunCoordinator(new SessionRunStore(sqlite), () => undefined);
    await expect(reconstructed.beginSessionTurnCommand(input, 300)).resolves.toMatchObject({
      disposition: 'existing',
      runTransition: null,
      command: {
        commandKey: started.command.commandKey,
        runId: snapshot.runId,
        status: 'completed',
        terminalReason: 'provider_response_persisted',
      },
    });
    expect(
      sqlite
        .query<{ count: number }, []>(
          `SELECT COUNT(*) AS count FROM session_run_events
           WHERE json_extract(payload, '$.transition.command') = 'start'`,
        )
        .get()?.count,
    ).toBe(1);
  });

  test('projects a durable wait into the owning command receipt', () => {
    const begun = store.beginSessionTurnCommand(
      {
        sessionId: SESSION_ID,
        source: 'internal',
        sourceCommandId: 'waiting-command',
        inputHash: canonicalSessionTurnInputHash({ userMessage: 'Ask before continuing.' }),
      },
      100,
    );
    store.parkForQuestion(
      SESSION_ID,
      begun.command.runId,
      begun.runTransition!.payload.snapshot.revision,
      'awaiting_user_input',
      QUESTION,
      200,
    );

    expect(store.getSessionTurnCommand(begun.command.commandKey)).toMatchObject({
      status: 'waiting',
      terminalReason: null,
      updatedAt: 200,
      finishedAt: null,
    });
  });

  test('rolls back command admission when another run owns the session', () => {
    store.transition(SESSION_ID, { kind: 'start', runId: 'existing-run' }, 100);
    expect(() =>
      store.beginSessionTurnCommand(
        {
          sessionId: SESSION_ID,
          source: 'goal',
          sourceCommandId: 'blocked-command',
          inputHash: canonicalSessionTurnInputHash({ userMessage: 'Do not partially admit me.' }),
        },
        200,
      ),
    ).toThrow(expect.objectContaining({ code: 'RUN_ALREADY_ACTIVE' }));
    expect(
      sqlite
        .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM session_turn_commands')
        .get()?.count,
    ).toBe(0);
    expect(store.get(SESSION_ID)).toMatchObject({
      runId: 'existing-run',
      revision: 1,
      status: 'active',
    });
  });

  test('commits snapshot and lifecycle outbox in one revision', () => {
    const started = store.transition(SESSION_ID, {
      kind: 'start',
      runId: 'run-1',
      reason: 'test',
    });

    expect(started.payload.snapshot.phase).toBe('analyzing');
    expect(started.payload.snapshot.revision).toBe(1);
    expect(store.listUnpublished()).toHaveLength(1);
    expect(
      sqlite.query<{ count: number }, []>('SELECT count(*) AS count FROM session_runs').get()
        ?.count,
    ).toBe(1);
    expect(
      sqlite.query<{ count: number }, []>('SELECT count(*) AS count FROM session_run_events').get()
        ?.count,
    ).toBe(1);
  });

  test('survives repository reconstruction and rejects a stale callback', () => {
    store.transition(SESSION_ID, { kind: 'start', runId: 'run-1' });
    store.transition(SESSION_ID, {
      kind: 'phase',
      expectedRunId: 'run-1',
      expectedRevision: 1,
      phase: 'streaming',
    });

    const reconstructed = new SessionRunStore(sqlite);
    expect(reconstructed.get(SESSION_ID)?.phase).toBe('streaming');
    expect(() =>
      reconstructed.transition(SESSION_ID, {
        kind: 'phase',
        expectedRunId: 'old-run',
        expectedRevision: 2,
        phase: 'thinking',
      }),
    ).toThrow(SessionRunTransitionError);
    expect(reconstructed.get(SESSION_ID)?.revision).toBe(2);
  });

  test('does not manufacture revisions for repeated token-loop phase reports', () => {
    store.transition(SESSION_ID, { kind: 'start', runId: 'run-1' });
    store.transition(SESSION_ID, {
      kind: 'phase',
      expectedRunId: 'run-1',
      expectedRevision: 1,
      phase: 'streaming',
    });
    const duplicate = store.transition(SESSION_ID, {
      kind: 'phase',
      expectedRunId: 'run-1',
      expectedRevision: 2,
      phase: 'streaming',
    });

    expect(duplicate.publishRequired).toBe(false);
    expect(duplicate.payload.snapshot.revision).toBe(2);
    expect(store.listUnpublished()).toHaveLength(2);
  });

  test('rejects delayed same-run callbacks instead of silently resuming a wait', () => {
    store.transition(SESSION_ID, { kind: 'start', runId: 'run-1' });
    store.parkForQuestion(SESSION_ID, 'run-1', 1, 'awaiting_user_input', QUESTION);

    expect(() =>
      store.transition(SESSION_ID, {
        kind: 'phase',
        expectedRunId: 'run-1',
        expectedRevision: 2,
        phase: 'streaming',
      }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_PHASE' }));
    expect(store.get(SESSION_ID)).toMatchObject({ revision: 2, phase: 'waiting_user' });
  });

  test('requires the exact revision and wait kind when resuming', () => {
    store.transition(SESSION_ID, { kind: 'start', runId: 'run-1' });
    store.parkForQuestion(SESSION_ID, 'run-1', 1, 'awaiting_user_input', QUESTION);

    expect(() =>
      store.transition(SESSION_ID, {
        kind: 'resume',
        expectedRunId: 'run-1',
        expectedRevision: 1,
        expectedWaitingPhase: 'waiting_user',
      }),
    ).toThrow(expect.objectContaining({ code: 'STALE_REVISION' }));
    expect(() =>
      store.transition(SESSION_ID, {
        kind: 'resume',
        expectedRunId: 'run-1',
        expectedRevision: 2,
        expectedWaitingPhase: 'waiting_terminal',
      }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_PHASE' }));
    expect(() =>
      store.transition(SESSION_ID, {
        kind: 'complete',
        expectedRunId: 'run-1',
        expectedRevision: 2,
        reason: 'generic_wait_completion_must_not_bypass_continuation',
      }),
    ).toThrow('A waiting run may complete only through its owned continuation');
    expect(store.get(SESSION_ID)).toMatchObject({ revision: 2, phase: 'waiting_user' });
  });

  test('parks and answers a question with the run, continuation, input, and outbox in lockstep', () => {
    store.transition(SESSION_ID, { kind: 'start', runId: 'run-1' }, 100);
    const waiting = store.parkForQuestion(
      SESSION_ID,
      'run-1',
      1,
      'awaiting_user_input',
      QUESTION,
      200,
    );
    const questionId = waiting.question.questionId!;

    const continuation = store.getContinuation(questionId);
    const input = sqlite
      .query<{ id: string; run_id: string; run_revision: number; status: string }, [string]>(
        `SELECT id, run_id, run_revision, status FROM user_inputs WHERE id = ?`,
      )
      .get(questionId);
    expect(waiting.payload.snapshot).toMatchObject({
      revision: 2,
      phase: 'waiting_user',
      status: 'waiting',
      continuationId: questionId,
    });
    expect(continuation).toMatchObject({
      id: questionId,
      waitRevision: 2,
      kind: 'user_question',
      state: 'pending',
    });
    expect(input).toEqual({
      id: questionId,
      run_id: 'run-1',
      run_revision: 2,
      status: 'pending',
    });

    const answered = store.answerQuestion(SESSION_ID, 'run-1', 2, questionId, 'Desktop', true, 300);
    expect(answered?.payload.snapshot).toMatchObject({
      revision: 3,
      phase: 'analyzing',
      status: 'active',
      continuationId: null,
    });
    expect(answered?.handoff).toBeNull();
    expect(store.listRestartHandoffs()).toEqual([]);
    expect(store.getContinuation(questionId)?.state).toBe('consumed');
    expect(
      sqlite
        .query<{ status: string; input_data: string }, [string]>(
          'SELECT status, input_data FROM user_inputs WHERE id = ?',
        )
        .get(questionId),
    ).toMatchObject({ status: 'answered' });
    expect(store.listUnpublished().map(({ snapshot }) => snapshot.revision)).toEqual([1, 2, 3]);
  });

  test('commits a restart answer and discoverable handoff as one durable boundary', () => {
    store.transition(SESSION_ID, { kind: 'start', runId: 'run-1' }, 100);
    const waiting = store.parkForQuestion(
      SESSION_ID,
      'run-1',
      1,
      'awaiting_user_input',
      QUESTION,
      200,
    );
    const questionId = waiting.question.questionId!;

    const answered = store.answerQuestion(
      SESSION_ID,
      'run-1',
      2,
      questionId,
      'Desktop',
      false,
      300,
    );

    expect(answered?.payload.snapshot).toMatchObject({
      runId: 'run-1',
      revision: 3,
      phase: 'done',
      status: 'terminal',
      terminalReason: 'user_input_handoff_after_restart',
      continuationId: null,
    });
    expect(answered?.handoff).toMatchObject({
      id: expect.any(String),
      sessionId: SESSION_ID,
      kind: 'resume_answered_question',
      sourceRunId: 'run-1',
      sourceRunRevision: 2,
      questionId,
      question: waiting.question,
      expectedBoundary: {
        activeMessageId: null,
        providerConversationRevision: 0,
      },
      answer: 'Desktop',
      state: 'pending',
      attemptCount: 0,
      createdAt: 300,
      updatedAt: 300,
    });
    expect(store.getContinuation(questionId)?.state).toBe('consumed');
    expect(
      sqlite
        .query<{ status: string; input_data: string }, [string]>(
          'SELECT status, input_data FROM user_inputs WHERE id = ?',
        )
        .get(questionId),
    ).toMatchObject({ status: 'answered' });

    // This is the crash boundary: no process-local state from the answering
    // call is used to rediscover the committed command.
    const afterRestart = new SessionRunStore(sqlite);
    expect(afterRestart.listPendingRestartHandoffs()).toEqual([answered!.handoff!]);
  });

  test('rolls the answer and terminal transition back when restart handoff persistence fails', () => {
    store.transition(SESSION_ID, { kind: 'start', runId: 'run-1' }, 100);
    const waiting = store.parkForQuestion(
      SESSION_ID,
      'run-1',
      1,
      'awaiting_user_input',
      QUESTION,
      200,
    );
    const questionId = waiting.question.questionId!;
    sqlite.exec(`
      CREATE TRIGGER reject_restart_handoff
      BEFORE INSERT ON session_run_handoffs
      BEGIN
        SELECT RAISE(ABORT, 'simulated handoff failure');
      END;
    `);

    expect(() =>
      store.answerQuestion(SESSION_ID, 'run-1', 2, questionId, 'Desktop', false, 300),
    ).toThrow('simulated handoff failure');
    expect(store.get(SESSION_ID)).toMatchObject({
      runId: 'run-1',
      revision: 2,
      phase: 'waiting_user',
      status: 'waiting',
      continuationId: questionId,
    });
    expect(store.getContinuation(questionId)?.state).toBe('pending');
    expect(
      sqlite
        .query<{ status: string }, [string]>('SELECT status FROM user_inputs WHERE id = ?')
        .get(questionId),
    ).toEqual({ status: 'pending' });
    expect(store.listRestartHandoffs()).toEqual([]);
    expect(store.listUnpublished().map(({ snapshot }) => snapshot.revision)).toEqual([1, 2]);
  });

  test('leases a restart handoff to only one worker and rejects every stale claim token', () => {
    store.transition(SESSION_ID, { kind: 'start', runId: 'run-1' }, 100);
    const waiting = store.parkForQuestion(
      SESSION_ID,
      'run-1',
      1,
      'awaiting_user_input',
      QUESTION,
      200,
    );
    const answered = store.answerQuestion(
      SESSION_ID,
      'run-1',
      2,
      waiting.question.questionId,
      'Desktop',
      false,
      300,
    )!;
    const handoffId = answered.handoff!.id;
    const contender = new SessionRunStore(sqlite);

    const first = store.claimRestartHandoff(handoffId, 'manager-a', 100, 400);
    expect(first).toMatchObject({
      id: handoffId,
      state: 'claimed',
      claimedBy: 'manager-a',
      claimedAt: 400,
      leaseExpiresAt: 500,
      attemptCount: 1,
    });
    expect(contender.claimRestartHandoff(handoffId, 'manager-b', 100, 400)).toBeNull();
    expect(store.renewRestartHandoff(handoffId, 'stale-token', 100, 425)).toBeNull();
    expect(store.renewRestartHandoff(handoffId, first!.claimToken, 100, 425)).toMatchObject({
      leaseExpiresAt: 525,
      attemptCount: 1,
    });
    expect(store.listPendingRestartHandoffs()).toEqual([]);
    expect(store.requeueRestartHandoff(handoffId, 'stale-token', 'must not win', 450)).toBeNull();
    expect(store.consumeRestartHandoff(handoffId, 'stale-token', 450)).toBeNull();

    expect(
      store.requeueRestartHandoff(handoffId, first!.claimToken, 'admission failed', 450),
    ).toMatchObject({
      id: handoffId,
      state: 'pending',
      lastError: 'admission failed',
      attemptCount: 1,
    });
    expect(store.consumeRestartHandoff(handoffId, first!.claimToken, 451)).toBeNull();
    const second = contender.claimRestartHandoff(handoffId, 'manager-b', 100, 451)!;
    expect(second).toMatchObject({ claimedBy: 'manager-b', attemptCount: 2 });
    expect(store.consumeRestartHandoff(handoffId, second.claimToken, 452)).toMatchObject({
      id: handoffId,
      state: 'consumed',
      consumedAt: 452,
      attemptCount: 2,
    });
    expect(store.listRestartHandoffs()).toEqual([]);
    expect(contender.claimRestartHandoff(handoffId, 'manager-c', 100, 453)).toBeNull();
  });

  test('terminally abandons a claimed handoff without making it claimable again', () => {
    store.transition(SESSION_ID, { kind: 'start', runId: 'run-1' }, 100);
    const waiting = store.parkForQuestion(
      SESSION_ID,
      'run-1',
      1,
      'awaiting_user_input',
      QUESTION,
      200,
    );
    const handoff = store.answerQuestion(
      SESSION_ID,
      'run-1',
      2,
      waiting.question.questionId,
      'Desktop',
      false,
      300,
    )!.handoff!;
    const claimed = store.claimRestartHandoff(handoff.id, 'manager-a', 100, 400)!;

    expect(
      store.abandonRestartHandoff(
        handoff.id,
        claimed.claimToken,
        'user cancelled replacement turn',
        425,
      ),
    ).toMatchObject({
      state: 'consumed',
      consumedAt: 425,
      lastError: 'user cancelled replacement turn',
    });
    expect(store.listRestartHandoffs()).toEqual([]);
    expect(store.claimRestartHandoff(handoff.id, 'manager-b', 100, 426)).toBeNull();
  });

  test('recovers an expired claim without allowing its former owner to consume', () => {
    store.transition(SESSION_ID, { kind: 'start', runId: 'run-1' }, 100);
    const waiting = store.parkForQuestion(
      SESSION_ID,
      'run-1',
      1,
      'awaiting_user_input',
      QUESTION,
      200,
    );
    const handoff = store.answerQuestion(
      SESSION_ID,
      'run-1',
      2,
      waiting.question.questionId,
      'Desktop',
      false,
      300,
    )!.handoff!;
    const first = store.claimRestartHandoff(handoff.id, 'manager-a', 100, 400)!;

    // Simulate the claiming worker disappearing. Claiming did not manufacture
    // a replacement SessionRun, and a fresh worker can recover the lease.
    const afterWorkerCrash = new SessionRunStore(sqlite);
    expect(afterWorkerCrash.get(SESSION_ID)).toMatchObject({
      runId: 'run-1',
      revision: 3,
      status: 'terminal',
    });
    expect(afterWorkerCrash.requeueExpiredRestartHandoffs(499)).toBe(0);
    expect(afterWorkerCrash.consumeRestartHandoff(handoff.id, first.claimToken, 500)).toBeNull();
    expect(afterWorkerCrash.requeueExpiredRestartHandoffs(500)).toBe(1);
    expect(afterWorkerCrash.getRestartHandoff(handoff.id)).toMatchObject({
      state: 'pending',
      claimToken: null,
      claimedBy: null,
      leaseExpiresAt: null,
      lastError: 'claim lease expired',
      attemptCount: 1,
    });
    expect(afterWorkerCrash.consumeRestartHandoff(handoff.id, first.claimToken, 501)).toBeNull();
    expect(
      afterWorkerCrash.requeueRestartHandoff(handoff.id, first.claimToken, 'stale owner', 501),
    ).toBeNull();

    const second = afterWorkerCrash.claimRestartHandoff(handoff.id, 'manager-b', 100, 501)!;
    expect(second).toMatchObject({ claimedBy: 'manager-b', attemptCount: 2 });
    expect(second.claimToken).not.toBe(first.claimToken);
    expect(afterWorkerCrash.consumeRestartHandoff(handoff.id, first.claimToken, 502)).toBeNull();
    expect(
      afterWorkerCrash.consumeRestartHandoff(handoff.id, second.claimToken, 502),
    ).toMatchObject({
      state: 'consumed',
      attemptCount: 2,
    });
  });

  test('rolls the entire question wait back when durable input insertion fails', () => {
    store.transition(SESSION_ID, { kind: 'start', runId: 'run-1' }, 100);
    sqlite.exec(`
      CREATE TRIGGER reject_question_insert
      BEFORE INSERT ON user_inputs
      BEGIN
        SELECT RAISE(ABORT, 'simulated durable input failure');
      END;
    `);

    expect(() =>
      store.parkForQuestion(SESSION_ID, 'run-1', 1, 'awaiting_user_input', QUESTION, 200),
    ).toThrow('simulated durable input failure');
    expect(store.get(SESSION_ID)).toMatchObject({
      revision: 1,
      phase: 'analyzing',
      status: 'active',
      continuationId: null,
    });
    expect(
      sqlite.query<{ count: number }, []>('SELECT count(*) AS count FROM user_inputs').get()?.count,
    ).toBe(0);
    expect(
      sqlite
        .query<{ count: number }, []>('SELECT count(*) AS count FROM session_run_continuations')
        .get()?.count,
    ).toBe(0);
    expect(store.listUnpublished()).toHaveLength(1);
  });

  test('cancels the owned pending question in the same terminal transition', () => {
    store.transition(SESSION_ID, { kind: 'start', runId: 'run-1' }, 100);
    const waiting = store.parkForQuestion(
      SESSION_ID,
      'run-1',
      1,
      'awaiting_user_input',
      QUESTION,
      200,
    );
    store.transition(
      SESSION_ID,
      {
        kind: 'cancel',
        expectedRunId: 'run-1',
        expectedRevision: 2,
        reason: 'cancelled_by_user',
      },
      300,
    );

    expect(store.get(SESSION_ID)).toMatchObject({
      revision: 3,
      phase: 'cancelled',
      status: 'terminal',
      continuationId: null,
    });
    expect(store.getContinuation(waiting.question.questionId!)?.state).toBe('cancelled');
    const input = sqlite
      .query<{ status: string; input_data: string }, [string]>(
        'SELECT status, input_data FROM user_inputs WHERE id = ?',
      )
      .get(waiting.question.questionId!);
    expect(input?.status).toBe('cancelled');
    expect(JSON.parse(input!.input_data)).toMatchObject({
      status: 'cancelled',
      answer: '__cancelled__',
    });
    expect(
      sqlite
        .query<{ count: number }, [string]>(
          `SELECT count(*) AS count FROM user_inputs
           WHERE session_id = ? AND (status = 'pending' OR status IS NULL)`,
        )
        .get(SESSION_ID)?.count,
    ).toBe(0);
  });

  test('quarantines a poison outbox row without blocking the next valid event', () => {
    store.transition(SESSION_ID, { kind: 'start', runId: 'run-1' }, 100);
    store.transition(
      SESSION_ID,
      {
        kind: 'phase',
        expectedRunId: 'run-1',
        expectedRevision: 1,
        phase: 'thinking',
      },
      200,
    );
    const first = sqlite
      .query<{ event_id: string }, []>(
        'SELECT event_id FROM session_run_events ORDER BY created_at ASC LIMIT 1',
      )
      .get();
    sqlite
      .query('UPDATE session_run_events SET payload = ? WHERE event_id = ?')
      .run('{not-json', first!.event_id);

    const publishable = store.listUnpublished();
    expect(publishable).toHaveLength(1);
    expect(publishable[0]?.snapshot).toMatchObject({ revision: 2, phase: 'thinking' });
    expect(
      sqlite
        .query<{ dead_letter_reason: string | null }, [string]>(
          'SELECT dead_letter_reason FROM session_run_events WHERE event_id = ?',
        )
        .get(first!.event_id)?.dead_letter_reason,
    ).toBeTruthy();
  });

  test('only resumes a process wait after every exact durable process is terminal', () => {
    sqlite.exec(`
      INSERT INTO supervised_processes
        (id, session_id, status, provenance, supervision, is_background)
      VALUES
        ('proc-a', '${SESSION_ID}', 'running', 'agent-tool', 'owned-child', 1),
        ('proc-b', '${SESSION_ID}', 'exited', 'agent-tool', 'owned-child', 1);
    `);
    store.transition(SESSION_ID, { kind: 'start', runId: 'run-1' }, 100);
    const waiting = store.parkForProcesses(
      SESSION_ID,
      'run-1',
      1,
      ['proc-b', 'proc-a', 'proc-a'],
      'background process is still running',
      200,
    );

    expect(waiting.processIds).toEqual(['proc-a', 'proc-b']);
    expect(
      sqlite
        .query<{ process_id: string }, []>(
          `SELECT process_id FROM session_run_continuation_processes ORDER BY process_id`,
        )
        .all(),
    ).toEqual([{ process_id: 'proc-a' }, { process_id: 'proc-b' }]);
    expect(() =>
      sqlite.query(`DELETE FROM supervised_processes WHERE id = 'proc-a'`).run(),
    ).toThrow('FOREIGN KEY constraint failed');
    // The payload remains readable for older binaries, but it no longer owns
    // process identity. A stale compatibility projection cannot redirect the wait.
    sqlite
      .query(`UPDATE session_run_continuations SET payload = ? WHERE id = ?`)
      .run(
        JSON.stringify({ processIds: ['payload-only'] }),
        waiting.payload.snapshot.continuationId!,
      );
    expect(new SessionRunStore(sqlite).listProcessWaits()).toEqual([
      expect.objectContaining({
        snapshot: expect.objectContaining({
          runId: 'run-1',
          revision: 2,
          phase: 'waiting_terminal',
        }),
        continuation: expect.objectContaining({
          id: waiting.payload.snapshot.continuationId,
          kind: 'process_set',
          state: 'pending',
        }),
        processIds: ['proc-a', 'proc-b'],
      }),
    ]);
    expect(() => store.resumeProcessWait(SESSION_ID, 'run-1', 2, 300)).toThrow(
      'Process continuation is not ready',
    );
    expect(store.get(SESSION_ID)).toMatchObject({ revision: 2, phase: 'waiting_terminal' });

    sqlite
      .query(
        `UPDATE supervised_processes
         SET status = 'exited', session_id = 'different-session'
         WHERE id = 'proc-a'`,
      )
      .run();
    expect(() => store.resumeProcessWait(SESSION_ID, 'run-1', 2, 350)).toThrow(
      'Process continuation references a process outside agent ownership',
    );
    expect(store.get(SESSION_ID)).toMatchObject({ revision: 2, phase: 'waiting_terminal' });

    sqlite
      .query(`UPDATE supervised_processes SET session_id = ? WHERE id = 'proc-a'`)
      .run(SESSION_ID);
    sqlite
      .query(
        `UPDATE supervised_processes SET terminal_reason = 'session-cancelled' WHERE id = 'proc-a'`,
      )
      .run();
    expect(() => store.resumeProcessWait(SESSION_ID, 'run-1', 2, 375)).toThrow(
      'Process continuation ended through cancellation or restart',
    );
    sqlite
      .query(`UPDATE supervised_processes SET terminal_reason = NULL WHERE id = 'proc-a'`)
      .run();
    const resumed = store.resumeProcessWait(SESSION_ID, 'run-1', 2, 400);
    expect(resumed.payload.snapshot).toMatchObject({
      revision: 3,
      phase: 'analyzing',
      status: 'active',
      continuationId: null,
    });
    expect(resumed.continuationId).toBe(waiting.payload.snapshot.continuationId!);
    expect(store.getContinuation(waiting.payload.snapshot.continuationId!)?.state).toBe('claimed');
    expect(store.listClaimedProcessWakes()).toMatchObject([
      {
        snapshot: { runId: 'run-1', revision: 3, status: 'active' },
        continuation: { id: waiting.payload.snapshot.continuationId, state: 'claimed' },
        processIds: ['proc-a', 'proc-b'],
      },
    ]);
    expect(
      sqlite
        .query<{ count: number }, []>(
          `SELECT COUNT(*) AS count FROM session_run_continuation_processes`,
        )
        .get()?.count,
    ).toBe(2);

    store.transition(
      SESSION_ID,
      {
        kind: 'complete',
        expectedRunId: 'run-1',
        expectedRevision: 3,
        reason: 'process continuation projected',
      },
      500,
    );
    expect(store.getContinuation(waiting.payload.snapshot.continuationId!)?.state).toBe('consumed');
    expect(store.listClaimedProcessWakes()).toEqual([]);
    expect(
      sqlite
        .query<{ count: number }, []>(
          `SELECT COUNT(*) AS count FROM session_run_continuation_processes`,
        )
        .get()?.count,
    ).toBe(0);
  });

  test('keeps a resumed process command discoverable until crash recovery fails it visibly', async () => {
    sqlite.exec(`
      INSERT INTO supervised_processes
        (id, session_id, status, provenance, supervision, is_background, terminal_reason)
      VALUES ('proc-crash', '${SESSION_ID}', 'exited', 'agent-tool', 'owned-child', 1, 'completed');
    `);
    store.transition(SESSION_ID, { kind: 'start', runId: 'run-crash' }, 100);
    const waiting = store.parkForProcesses(
      SESSION_ID,
      'run-crash',
      1,
      ['proc-crash'],
      'waiting for crash boundary',
      200,
    );
    store.resumeProcessWait(SESSION_ID, 'run-crash', 2, 300);

    const afterCrash = new SessionRunStore(sqlite);
    expect(afterCrash.get(SESSION_ID)).toMatchObject({
      runId: 'run-crash',
      revision: 3,
      phase: 'analyzing',
      status: 'active',
    });
    expect(afterCrash.listClaimedProcessWakes()).toMatchObject([
      {
        continuation: { id: waiting.continuationId, state: 'claimed' },
        processIds: ['proc-crash'],
        expectedBoundary: { activeMessageId: null, providerConversationRevision: 0 },
      },
    ]);

    const coordinator = new SessionRunCoordinator(afterCrash, () => undefined);
    expect(await coordinator.recoverInterruptedRuns()).toBe(1);
    expect(afterCrash.get(SESSION_ID)).toMatchObject({
      phase: 'error',
      status: 'terminal',
      terminalReason: 'backend_restarted_during_active_run',
    });
    expect(afterCrash.getContinuation(waiting.continuationId)?.state).toBe('cancelled');
    expect(afterCrash.listClaimedProcessWakes()).toEqual([]);
  });

  test('rolls back a process wait when normalized ownership cannot be established', () => {
    store.transition(SESSION_ID, { kind: 'start', runId: 'run-1' }, 100);

    expect(() =>
      store.parkForProcesses(
        SESSION_ID,
        'run-1',
        1,
        ['missing-process'],
        'must not strand a wait',
        200,
      ),
    ).toThrow('Process continuation references missing process state');
    expect(store.get(SESSION_ID)).toMatchObject({
      revision: 1,
      phase: 'analyzing',
      status: 'active',
      continuationId: null,
    });
    expect(
      sqlite
        .query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM session_run_continuations`)
        .get()?.count,
    ).toBe(0);
    expect(
      sqlite
        .query<{ count: number }, []>(
          `SELECT COUNT(*) AS count FROM session_run_continuation_processes`,
        )
        .get()?.count,
    ).toBe(0);
  });
});

describe('SessionRunCoordinator', () => {
  test('retains a failed publication and drains it after restart', async () => {
    const sqlite = createDatabase();
    const store = new SessionRunStore(sqlite);
    const failing = new SessionRunCoordinator(store, () => {
      throw new Error('renderer unavailable');
    });

    await expect(failing.start(SESSION_ID)).resolves.toMatchObject({ phase: 'analyzing' });
    expect(store.get(SESSION_ID)?.phase).toBe('analyzing');
    expect(store.listUnpublished()).toHaveLength(1);

    const published: WSMessage[] = [];
    const recovered = new SessionRunCoordinator(store, (_sessionId, message) => {
      published.push(message);
    });
    expect(await recovered.drainOutbox()).toBe(1);
    expect(published[0]?.type).toBe('run.state');
    expect(store.listUnpublished()).toHaveLength(0);
  });

  test('runtime outbox pump retries a transient publication failure', async () => {
    const sqlite = createDatabase();
    const store = new SessionRunStore(sqlite);
    let available = false;
    const published: WSMessage[] = [];
    const coordinator = new SessionRunCoordinator(store, (_sessionId, message) => {
      if (!available) throw new Error('temporary projection outage');
      published.push(message);
    });

    await coordinator.start(SESSION_ID);
    expect(store.listUnpublished()).toHaveLength(1);
    available = true;
    coordinator.startOutboxPump(5);
    await new Promise((resolve) => setTimeout(resolve, 30));
    coordinator.stopOutboxPump();

    expect(published).toHaveLength(1);
    expect(store.listUnpublished()).toHaveLength(0);
  });

  test('terminalizes active provider work after backend restart', async () => {
    const sqlite = createDatabase();
    const store = new SessionRunStore(sqlite);
    const coordinator = new SessionRunCoordinator(store, () => undefined);
    await coordinator.start(SESSION_ID);

    const restarted = new SessionRunCoordinator(store, () => undefined);
    expect(await restarted.recoverInterruptedRuns()).toBe(1);
    expect(store.get(SESSION_ID)).toMatchObject({
      phase: 'error',
      status: 'terminal',
      terminalReason: 'backend_restarted_during_active_run',
    });
  });

  test('closes every durably active worker card after backend restart', async () => {
    const sqlite = createDatabase();
    const store = new SessionRunStore(sqlite);
    store.transition(SESSION_ID, {
      kind: 'start',
      runId: 'run-with-workers',
      activeAgentIds: ['kory-manager', 'worker-one', 'critic-one'],
    });
    const published: WSMessage[] = [];
    const restarted = new SessionRunCoordinator(store, (_sessionId, message) => {
      published.push(message);
    });

    expect(await restarted.recoverInterruptedRuns()).toBe(1);
    expect(published).toEqual([
      expect.objectContaining({
        type: 'run.state',
        payload: expect.objectContaining({
          snapshot: expect.objectContaining({ phase: 'error', status: 'terminal' }),
        }),
      }),
      expect.objectContaining({
        type: 'agent.status',
        payload: {
          agentId: 'critic-one',
          status: 'error',
          detail: 'Interrupted by backend restart',
        },
      }),
      expect.objectContaining({
        type: 'agent.status',
        payload: {
          agentId: 'kory-manager',
          status: 'error',
          detail: 'Interrupted by backend restart',
        },
      }),
      expect.objectContaining({
        type: 'agent.status',
        payload: {
          agentId: 'worker-one',
          status: 'error',
          detail: 'Interrupted by backend restart',
        },
      }),
    ]);
    sqlite.close();
  });

  test('retains a durable user wait across restart and can cancel without an in-memory lease', async () => {
    const sqlite = createDatabase();
    const store = new SessionRunStore(sqlite);
    const coordinator = new SessionRunCoordinator(store, () => undefined);
    const started = await coordinator.start(SESSION_ID);
    await coordinator.waitForQuestion(SESSION_ID, started.runId!, started.revision, QUESTION);

    const restarted = new SessionRunCoordinator(new SessionRunStore(sqlite), () => undefined);
    expect(await restarted.recoverInterruptedRuns()).toBe(0);
    expect(restarted.get(SESSION_ID)).toMatchObject({
      phase: 'waiting_user',
      status: 'waiting',
    });

    await restarted.cancelCurrent(SESSION_ID);
    expect(restarted.get(SESSION_ID)).toMatchObject({
      phase: 'cancelled',
      status: 'terminal',
    });
  });

  test('terminalizes a waiting run whose continuation was lost across restart', async () => {
    const sqlite = createDatabase();
    const store = new SessionRunStore(sqlite);
    const coordinator = new SessionRunCoordinator(store, () => undefined);
    const started = await coordinator.start(SESSION_ID);
    const waiting = await coordinator.waitForQuestion(
      SESSION_ID,
      started.runId!,
      started.revision,
      QUESTION,
    );
    sqlite
      .query('DELETE FROM session_run_continuations WHERE id = ?')
      .run(waiting.question.questionId!);

    const restarted = new SessionRunCoordinator(new SessionRunStore(sqlite), () => undefined);
    expect(await restarted.recoverOrphanedWaits()).toBe(1);
    expect(restarted.get(SESSION_ID)).toMatchObject({
      revision: 3,
      phase: 'error',
      status: 'terminal',
      terminalReason: 'orphaned_waiting_user',
      continuationId: null,
    });
    sqlite.close();
  });
});
