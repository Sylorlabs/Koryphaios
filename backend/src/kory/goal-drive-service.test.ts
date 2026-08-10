import { describe, expect, test } from 'bun:test';
import type { Goal, GoalChecklistItem } from '@koryphaios/shared';
import { GoalDriveService, type GoalDriveServiceOptions } from './goal-drive-service';
import type { GoalEvidenceReview } from '../stores/goal-store';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { advanceWorkflow, getWorkflowDefinition, startWorkflow } from './workflows';

const waitFor = async (predicate: () => boolean, timeoutMs = 3_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  expect(predicate()).toBe(true);
};

type Verdict = {
  passed: boolean;
  skipped?: boolean;
  feedback?: string;
  provider?: string;
  model?: string;
};

interface HarnessOptions {
  critic?: Verdict | ((turn: number) => Verdict | Promise<Verdict>);
  blockerVerdict?: Verdict | (() => Verdict | Promise<Verdict>);
  workflow?: boolean;
  root?: string;
  workingDirectory?: string | null;
  sessionMissing?: boolean;
  changes?: Array<{ path: string; operation: 'create' | 'edit' | 'delete' }>;
  checkpointStoreFactory?: GoalDriveServiceOptions['checkpointStoreFactory'];
  acquireSessionMutationBarrier?: GoalDriveServiceOptions['acquireSessionMutationBarrier'];
  acquireAgentToolBarrier?: GoalDriveServiceOptions['acquireAgentToolBarrier'];
  processTask?: (state: { goal: Goal; turn: number }) => Promise<void>;
  onCancel?: () => Promise<void> | void;
}

