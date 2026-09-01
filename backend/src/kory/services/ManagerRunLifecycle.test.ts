import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { KoryAskUserPayload, SessionRunStatePayload } from '@koryphaios/shared';
import { MIGRATIONS } from '../../db/migrations';
import { SessionRunCoordinator } from '../../runs/session-run-coordinator';
import { canonicalSessionTurnInputHash, SessionRunStore } from '../../runs/session-run-store';
import { ManagerRunLifecycle } from './ManagerRunLifecycle';

const SESSION_ID = 'manager-run-lifecycle-test';

function createCoordinator(
  publish: ConstructorParameters<typeof SessionRunCoordinator>[1] = () => undefined,
): { sqlite: Database; coordinator: SessionRunCoordinator } {
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
    VALUES ('${SESSION_ID}', 'Manager lifecycle test', 1, 1);
  `);
  for (const version of ['0032', '0033', '0037', '0038', '0043']) {
    const migration = MIGRATIONS.find((item) => item.version === version);
    if (!migration) throw new Error(`${version} migration missing`);
    sqlite.exec(migration.up);
  }
  return {
    sqlite,
    coordinator: new SessionRunCoordinator(new SessionRunStore(sqlite), publish),
  };
}

const QUESTION: Omit<KoryAskUserPayload, 'questionId'> = {
  question: 'Which runtime?',
  options: ['Desktop', 'Browser'],
  allowOther: true,
  allowKeepChatting: true,
};

describe('ManagerRunLifecycle', () => {
  let sqlite: Database;
  let coordinator: SessionRunCoordinator;

  beforeEach(() => {
    ({ sqlite, coordinator } = createCoordinator());
  });

  afterEach(() => sqlite.close());

  test('projects one manager lease through phases to a durable terminal state', async () => {
    const lifecycle = new ManagerRunLifecycle(coordinator);
    const handle = await lifecycle.begin(SESSION_ID, 'user_turn');

    await lifecycle.phase(handle, 'thinking', 'provider_reasoning');
    await lifecycle.phase(handle, 'streaming', 'provider_content');
    await lifecycle.finish(handle, 'complete', 'provider_turn_completed');

    expect(coordinator.get(SESSION_ID)).toMatchObject({
      runId: handle.runId,
      revision: 4,
      phase: 'done',
      status: 'terminal',
      terminalReason: 'provider_turn_completed',
    });
  });

  test('persists worker membership even when the manager phase does not change', async () => {
    const lifecycle = new ManagerRunLifecycle(coordinator);
    const handle = await lifecycle.begin(SESSION_ID, 'user_turn');

    await lifecycle.phase(handle, 'analyzing', 'worker_started', [
      'kory-manager',
      'worker-durable',
    ]);
    expect(coordinator.get(SESSION_ID)).toMatchObject({
      revision: 2,
      phase: 'analyzing',
      status: 'active',
      activeAgentIds: ['kory-manager', 'worker-durable'],
    });

    await lifecycle.phase(handle, 'analyzing', 'worker_settled', ['kory-manager']);
    expect(coordinator.get(SESSION_ID)).toMatchObject({
      revision: 3,
      activeAgentIds: ['kory-manager'],
    });
  });

  test('adopts an atomic command run once and never adopts an existing receipt', async () => {
    const lifecycle = new ManagerRunLifecycle(coordinator);
    const input = {
      sessionId: SESSION_ID,
      source: 'goal' as const,
      sourceCommandId: 'goal-command-1',
      inputHash: canonicalSessionTurnInputHash({ userMessage: 'Execute once.' }),
    };
    const begun = await lifecycle.beginCommand(input);
    expect(begun.disposition).toBe('started');
    if (begun.disposition !== 'started') throw new Error('Command was not started');
    expect(begun.handle.runId).toBe(begun.command.runId);
    await lifecycle.finish(begun.handle, 'complete', 'provider_response_persisted');

    const reconstructed = new ManagerRunLifecycle(coordinator);
    await expect(reconstructed.beginCommand(input)).resolves.toMatchObject({
      disposition: 'existing',
      handle: null,
      command: {
        commandKey: begun.command.commandKey,
        runId: begun.command.runId,
        status: 'completed',
        terminalReason: 'provider_response_persisted',
      },
    });
  });

  test('reconstructs a waiting lease after process-local state is lost', async () => {
    const original = new ManagerRunLifecycle(coordinator);
    const originalHandle = await original.begin(SESSION_ID, 'user_turn');
    const question = await original.waitForQuestion(originalHandle, QUESTION);

    const reconstructed = new ManagerRunLifecycle(coordinator);
    const answered = await reconstructed.answerQuestion(
      SESSION_ID,
      'Desktop',
      question.questionId,
      false,
    );
    expect(answered).toMatchObject({
      question,
      handle: null,
      handoff: {
        sessionId: SESSION_ID,
        sourceRunId: originalHandle.runId,
        questionId: question.questionId,
        expectedBoundary: { activeMessageId: null, providerConversationRevision: 0 },
        answer: 'Desktop',
        state: 'pending',
      },
    });
    expect(coordinator.get(SESSION_ID)).toMatchObject({
      runId: originalHandle.runId,
      phase: 'done',
      status: 'terminal',
      terminalReason: 'user_input_handoff_after_restart',
    });

    const resumedHandle = await reconstructed.begin(SESSION_ID, 'user_input_after_restart');
    await reconstructed.finish(resumedHandle, 'complete', 'resumed_turn_completed');

    expect(coordinator.get(SESSION_ID)).toMatchObject({
      runId: resumedHandle.runId,
      phase: 'done',
      status: 'terminal',
      terminalReason: 'resumed_turn_completed',
    });
  });

  test('resumes an in-process question wait through its exact continuation', async () => {
    const lifecycle = new ManagerRunLifecycle(coordinator);
    const handle = await lifecycle.begin(SESSION_ID, 'user_turn');
    const question = await lifecycle.waitForQuestion(handle, QUESTION);

    const answered = await lifecycle.answerQuestion(
      SESSION_ID,
      'Desktop',
      question.questionId,
      true,
    );
    expect(answered?.question).toEqual(question);
    expect(answered?.handle).toMatchObject({ sessionId: SESSION_ID, runId: handle.runId });
    await lifecycle.finish(answered!.handle!, 'complete', 'question_answered');

    expect(coordinator.get(SESSION_ID)).toMatchObject({
      runId: handle.runId,
      revision: 4,
      phase: 'done',
      status: 'terminal',
      terminalReason: 'question_answered',
    });
  });

  test('cancels the durable current run without an in-memory lease', async () => {
    const original = new ManagerRunLifecycle(coordinator);
    const handle = await original.begin(SESSION_ID, 'user_turn');
    sqlite.exec(`
      INSERT INTO supervised_processes
        (id, session_id, status, provenance, supervision, is_background)
      VALUES ('proc-1', '${SESSION_ID}', 'running', 'agent-tool', 'owned-child', 1);
    `);
    await original.waitForProcesses(handle, ['proc-1']);

    const reconstructed = new ManagerRunLifecycle(coordinator);
    await reconstructed.cancelCurrent(SESSION_ID, 'cancelled_after_restart');

    expect(coordinator.get(SESSION_ID)).toMatchObject({
      phase: 'cancelled',
      status: 'terminal',
      terminalReason: 'cancelled_after_restart',
    });
  });

  test('returns a generation handle when a durable process wait resumes after reconstruction', async () => {
    const original = new ManagerRunLifecycle(coordinator);
    const originalHandle = await original.begin(SESSION_ID, 'user_turn');
    sqlite.exec(`
      INSERT INTO supervised_processes
        (id, session_id, status, provenance, supervision, is_background)
      VALUES ('proc-resume', '${SESSION_ID}', 'running', 'agent-tool', 'owned-child', 1);
    `);
    await original.waitForProcesses(originalHandle, ['proc-resume']);
    sqlite.exec(`
      UPDATE supervised_processes
      SET status = 'exited', terminal_reason = 'completed'
      WHERE id = 'proc-resume';
    `);

    const reconstructed = new ManagerRunLifecycle(coordinator);
    const resumed = await reconstructed.resumeProcessWait(SESSION_ID);
    expect(resumed.handle).toMatchObject({
      sessionId: SESSION_ID,
      runId: originalHandle.runId,
    });
    expect(resumed.processIds).toEqual(['proc-resume']);
    expect(resumed.continuationId).toBeString();
    expect(resumed.expectedBoundary).toEqual({
      activeMessageId: null,
      providerConversationRevision: 0,
    });

    await reconstructed.finish(resumed.handle!, 'complete', 'process_result_consumed');
    expect(coordinator.get(SESSION_ID)).toMatchObject({
      runId: originalHandle.runId,
      revision: 4,
      phase: 'done',
      status: 'terminal',
      terminalReason: 'process_result_consumed',
    });
  });

  test('serializes cancellation behind an in-flight phase publication', async () => {
    let releasePhase!: () => void;
    const phaseRelease = new Promise<void>((resolve) => {
      releasePhase = resolve;
    });
    let phasePublicationEntered!: () => void;
    const phaseEntered = new Promise<void>((resolve) => {
      phasePublicationEntered = resolve;
    });
    const replacement = createCoordinator(async (_sessionId, message) => {
      if (message.type !== 'run.state') return;
      const payload = message.payload as SessionRunStatePayload;
      if (payload.transition?.command !== 'phase') return;
      phasePublicationEntered();
      await phaseRelease;
    });
    sqlite.close();
    sqlite = replacement.sqlite;
    coordinator = replacement.coordinator;

    const lifecycle = new ManagerRunLifecycle(coordinator);
    const handle = await lifecycle.begin(SESSION_ID, 'user_turn');
    const phase = lifecycle.phase(handle, 'thinking', 'provider_reasoning');
    await phaseEntered;

    let cancellationSettled = false;
    const cancellation = lifecycle
      .cancelCurrent(SESSION_ID, 'cancelled_during_publication')
      .then(() => {
        cancellationSettled = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cancellationSettled).toBe(false);

    releasePhase();
    await Promise.all([phase, cancellation]);
    expect(coordinator.get(SESSION_ID)).toMatchObject({
      revision: 3,
      phase: 'cancelled',
      status: 'terminal',
      terminalReason: 'cancelled_during_publication',
    });

    await expect(
      lifecycle.phase(handle, 'streaming', 'late_provider_callback'),
    ).resolves.toBeUndefined();
    expect(coordinator.get(SESSION_ID)?.revision).toBe(3);
  });

  test('rejects late run A phase and finish callbacks after run B owns the session', async () => {
    const lifecycle = new ManagerRunLifecycle(coordinator);
    const runA = await lifecycle.begin(SESSION_ID, 'run_a');
    await lifecycle.finish(runA, 'complete', 'run_a_completed');

    const runB = await lifecycle.begin(SESSION_ID, 'run_b');
    const replacement = coordinator.get(SESSION_ID);
    expect(replacement).toMatchObject({
      runId: runB.runId,
      revision: 3,
      phase: 'analyzing',
      status: 'active',
    });

    await lifecycle.phase(runA, 'streaming', 'late_run_a_phase');
    await lifecycle.finish(runA, 'fail', 'late_run_a_finish');

    expect(coordinator.get(SESSION_ID)).toEqual(replacement);

    await lifecycle.phase(runB, 'thinking', 'run_b_reasoning');
    await lifecycle.finish(runB, 'complete', 'run_b_completed');
    expect(coordinator.get(SESSION_ID)).toMatchObject({
      runId: runB.runId,
      revision: 5,
      phase: 'done',
      status: 'terminal',
      terminalReason: 'run_b_completed',
    });
  });

  test('keeps a generation handle when no durable coordinator is installed', async () => {
    const lifecycle = new ManagerRunLifecycle();
    const handle = await lifecycle.begin('local-session', 'local_turn');

    expect(handle.sessionId).toBe('local-session');
    expect(handle.runId).toBeString();
    await lifecycle.phase(handle, 'thinking', 'local_reasoning');
    await lifecycle.waitForProcesses(handle, ['local-process']);

    const resumed = await lifecycle.resumeProcessWait('local-session');
    expect(resumed).toEqual({
      handle,
      processIds: ['local-process'],
      continuationId: null,
      expectedBoundary: null,
    });
    await lifecycle.finish(resumed.handle!, 'complete', 'local_complete');

    await expect(lifecycle.phase(handle, 'streaming', 'late_local_phase')).resolves.toBeUndefined();
  });
});
