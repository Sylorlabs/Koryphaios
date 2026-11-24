import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { MIGRATIONS } from '../db/migrations';
import {
  RESTART_RESUME_SOURCE_PREFIX,
  SessionRunCoordinator,
  type InterruptedRunRecoveryOptions,
} from './session-run-coordinator';
import { RunResumptionStore } from './run-resumption-store';
import {
  admitPendingRunResumes,
  restartResumeCommandKey,
  type RestartContinuationAdmit,
} from './restart-resume';
import {
  BACKEND_RESTART_INTERRUPTED_REASON,
  canonicalSessionTurnInputHash,
  SessionRunStore,
  type SessionTurnCommandSource,
} from './session-run-store';
import type { SessionTurnSubmission } from '../kory/manager';
import { renderRestartContinuationPrompt, renderPartialOutput, CONTINUATION_PARTIAL_OUTPUT_LIMIT } from './continuation-prompt';

const SESSION_ID = 'session-resume-test';

/** A disk-less database that behaves like the running app's schema. */
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
    VALUES ('${SESSION_ID}', 'Resume test', 1, 1);
  `);
  for (const version of ['0032', '0033', '0037', '0038', '0043', '0056', '0062']) {
    const migration = MIGRATIONS.find((item) => item.version === version);
    if (!migration) throw new Error(`${version} migration missing`);
    sqlite.exec(migration.up);
  }
  return sqlite;
}

function input(source: SessionTurnCommandSource, sourceCommandId: string, message = 'work') {
  return {
    sessionId: SESSION_ID,
    source,
    sourceCommandId,
    inputHash: canonicalSessionTurnInputHash({ userMessage: message }),
  };
}

/** One "process lifetime": a fresh store and coordinator over the same database. */
function boot(sqlite: Database) {
  const store = new SessionRunStore(sqlite);
  const resumptions = new RunResumptionStore(sqlite);
  const coordinator = new SessionRunCoordinator(store, () => undefined, resumptions);
  return { store, resumptions, coordinator };
}

function acceptedSubmission(sessionId: string, runId: string): SessionTurnSubmission {
  return {
    accepted: true,
    sessionId,
    runId,
    userMessageId: 'unused',
    completion: Promise.resolve({
      sessionId,
      runId,
      status: 'completed',
      phase: 'done',
      reason: 'completed',
    }),
  } as SessionTurnSubmission;
}

describe('restart resume of interrupted runs', () => {
  let sqlite: Database;

  beforeEach(() => {
    sqlite = createDatabase();
  });

  afterEach(() => {
    sqlite.close();
  });

  test('a restart-interrupted run is resumed exactly once across repeated restarts', async () => {
    const first = boot(sqlite);
    const started = first.store.beginSessionTurnCommand(input('user', 'turn-1'), 100);
    expect(started.disposition).toBe('started');

    // Crash: the next process recovers with resume enabled.
    const second = boot(sqlite);
    const options: InterruptedRunRecoveryOptions = { resumeInterruptedRuns: true };
    expect(await second.coordinator.recoverInterruptedRuns(options)).toBe(1);
    expect(second.store.get(SESSION_ID)).toMatchObject({
      status: 'terminal',
      terminalReason: BACKEND_RESTART_INTERRUPTED_REASON,
    });
    expect(second.coordinator.listPendingRunResumes()).toEqual([
      expect.objectContaining({
        sourceRunId: started.command.runId,
        state: 'pending',
        reason: BACKEND_RESTART_INTERRUPTED_REASON,
      }),
    ]);

    const admit = recordingAdmit(second.store);
    const firstPass = await admitPendingRunResumes(second.coordinator, admit, { enabled: true });
    expect(firstPass).toEqual({ admitted: 1, deferred: 0, skipped: 0 });
    expect(admit.calls).toEqual([{ sessionId: SESSION_ID, sourceRunId: started.command.runId }]);

    // Another restart: the continuation is never admitted a second time.
    // The continuation itself is active at this point, so the third boot marks
    // it interrupted. That continuation is never queued for another resume.
    const third = boot(sqlite);
    expect(await third.coordinator.recoverInterruptedRuns({ resumeInterruptedRuns: true })).toBe(
      1,
    );
    expect(third.coordinator.listPendingRunResumes()).toEqual([]);
    const secondPass = await admitPendingRunResumes(third.coordinator, admit, { enabled: true });
    expect(secondPass).toEqual({ admitted: 0, deferred: 0, skipped: 0 });
    expect(admit.calls).toHaveLength(1);
  });

  test('the continuation is keyed by the interrupted run, so its receipt is idempotent', async () => {
    const first = boot(sqlite);
    const started = first.store.beginSessionTurnCommand(input('user', 'turn-idem'), 100);
    const second = boot(sqlite);
    await second.coordinator.recoverInterruptedRuns({ resumeInterruptedRuns: true });
    const pending = second.coordinator.listPendingRunResumes();
    expect(pending).toHaveLength(1);
    // Admission records the derived command key, which the ledger can look up.
    const key = restartResumeCommandKey(SESSION_ID, started.command.runId);
    const continuation = second.store.beginSessionTurnCommand(
      {
        sessionId: SESSION_ID,
        source: 'internal',
        sourceCommandId: `${RESTART_RESUME_SOURCE_PREFIX}${started.command.runId}`,
        inputHash: canonicalSessionTurnInputHash({ resume: started.command.runId }),
      },
      200,
    );
    expect(continuation.command.commandKey).toBe(key);
    // A replayed begin returns the same receipt rather than a second run.
    const replay = second.store.beginSessionTurnCommand(
      {
        sessionId: SESSION_ID,
        source: 'internal',
        sourceCommandId: `${RESTART_RESUME_SOURCE_PREFIX}${started.command.runId}`,
        inputHash: canonicalSessionTurnInputHash({ resume: started.command.runId }),
      },
      300,
    );
    expect(replay.disposition).toBe('existing');
    expect(replay.command.runId).toBe(continuation.command.runId);
  });

  test('a continuation cut off by a second restart is never resumed again (crash loop guard)', async () => {
    const first = boot(sqlite);
    const original = first.store.beginSessionTurnCommand(input('user', 'turn-loop'), 100);

    // Boot 2: resume the original run into a continuation.
    const second = boot(sqlite);
    await second.coordinator.recoverInterruptedRuns({ resumeInterruptedRuns: true });
    const admit = recordingAdmit(second.store);
    await admitPendingRunResumes(second.coordinator, admit, { enabled: true });
    expect(admit.calls).toHaveLength(1);

    // Boot 3: the continuation itself is interrupted. It must not be resumed.
    const third = boot(sqlite);
    expect(await third.coordinator.recoverInterruptedRuns({ resumeInterruptedRuns: true })).toBe(
      1,
    );
    expect(third.coordinator.listPendingRunResumes()).toEqual([]);
    expect(await admitPendingRunResumes(third.coordinator, admit, { enabled: true })).toEqual({
      admitted: 0,
      deferred: 0,
      skipped: 0,
    });
    expect(admit.calls).toHaveLength(1);
    expect(third.resumptions.getRunResume(original.command.runId)).toMatchObject({
      state: 'admitted',
    });
  });

  test('a run the user stopped never resumes', async () => {
    const first = boot(sqlite);
    const started = first.store.beginSessionTurnCommand(input('user', 'turn-stop'), 100);
    const stopped = first.store.transition(
      SESSION_ID,
      {
        kind: 'cancel',
        expectedRunId: started.command.runId,
        expectedRevision: first.store.get(SESSION_ID)!.revision,
        reason: 'cancelled_by_user',
      },
      150,
    );
    expect(stopped.payload.snapshot.status).toBe('terminal');

    const second = boot(sqlite);
    expect(await second.coordinator.recoverInterruptedRuns({ resumeInterruptedRuns: true })).toBe(
      0,
    );
    expect(second.coordinator.listPendingRunResumes()).toEqual([]);
    const admit = recordingAdmit(second.store);
    expect(await admitPendingRunResumes(second.coordinator, admit, { enabled: true })).toEqual({
      admitted: 0,
      deferred: 0,
      skipped: 0,
    });
    expect(admit.calls).toEqual([]);
  });

  test('with the setting off, the run is still marked interrupted but never resumed', async () => {
    const first = boot(sqlite);
    first.store.beginSessionTurnCommand(input('user', 'turn-off'), 100);
    const second = boot(sqlite);
    expect(await second.coordinator.recoverInterruptedRuns({ resumeInterruptedRuns: false })).toBe(
      1,
    );
    expect(second.store.get(SESSION_ID)?.terminalReason).toBe(BACKEND_RESTART_INTERRUPTED_REASON);
    expect(second.coordinator.listPendingRunResumes()).toEqual([]);
  });

  test('a setting turned off before admission marks pending resumes skipped, not admitted', async () => {
    const first = boot(sqlite);
    const started = first.store.beginSessionTurnCommand(input('user', 'turn-disabled'), 100);
    const second = boot(sqlite);
    await second.coordinator.recoverInterruptedRuns({ resumeInterruptedRuns: true });
    const admit = recordingAdmit(second.store);
    expect(await admitPendingRunResumes(second.coordinator, admit, { enabled: false })).toEqual({
      admitted: 0,
      deferred: 0,
      skipped: 1,
    });
    expect(admit.calls).toEqual([]);
    expect(second.resumptions.getRunResume(started.command.runId)).toMatchObject({
      state: 'skipped',
      reason: 'resume_disabled',
    });
  });

  test('a busy session defers the continuation to the next boot', async () => {
    const first = boot(sqlite);
    const started = first.store.beginSessionTurnCommand(input('user', 'turn-busy'), 100);
    const second = boot(sqlite);
    await second.coordinator.recoverInterruptedRuns({ resumeInterruptedRuns: true });
    const busy: RestartContinuationAdmit = async (sessionId) =>
      ({
        accepted: false,
        result: { sessionId, runId: '', status: 'rejected', phase: 'idle', reason: 'session_busy' },
      }) as SessionTurnSubmission;
    expect(await admitPendingRunResumes(second.coordinator, busy, { enabled: true })).toEqual({
      admitted: 0,
      deferred: 1,
      skipped: 0,
    });
    expect(second.resumptions.getRunResume(started.command.runId)?.state).toBe('pending');
  });

  test('an admission that throws is skipped with its reason instead of retried forever', async () => {
    const first = boot(sqlite);
    const started = first.store.beginSessionTurnCommand(input('user', 'turn-throw'), 100);
    const second = boot(sqlite);
    await second.coordinator.recoverInterruptedRuns({ resumeInterruptedRuns: true });
    const throwing: RestartContinuationAdmit = async () => {
      throw new Error('Recover this archived chat before starting new work.');
    };
    expect(await admitPendingRunResumes(second.coordinator, throwing, { enabled: true })).toEqual({
      admitted: 0,
      deferred: 0,
      skipped: 1,
    });
    expect(second.resumptions.getRunResume(started.command.runId)?.state).toBe('skipped');
  });
});

describe('continuation prompt', () => {
  test('renders persisted text and tool parts and says when nothing was persisted', () => {
    expect(renderPartialOutput(undefined)).toContain('No partial output');
    expect(
      renderPartialOutput([
        { kind: 'text', text: 'Looked at the parser.', startedAt: 1 },
        {
          kind: 'tool',
          callId: 'c1',
          name: 'read_file',
          input: {},
          startedAt: 2,
          output: 'contents',
        },
      ]),
    ).toBe('Looked at the parser.\n\n[tool read_file: ok] -> contents');
  });

  test('keeps the newest partial output within the bound', () => {
    const big = 'x'.repeat(CONTINUATION_PARTIAL_OUTPUT_LIMIT * 2) + 'TAIL';
    const rendered = renderPartialOutput([{ kind: 'text', text: big, startedAt: 1 }]);
    expect(rendered.length).toBeLessThanOrEqual(CONTINUATION_PARTIAL_OUTPUT_LIMIT + 1);
    expect(rendered.endsWith('TAIL')).toBe(true);
  });

  test('the restart prompt is host-authored instructions, not a user request', () => {
    const prompt = renderRestartContinuationPrompt(undefined);
    expect(prompt.startsWith('The previous run was interrupted by a restart; continue from where you left off.')).toBe(true);
    expect(prompt).toContain('Do not restart the task');
  });
});

/** Admission stub that writes a real continuation command, like startSessionTurn does. */
function recordingAdmit(store: SessionRunStore) {
  const calls: Array<{ sessionId: string; sourceRunId: string }> = [];
  const admit = (async (sessionId: string, sourceRunId: string) => {
    calls.push({ sessionId, sourceRunId });
    const sourceCommandId = `${RESTART_RESUME_SOURCE_PREFIX}${sourceRunId}`;
    const started = store.beginSessionTurnCommand(
      {
        sessionId,
        source: 'internal',
        sourceCommandId,
        inputHash: canonicalSessionTurnInputHash({ resume: sourceRunId }),
      },
      Date.now(),
    );
    return acceptedSubmission(sessionId, started.command.runId);
  }) as RestartContinuationAdmit & { calls: typeof calls };
  admit.calls = calls;
  return admit;
}