function harness(options: HarnessOptions = {}) {
  const root = options.root ?? mkdtempSync(join(tmpdir(), 'kory-goal-driver-'));
  const checklist: GoalChecklistItem[] = [
    { id: 'one', title: 'First', status: 'pending', order: 0, dependsOn: [], evidence: [] },
    { id: 'two', title: 'Second', status: 'pending', order: 1, dependsOn: ['one'], evidence: [] },
  ];
  let goal: Goal = {
    id: 'goal',
    objective: 'Finish everything',
    scope: 'workspace',
    priority: 0,
    sortOrder: 0,
    status: 'queued',
    checklist,
    linkedSessionIds: [],
    activity: [],
    activeDurationMs: 0,
    createdAt: 1,
    updatedAt: 1,
  };
  const store = {
    async list() {
      return [goal];
    },
    async get(id: string) {
      return id === goal.id ? goal : undefined;
    },
    async update(id: string, patch: Partial<Goal>) {
      if (id !== goal.id) return undefined;
      goal = { ...goal, ...patch, updatedAt: Date.now() };
      return goal;
    },
    async startItem(id: string, itemId: string) {
      if (id !== goal.id) return undefined;
      return this.update(id, {
        status: 'running',
        blocker: undefined,
        checklist: goal.checklist.map((item) =>
          item.id === itemId
            ? { ...item, status: 'running' as const, startedAt: Date.now() }
            : item,
        ),
      });
    },
    async addActivity(id: string, type: string, message: string, sessionId?: string) {
      return this.update(id, {
        activity: [
          ...goal.activity,
          { id: crypto.randomUUID(), type, message, sessionId, createdAt: Date.now() },
        ],
      });
    },
    async transitionActiveAttempt(
      id: string,
      expectedAttemptId: string,
      patch: Pick<Partial<Goal>, 'status' | 'blocker' | 'activity'>,
    ) {
      if (
        id !== goal.id ||
        !['queued', 'planning', 'running'].includes(goal.status) ||
        goal.execution?.attemptId !== expectedAttemptId
      ) {
        return undefined;
      }
      return this.update(id, {
        ...patch,
        activity: patch.activity ? [...goal.activity, ...patch.activity] : goal.activity,
      });
    },
    async addActivityForActiveAttempt(
      id: string,
      expectedAttemptId: string,
      type: string,
      message: string,
      sessionId?: string,
    ) {
      return this.transitionActiveAttempt(id, expectedAttemptId, {
        activity: [{ id: crypto.randomUUID(), type, message, sessionId, createdAt: Date.now() }],
      });
    },
    async resetItem(id: string, itemId: string, reason: string, expectedAttemptId?: string) {
      if (
        !['queued', 'planning', 'running'].includes(goal.status) ||
        (expectedAttemptId && goal.execution?.attemptId !== expectedAttemptId)
      )
        return undefined;
      return this.update(id, {
        status: 'queued',
        checklist: goal.checklist.map((item) =>
          item.id === itemId ? { ...item, status: 'pending', startedAt: undefined } : item,
        ),
        activity: [
          ...goal.activity,
          { id: crypto.randomUUID(), type: 'item_retry', message: reason, createdAt: Date.now() },
        ],
      });
    },
    async reopenUnverifiedItems() {
      return goal;
    },
    async completeItem(
      id: string,
      itemId: string,
      review: GoalEvidenceReview,
      expectedAttemptId?: string,
    ) {
      if (
        goal.status !== 'running' ||
        (expectedAttemptId && goal.execution?.attemptId !== expectedAttemptId)
      )
        return undefined;
      const producerId = crypto.randomUUID();
      const verified =
        review.verifier.passed &&
        review.verifier.skipped !== true &&
        !!review.verifier.provider &&
        !!review.verifier.model &&
        !(
          review.producer.provider === review.verifier.provider &&
          review.producer.model === review.verifier.model
        );
      return this.update(id, {
        checklist: goal.checklist.map((item) =>
          item.id === itemId
            ? {
                ...item,
                status: verified ? ('completed' as const) : item.status,
                completedAt: verified ? Date.now() : undefined,
                evidence: [
                  ...item.evidence,
                  {
                    id: producerId,
                    kind: review.producer.kind,
                    value: review.producer.value,
                    source: 'producer' as const,
                    verificationStatus: 'submitted' as const,
                    producerProvider: review.producer.provider,
                    producerModel: review.producer.model,
                    verified: false,
                    createdAt: Date.now(),
                  },
                  {
                    id: crypto.randomUUID(),
                    kind: 'check' as const,
                    value: review.verifier.feedback ?? 'No verifier feedback',
                    source: 'verifier' as const,
                    verificationStatus: verified
                      ? ('verified' as const)
                      : review.verifier.skipped
                        ? ('unverified' as const)
                        : ('rejected' as const),
                    producerEvidenceId: producerId,
                    verifierProvider: review.verifier.provider,
                    verifierModel: review.verifier.model,
                    verified,
                    createdAt: Date.now(),
                  },
                ],
              }
            : item,
        ),
      });
    },
    async finalize(id: string) {
      const complete = goal.checklist.every(
        (item) =>
          item.status === 'completed' &&
          item.evidence.some(
            (proof) =>
              proof.source === 'verifier' &&
              proof.verificationStatus === 'verified' &&
              proof.verified,
          ),
      );
      if (!complete) throw new Error('lacks verified completion evidence');
      return this.update(id, { status: 'completed' });
    },
  };
  let turns = 0;
  let sessionRunning = false;
  let cancelCount = 0;
  let blockerVerificationCount = 0;
  const verifiedEvidence: string[] = [];
  const kory = {
    isSessionRunning: () => sessionRunning,
    async cancelSessionWorkers() {
      cancelCount += 1;
      await options.onCancel?.();
    },
    getRecordedSessionChanges: () => options.changes ?? [],
    async processTask() {
      turns += 1;
      if (options.processTask) {
        await options.processTask({ goal, turn: turns });
        return;
      }
      const running = goal.checklist.find((item) => item.status === 'running')!;
      if (options.workflow && running.id === 'one') {
        let workflow = startWorkflow(root, {
          workflowId: 'design-quality',
          sessionId: 'session',
          goalId: goal.id,
          goalItemId: running.id,
          task: running.title,
          requestedBy: 'agent',
        });
        for (const stage of getWorkflowDefinition('design-quality')!.stages) {
          workflow = advanceWorkflow(root, workflow.id, { evidence: `${stage.id} proof` });
        }
        return;
      }
      await store.addActivity(
        goal.id,
        'evidence_candidate',
        `${running.id}|verified artifact ${running.id}`,
        'session',
      );
    },
    async verifyGoalItem(
      _sessionId: string,
      _objective: string,
      _itemTitle: string,
      evidence: string,
    ) {
      verifiedEvidence.push(evidence);
      const verdict =
        typeof options.critic === 'function'
          ? await options.critic(turns)
          : (options.critic ?? { passed: true, feedback: 'PASS' });
      return { provider: 'anthropic', model: 'critic:test', ...verdict };
    },
    async verifyGoalBlocker() {
      blockerVerificationCount += 1;
      return typeof options.blockerVerdict === 'function'
        ? await options.blockerVerdict()
        : (options.blockerVerdict ?? { passed: true, feedback: 'PASS' });
    },
  };
  const driver = new GoalDriveService(
    store as never,
    {
      get: async () =>
        options.sessionMissing
          ? undefined
          : {
              id: 'session',
              workingDirectory:
                options.workingDirectory === undefined ? root : options.workingDirectory,
            },
    } as never,
    kory as never,
    { broadcast: () => {} } as never,
    {
      retryDelayMs: 5,
      checkpointStoreFactory: options.checkpointStoreFactory,
      acquireSessionMutationBarrier:
        options.acquireSessionMutationBarrier ?? (() => ({ release() {} })),
      acquireAgentToolBarrier: options.acquireAgentToolBarrier ?? (() => ({ release() {} })),
    },
  );
  return {
    driver,
    root,
    get goal() {
      return goal;
    },
    set goal(next: Goal) {
      goal = next;
    },
    get turns() {
      return turns;
    },
    get cancelCount() {
      return cancelCount;
    },
    get blockerVerificationCount() {
      return blockerVerificationCount;
    },
    get verifiedEvidence() {
      return verifiedEvidence;
    },
    setSessionRunning(value: boolean) {
      sessionRunning = value;
    },
    interruptFirstItem() {
      goal = {
        ...goal,
        status: 'running',
        execution: { sessionId: 'session', provider: 'openai', model: 'openai:test' },
        checklist: goal.checklist.map((item, index) =>
          index === 0 ? { ...item, status: 'running', startedAt: Date.now() } : item,
        ),
      };
    },
    async checkpoint() {
      await (
        driver as unknown as { createGoalCheckpoint(id: string): Promise<void> }
      ).createGoalCheckpoint(goal.id);
    },
  };
}

