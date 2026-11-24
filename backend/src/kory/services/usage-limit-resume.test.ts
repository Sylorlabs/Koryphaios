import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { PendingResumePayload } from '@koryphaios/shared';
import { MIGRATIONS } from '../../db/migrations';
import { RunResumptionStore } from '../../runs/run-resumption-store';
import type { SessionTurnResult, SessionTurnSubmission } from '../manager';
import {
  isUsageLimitMessage,
  type UsageLimitAdmitInput,
  UsageLimitResumeService,
  USAGE_LIMIT_BUSY_RETRY_MS,
} from './usage-limit-resume';
import { USAGE_LIMIT_BACKOFF_MS } from '../../providers/usage-limit-reset';

const SESSION = 'session-usage-limit';
const MINUTE = 60_000;
const LIMIT_TEXT = 'Usage limit reached for this plan.';

function createStore(): { sqlite: Database; store: RunResumptionStore } {
  const sqlite = new Database(':memory:');
  for (const version of ['0062', '0063']) {
    const migration = MIGRATIONS.find((item) => item.version === version);
    if (!migration) throw new Error(`${version} migration missing`);
    sqlite.exec(migration.up);
  }
  return { sqlite, store: new RunResumptionStore(sqlite) };
}

/** Test harness: a controllable clock, a fake admission, and a recorded event stream. */
function harness(store: RunResumptionStore, options: { active?: boolean } = {}) {
  let clock = 1_000_000_000_000;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const events: Array<{ sessionId: string; payload: PendingResumePayload }> = [];
  const admitted: UsageLimitAdmitInput[] = [];
  let next: (input: UsageLimitAdmitInput) => Promise<SessionTurnSubmission> = async (input) => {
    admitted.push(input);
    return accepted(input.sessionId, Promise.resolve(completed(input.sessionId)));
  };
  const service = new UsageLimitResumeService({
    store,
    now: () => clock,
    setTimer: (sessionId, timer) => {
      const previous = timers.get(sessionId);
      if (previous !== undefined) clearTimeout(previous);
      if (timer === undefined) timers.delete(sessionId);
      else timers.set(sessionId, timer);
    },
    getTimer: (sessionId) => timers.get(sessionId),
    isSessionActive: async () => options.active !== false,
    admit: (input) => {
      return next(input);
    },
    emit: (sessionId, payload) => {
      events.push({ sessionId, payload });
    },
  });
  return {
    service,
    events,
    admitted,
    timers,
    advance(ms: number) {
      clock += ms;
    },
    now: () => clock,
    setAdmit(fn: typeof next) {
      next = fn;
    },
  };
}

function accepted(
  sessionId: string,
  completion: Promise<SessionTurnResult>,
): SessionTurnSubmission {
  return {
    accepted: true,
    sessionId,
    runId: 'run-continuation',
    userMessageId: 'msg-continuation',
    completion,
  } as SessionTurnSubmission;
}

function completed(sessionId: string): SessionTurnResult {
  return {
    sessionId,
    runId: 'run-continuation',
    status: 'completed',
    phase: 'done',
    reason: 'completed',
  };
}

function limited(sessionId: string): SessionTurnResult {
  return {
    sessionId,
    runId: 'run-continuation',
    status: 'failed',
    phase: 'error',
    reason: LIMIT_TEXT,
  };
}

describe('usage limit detection', () => {
  test('matches the provider usage-limit wording and nothing else', () => {
    expect(isUsageLimitMessage(LIMIT_TEXT)).toBe(true);
    expect(isUsageLimitMessage('insufficient credits on your account')).toBe(true);
    expect(isUsageLimitMessage('connection reset by peer')).toBe(false);
  });
});