describe('durable Goal Mode driver', () => {
  test('continues across checklist turns and finalizes without another browser request', async () => {
    const state = harness();
    await state.driver.start('goal', {
      sessionId: 'session',
      provider: 'openai',
      model: 'openai:test',
    });
    await waitFor(() => state.goal.status === 'completed');
    expect(state.turns).toBe(2);
    expect(state.goal.checklist.every((item) => item.status === 'completed')).toBe(true);
    expect(state.goal.checklist[0]!.evidence).toEqual([
      expect.objectContaining({ source: 'producer', verified: false }),
      expect.objectContaining({ source: 'verifier', verified: true }),
    ]);
    expect(state.verifiedEvidence[0]).toBe('verified artifact one');
  });

  test('pauses with producer evidence unverified when the Critic is disabled', async () => {
    const state = harness({
      critic: { passed: true, skipped: true, feedback: 'Critic disabled by user.' },
    });
    await state.driver.start('goal', {
      sessionId: 'session',
      provider: 'openai',
      model: 'openai:test',
    });
    await waitFor(() => state.goal.status === 'paused');
    expect(state.turns).toBe(1);
    expect(state.goal.blocker).toContain('Independent verification is disabled');
    expect(state.goal.checklist[0]).toMatchObject({ status: 'running' });
    expect(state.goal.checklist[0]!.evidence).toEqual([
      expect.objectContaining({ source: 'producer', verified: false }),
      expect.objectContaining({
        source: 'verifier',
        verificationStatus: 'unverified',
        verified: false,
      }),
    ]);
  });

  test('does not treat a skipped blocker verdict as critic-confirmed', async () => {
    const state = harness({
      blockerVerdict: { passed: true, skipped: true, feedback: 'Critic disabled by user.' },
      processTask: async ({ goal }) => {
        const running = goal.checklist.find((item) => item.status === 'running')!;
        const store = (
          state.driver as unknown as {
            goals: { addActivity(...args: unknown[]): Promise<unknown> };
          }
        ).goals;
        await store.addActivity(
          goal.id,
          'blocker_candidate',
          `${running.id}|External service is unavailable`,
          'session',
        );
      },
    });
    await state.driver.start('goal', {
      sessionId: 'session',
      provider: 'openai',
      model: 'openai:test',
    });
    await waitFor(() => state.goal.status === 'paused');
    expect(state.goal.blocker).toContain('Independent blocker verification is disabled');
    expect(state.goal.blocker).not.toContain('Critic confirmed');
    expect(state.goal.activity.filter((event) => event.type === 'blocker_candidate')).toHaveLength(
      3,
    );
  });

  test('bounds identical verifier failures and ends in an evidenced blocker', async () => {
    const state = harness({ critic: { passed: false, feedback: 'Tests still fail at case 7' } });
    await state.driver.start('goal', {
      sessionId: 'session',
      provider: 'openai',
      model: 'openai:test',
    });
    await waitFor(() => state.goal.status === 'blocked');
    expect(state.turns).toBe(3);
    expect(state.goal.blocker).toContain('same concrete result after 3 attempts');
    expect(
      state.goal.activity.filter((event) => event.type === 'verification_failure'),
    ).toHaveLength(3);
  });

  test('never treats an unpersisted same-identity verifier pass as completion', async () => {
    const state = harness({
      critic: {
        passed: true,
        feedback: 'PASS',
        provider: 'openai',
        model: 'openai:test',
      },
    });
    await state.driver.start('goal', {
      sessionId: 'session',
      provider: 'openai',
      model: 'openai:test',
    });
    await waitFor(() => state.goal.status === 'blocked');
    expect(state.turns).toBe(3);
    expect(state.goal.checklist[0]).toMatchObject({ status: 'running' });
    expect(state.goal.blocker).toContain('same concrete result after 3 attempts');
  });

  test('adjudicates repeated missing producer evidence instead of retrying forever', async () => {
    const state = harness({
      processTask: async () => {},
      blockerVerdict: { passed: true, feedback: 'PASS: producer is not reporting results' },
    });
    await state.driver.start('goal', {
      sessionId: 'session',
      provider: 'openai',
      model: 'openai:test',
    });
    await waitFor(() => state.goal.status === 'blocked');
    expect(state.turns).toBe(3);
    expect(state.goal.blocker).toContain('repeatedly returned without concrete');
    expect(state.goal.activity.filter((event) => event.type === 'evidence_missing')).toHaveLength(
      3,
    );
  });

  test('replays an interrupted checklist item after a backend restart', async () => {
    const state = harness();
    state.interruptFirstItem();
    await state.driver.recover();
    await waitFor(() => state.goal.status === 'completed');
    expect(state.turns).toBe(2);
    expect(state.goal.activity.some((event) => event.type === 'item_retry')).toBe(true);
  });

  test('a human resume starts a fresh persisted attempt and ignores old blocker streaks', async () => {
    const state = harness();
    const oldBlockers = [1, 2, 3].map((index) => ({
      id: `old-blocker-${index}`,
      type: 'blocker_candidate',
      message: 'one|External service is unavailable',
      sessionId: 'session',
      createdAt: index,
    }));
    state.goal = {
      ...state.goal,
      status: 'blocked',
      blocker: 'Critic confirmed old blocker',
      execution: { sessionId: 'session', provider: 'openai', model: 'openai:test' },
      activity: oldBlockers,
      checklist: state.goal.checklist.map((item, index) =>
        index === 0 ? { ...item, status: 'running', startedAt: 1 } : item,
      ),
    };
    await state.driver.resume('goal');
    const resumedAttemptId = state.goal.execution?.attemptId;
    expect(resumedAttemptId).toBeTruthy();
    expect(
      state.goal.activity.some(
        (event) =>
          event.type === 'execution_attempt_started' &&
          event.message === `${resumedAttemptId}|resumed`,
      ),
    ).toBe(true);
    await waitFor(() => state.goal.status === 'completed');
    expect(state.blockerVerificationCount).toBe(0);
  });

  test('backend recovery retains the attempt epoch and excludes pre-epoch failures', async () => {
    const state = harness();
    const attemptStartedAt = Date.now() - 100;
    state.goal = {
      ...state.goal,
      status: 'running',
      execution: {
        sessionId: 'session',
        provider: 'openai',
        model: 'openai:test',
        attemptId: 'persisted-attempt',
        attemptStartedAt,
      },
      activity: [
        ...[1, 2, 3].map((index) => ({
          id: `pre-restart-blocker-${index}`,
          type: 'blocker_candidate',
          message: 'one|Old failure from a prior attempt',
          sessionId: 'session',
          createdAt: attemptStartedAt - index,
        })),
        {
          id: 'attempt-marker',
          type: 'execution_attempt_started',
          message: 'persisted-attempt|started',
          sessionId: 'session',
          createdAt: attemptStartedAt,
        },
      ],
      checklist: state.goal.checklist.map((item, index) =>
        index === 0 ? { ...item, status: 'running', startedAt: attemptStartedAt } : item,
      ),
    };
    await state.driver.recover();
    await waitFor(() => state.goal.status === 'completed');
    expect(state.goal.execution?.attemptId).toBe('persisted-attempt');
    expect(state.blockerVerificationCount).toBe(0);
  });

  test('resume resets verifier and missing-evidence retry streaks without erasing history', async () => {
    const verification = harness({
      critic: { passed: false, feedback: 'Tests still fail at case 7' },
    });
    verification.goal = {
      ...verification.goal,
      status: 'blocked',
      blocker: 'Old verifier streak',
      execution: { sessionId: 'session', provider: 'openai', model: 'openai:test' },
      activity: [1, 2, 3].map((index) => ({
        id: `old-verification-${index}`,
        type: 'verification_failure',
        message: 'one|Tests still fail at case 7',
        sessionId: 'session',
        createdAt: index,
      })),
      checklist: verification.goal.checklist.map((item, index) =>
        index === 0 ? { ...item, status: 'running', startedAt: 1 } : item,
      ),
    };
    await verification.driver.resume('goal');
    await waitFor(() => verification.goal.status === 'blocked');
    expect(verification.turns).toBe(3);
    expect(
      verification.goal.activity.filter((event) => event.type === 'verification_failure'),
    ).toHaveLength(6);

    const missing = harness({ processTask: async () => {} });
    const missingMessage =
      'No concrete completion evidence was recorded. Continue the item and call update_goal with the checks or artifacts that prove it is complete.';
    missing.goal = {
      ...missing.goal,
      status: 'blocked',
      blocker: 'Old missing-evidence streak',
      execution: { sessionId: 'session', provider: 'openai', model: 'openai:test' },
      activity: [1, 2, 3].map((index) => ({
        id: `old-missing-${index}`,
        type: 'evidence_missing',
        message: `one|${missingMessage}`,
        sessionId: 'session',
        createdAt: index,
      })),
      checklist: missing.goal.checklist.map((item, index) =>
        index === 0 ? { ...item, status: 'running', startedAt: 1 } : item,
      ),
    };
    await missing.driver.resume('goal');
    await waitFor(() => missing.goal.status === 'blocked');
    expect(missing.turns).toBe(3);
    expect(missing.blockerVerificationCount).toBe(1);
    expect(missing.goal.activity.filter((event) => event.type === 'evidence_missing')).toHaveLength(
      6,
    );
  });

  test('pause and stop persist before awaiting worker cancellation', async () => {
    let releaseTurn!: () => void;
    const turn = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    const state = harness({
      processTask: async () => turn,
      onCancel: () => releaseTurn(),
    });
    await state.driver.start('goal', {
      sessionId: 'session',
      provider: 'openai',
      model: 'openai:test',
    });
    await waitFor(() => state.turns === 1);
    await state.driver.pause('goal');
    expect(state.goal.status).toBe('paused');
    expect(state.cancelCount).toBe(1);
    expect(state.goal.checklist[0]!.status).toBe('running');

    const stopped = harness({ processTask: async () => new Promise<void>(() => {}) });
    await stopped.driver.start('goal', {
      sessionId: 'session',
      provider: 'openai',
      model: 'openai:test',
    });
    await waitFor(() => stopped.turns === 1);
    await stopped.driver.stop('goal');
    expect(stopped.goal.status).toBe('cancelled');
    expect(stopped.cancelCount).toBe(1);
  });

  test('a pause wins atomically over an in-flight evidence verifier', async () => {
    let releaseVerifier!: () => void;
    const verifier = new Promise<Verdict>((resolve) => {
      releaseVerifier = () =>
        resolve({
          passed: true,
          feedback: 'PASS',
          provider: 'anthropic',
          model: 'critic:test',
        });
    });
    const state = harness({ critic: async () => verifier });
    await state.driver.start('goal', {
      sessionId: 'session',
      provider: 'openai',
      model: 'openai:test',
    });
    await waitFor(() => state.verifiedEvidence.length === 1);

    await state.driver.pause('goal');
    releaseVerifier();
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(state.goal.status).toBe('paused');
    expect(state.goal.blocker).toBe('Paused by user');
    expect(state.goal.checklist[0]).toMatchObject({ status: 'running', evidence: [] });
  });

  test('a stop wins atomically over repeated driver-error adjudication', async () => {
    let releaseBlockerVerifier!: () => void;
    const blockerVerifier = new Promise<Verdict>((resolve) => {
      releaseBlockerVerifier = () => resolve({ passed: true, feedback: 'PASS' });
    });
    const state = harness({
      processTask: async () => {
        throw new Error('deterministic provider failure');
      },
      blockerVerdict: async () => blockerVerifier,
    });
    await state.driver.start('goal', {
      sessionId: 'session',
      provider: 'openai',
      model: 'openai:test',
    });
    await waitFor(() => state.blockerVerificationCount === 1);

    await state.driver.stop('goal');
    releaseBlockerVerifier();
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(state.goal.status).toBe('cancelled');
    expect(state.goal.blocker).toBe('Stopped by user');
    expect(state.goal.activity.filter((event) => event.type === 'driver_error')).toHaveLength(3);
  });

  test('rejects duplicate starts and preserves terminal lifecycle states', async () => {
    let releaseTurn!: () => void;
    const turn = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    const running = harness({ processTask: async () => turn, onCancel: () => releaseTurn() });
    const execution = {
      sessionId: 'session',
      provider: 'openai',
      model: 'openai:test',
    };
    await running.driver.start('goal', execution);
    await waitFor(() => running.turns === 1);
    await expect(running.driver.start('goal', execution)).rejects.toThrow('already running');
    await expect(running.driver.resume('goal')).rejects.toThrow('Only paused or blocked');
    await running.driver.pause('goal');

    const terminal = harness();
    terminal.goal = { ...terminal.goal, status: 'completed' };
    await expect(terminal.driver.pause('goal')).rejects.toThrow('Terminal goals');
    await expect(terminal.driver.stop('goal')).rejects.toThrow('Completed goals');
    expect(terminal.goal.status).toBe('completed');
  });

  test('fails closed for missing or wrong execution directories', async () => {
    const missing = harness({ workingDirectory: null });
    await expect(
      missing.driver.start('goal', {
        sessionId: 'session',
        provider: 'openai',
        model: 'openai:test',
      }),
    ).rejects.toThrow('no durable project directory');
    expect(missing.turns).toBe(0);

    const scoped = harness();
    scoped.goal = { ...scoped.goal, scope: 'project', projectPath: scoped.root };
    const other = mkdtempSync(join(tmpdir(), 'kory-goal-wrong-root-'));
    const wrong = harness({ root: other });
    wrong.goal = { ...wrong.goal, scope: 'project', projectPath: scoped.root };
    await expect(
      wrong.driver.start('goal', {
        sessionId: 'session',
        provider: 'openai',
        model: 'openai:test',
      }),
    ).rejects.toThrow('scoped to its project');
    expect(wrong.turns).toBe(0);
  });

  test('promotes completed linked workflow evidence through the Goal critic gate', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kory-goal-workflow-'));
    try {
      const state = harness({ workflow: true, root });
      await state.driver.start('goal', {
        sessionId: 'session',
        provider: 'openai',
        model: 'openai:test',
      });
      await waitFor(() => state.goal.status === 'completed');
      expect(state.goal.activity.some((event) => event.type === 'workflow_evidence')).toBe(true);
      expect(state.goal.checklist[0]?.evidence[0]?.value).toContain('Completed linked workflow');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('periodic Goal checkpoints', () => {
  test('serializes publication and durably acknowledges the resulting hash', async () => {
    let publications = 0;
    let releasePublication!: () => void;
    const pending = new Promise<void>((resolve) => {
      releasePublication = resolve;
    });
    const state = harness({
      changes: [{ path: 'src/a.ts', operation: 'edit' }],
      checkpointStoreFactory: () => ({
        async createGhostCommit() {
          publications += 1;
          await pending;
          return 'a'.repeat(40);
        },
      }),
    });
    state.interruptFirstItem();
    const first = state.checkpoint();
    const second = state.checkpoint();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(publications).toBe(1);
    releasePublication();
    await Promise.all([first, second]);
    expect(state.goal.activity.find((event) => event.type === 'goal_checkpoint')?.message).toBe(
      `${'a'.repeat(40)}|1 owned file change checkpointed`,
    );
  });

  test('skips busy writes and a held process barrier', async () => {
    let publications = 0;
    const factory = () => ({
      async createGhostCommit() {
        publications += 1;
        return 'b'.repeat(40);
      },
    });
    const busy = harness({
      changes: [{ path: 'src/a.ts', operation: 'edit' }],
      checkpointStoreFactory: factory,
    });
    busy.interruptFirstItem();
    busy.setSessionRunning(true);
    await busy.checkpoint();

    const barrier = harness({
      changes: [{ path: 'src/a.ts', operation: 'edit' }],
      checkpointStoreFactory: factory,
      acquireAgentToolBarrier: () => null,
    });
    barrier.interruptFirstItem();
    await barrier.checkpoint();

    const managerBarrier = harness({
      changes: [{ path: 'src/a.ts', operation: 'edit' }],
      checkpointStoreFactory: factory,
      acquireSessionMutationBarrier: () => null,
    });
    managerBarrier.interruptFirstItem();
    await managerBarrier.checkpoint();
    expect(publications).toBe(0);
    expect(busy.goal.activity.some((event) => event.type === 'goal_checkpoint')).toBe(false);
    expect(barrier.goal.activity.some((event) => event.type === 'goal_checkpoint')).toBe(false);
    expect(managerBarrier.goal.activity.some((event) => event.type === 'goal_checkpoint')).toBe(
      false,
    );
  });

  test('records null publication as a failure and never acknowledges it', async () => {
    const state = harness({
      changes: [{ path: 'src/a.ts', operation: 'edit' }],
      checkpointStoreFactory: () => ({ createGhostCommit: async () => null }),
    });
    state.interruptFirstItem();
    await state.checkpoint();
    expect(state.goal.activity.some((event) => event.type === 'goal_checkpoint')).toBe(false);
    expect(
      state.goal.activity.find((event) => event.type === 'goal_checkpoint_failed')?.message,
    ).toContain('returned no hash');
  });

  test('never publishes while the Goal agent turn is active', async () => {
    let releaseTurn!: () => void;
    const turn = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    let publications = 0;
    const state = harness({
      changes: [{ path: 'src/a.ts', operation: 'edit' }],
      processTask: async () => turn,
      checkpointStoreFactory: () => ({
        async createGhostCommit() {
          publications += 1;
          return 'c'.repeat(40);
        },
      }),
    });
    await state.driver.start('goal', {
      sessionId: 'session',
      provider: 'openai',
      model: 'openai:test',
    });
    await waitFor(() => state.turns === 1);
    await state.checkpoint();
    expect(publications).toBe(0);
    releaseTurn();
    await state.driver.pause('goal');
  });
});