describe('UsageLimitResumeService', () => {
  let sqlite: Database;
  let store: RunResumptionStore;

  beforeEach(() => {
    ({ sqlite, store } = createStore());
  });

  afterEach(() => {
    sqlite.close();
  });

  test('a limit schedules one durable pending resume on the backoff and emits it', () => {
    const h = harness(store);
    const record = h.service.schedule(SESSION, {
      message: LIMIT_TEXT,
      provider: 'claude',
      model: 'claude-x',
      sourceRunId: 'run-original',
    });
    expect(record).not.toBeNull();
    expect(record!.resumeAt).toBe(h.now() + USAGE_LIMIT_BACKOFF_MS[0]);
    expect(store.getPendingResume(SESSION)).toMatchObject({
      state: 'scheduled',
      attempt: 0,
      provider: 'claude',
      sourceRunId: 'run-original',
    });
    expect(h.timers.has(SESSION)).toBe(true);
    expect(h.events).toEqual([
      {
        sessionId: SESSION,
        payload: {
          pendingResume: expect.objectContaining({
            state: 'scheduled',
            resumeAt: record!.resumeAt,
            attempt: 0,
            maxAttempts: 3,
          }),
        },
      },
    ]);
  });

  test('a stated provider reset is used instead of the backoff', () => {
    const h = harness(store);
    const record = h.service.schedule(SESSION, {
      message: 'Usage limit reached. Try again in 5 minutes.',
      provider: 'codex',
      model: null,
      sourceRunId: null,
    });
    expect(record!.resumeAt).toBe(h.now() + 5 * MINUTE + MINUTE);
  });

  test('resume-now admits a continuation, and a clean outcome clears the pending record', async () => {
    const h = harness(store);
    h.service.schedule(SESSION, {
      message: LIMIT_TEXT,
      provider: 'claude',
      model: null,
      sourceRunId: 'run-a',
    });
    expect(await h.service.resumeNow(SESSION)).toBe('started');
    await flush();
    expect(h.admitted).toEqual([
      expect.objectContaining({ sessionId: SESSION, attempt: 1, sourceRunId: 'run-a' }),
    ]);
    expect(store.getPendingResume(SESSION)).toBeNull();
    expect(h.events.at(-1)).toEqual({
      sessionId: SESSION,
      payload: { pendingResume: null, clearedReason: 'resumed' },
    });
  });

  test('a continuation that hits the limit again reschedules on the next backoff step', async () => {
    const h = harness(store);
    h.service.schedule(SESSION, {
      message: LIMIT_TEXT,
      provider: 'claude',
      model: null,
      sourceRunId: null,
    });
    h.setAdmit(async (input) => {
      h.admitted.push(input);
      return accepted(SESSION, Promise.resolve(limited(SESSION)));
    });
    await h.service.resumeNow(SESSION);
    await flush();
    expect(store.getPendingResume(SESSION)).toMatchObject({
      state: 'scheduled',
      attempt: 1,
      resumeAt: h.now() + USAGE_LIMIT_BACKOFF_MS[1],
    });
  });

  test('the attempts are bounded: after the last backoff the chat is exhausted and the row is cleared', async () => {
    const h = harness(store);
    h.service.schedule(SESSION, {
      message: LIMIT_TEXT,
      provider: 'claude',
      model: null,
      sourceRunId: null,
    });
    h.setAdmit(async (input) => {
      h.admitted.push(input);
      return accepted(SESSION, Promise.resolve(limited(SESSION)));
    });
    for (let i = 0; i < 3; i++) {
      await h.service.resumeNow(SESSION);
      await flush();
    }
    expect(h.admitted).toHaveLength(3);
    expect(store.getPendingResume(SESSION)).toBeNull();
    expect(h.events.at(-1)).toEqual({
      sessionId: SESSION,
      payload: { pendingResume: null, clearedReason: 'exhausted' },
    });
  });

  test('a non-limit failure stops automatic retries instead of looping', async () => {
    const h = harness(store);
    h.service.schedule(SESSION, {
      message: LIMIT_TEXT,
      provider: 'claude',
      model: null,
      sourceRunId: null,
    });
    h.setAdmit(async (input) => {
      h.admitted.push(input);
      return accepted(
        SESSION,
        Promise.resolve({ ...limited(SESSION), reason: 'Model rejected the request.' }),
      );
    });
    await h.service.resumeNow(SESSION);
    await flush();
    expect(store.getPendingResume(SESSION)).toBeNull();
    expect(h.events.at(-1)?.payload).toEqual({ pendingResume: null, clearedReason: 'cancelled' });
  });

  test('a busy session defers without consuming an attempt', async () => {
    const h = harness(store);
    h.service.schedule(SESSION, {
      message: LIMIT_TEXT,
      provider: 'claude',
      model: null,
      sourceRunId: null,
    });
    h.setAdmit(async (input) => {
      h.admitted.push(input);
      return {
        accepted: false,
        result: {
          sessionId: SESSION,
          runId: '',
          status: 'rejected',
          phase: 'idle',
          reason: 'session_busy',
        },
      } as SessionTurnSubmission;
    });
    await h.service.resumeNow(SESSION);
    expect(store.getPendingResume(SESSION)).toMatchObject({
      state: 'scheduled',
      attempt: 0,
      resumeAt: h.now() + USAGE_LIMIT_BUSY_RETRY_MS,
    });
  });

  test('a cancelled chat is cleared when its timer fires, without admitting a turn', async () => {
    const h = harness(store, { active: false });
    h.service.schedule(SESSION, {
      message: LIMIT_TEXT,
      provider: 'claude',
      model: null,
      sourceRunId: null,
    });
    await h.service.resumeNow(SESSION);
    expect(h.admitted).toEqual([]);
    expect(store.getPendingResume(SESSION)).toBeNull();
  });

  test('the user cancel clears the record and its timer; a second cancel reports nothing pending', () => {
    const h = harness(store);
    h.service.schedule(SESSION, {
      message: LIMIT_TEXT,
      provider: 'claude',
      model: null,
      sourceRunId: null,
    });
    expect(h.service.cancel(SESSION)).toBe(true);
    expect(store.getPendingResume(SESSION)).toBeNull();
    expect(h.timers.has(SESSION)).toBe(false);
    expect(h.events.at(-1)?.payload).toEqual({ pendingResume: null, clearedReason: 'cancelled' });
    expect(h.service.cancel(SESSION)).toBe(false);
  });

  test('resume-now with nothing pending is not_found', async () => {
    const h = harness(store);
    expect(await h.service.resumeNow(SESSION)).toBe('not_found');
  });

  test('a restart re-arms the pending resume; one that was running fires once on wake', () => {
    const first = harness(store);
    first.service.schedule(SESSION, {
      message: LIMIT_TEXT,
      provider: 'claude',
      model: null,
      sourceRunId: null,
    });
    // Simulate a crash mid-resume: the row is left in the resuming state.
    const record = store.getPendingResume(SESSION)!;
    store.upsertPendingResume({ ...record, state: 'resuming' });

    const second = harness(store);
    expect(second.service.recover()).toBe(1);
    expect(store.getPendingResume(SESSION)).toMatchObject({ state: 'scheduled' });
    expect(second.timers.has(SESSION)).toBe(true);
  });

  test('a limit that arrives while a continuation is already running does not add a second record', async () => {
    const h = harness(store);
    h.service.schedule(SESSION, {
      message: LIMIT_TEXT,
      provider: 'claude',
      model: null,
      sourceRunId: null,
    });
    const record = store.getPendingResume(SESSION)!;
    store.upsertPendingResume({ ...record, state: 'resuming' });
    expect(
      h.service.schedule(SESSION, {
        message: LIMIT_TEXT,
        provider: 'claude',
        model: null,
        sourceRunId: null,
      }),
    ).toBeNull();
    expect(store.getPendingResume(SESSION)?.state).toBe('resuming');
  });
});

/** Let fire-and-forget outcome handlers run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}
