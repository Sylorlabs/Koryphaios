import { afterAll, beforeAll, beforeEach, describe, expect, setSystemTime, test } from 'bun:test';
import { initDb, db, goals } from '../../db';
import { GoalStore, hasIndependentGoalEvidence } from '../../stores/goal-store';
import { GoalRunner, goalProviderPolicy } from '../goal-runner';
import { compilePrompt, createTaskContract } from '../prompts';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Elysia } from 'elysia';
import { goalRoutes } from '../../routes/v1/goals';
import { setContext } from '../../context';
import { localAuth } from '../../auth/local-auth';
import { buildLocalBearerToken } from '../../auth/local-route-auth';
import { CreateGoalTool, UpdateGoalTool } from '../../tools/goals';
import { GoalDriveService } from '../goal-drive-service';
import { eq } from 'drizzle-orm';

const verifiedReview = (value: string) => ({
  producer: {
    kind: 'check' as const,
    value,
    provider: 'openai',
    model: 'producer:test',
  },
  verifier: { passed: true, feedback: 'PASS', provider: 'anthropic', model: 'critic:test' },
});

const priorSkillsHome = process.env.KORYPHAIOS_SKILLS_HOME;
const goalSkillsHome = mkdtempSync(join(tmpdir(), 'kory-goal-skills-'));
process.env.KORYPHAIOS_SKILLS_HOME = goalSkillsHome;

const store = new GoalStore();
beforeAll(async () => {
  await initDb();
});
afterAll(() => {
  if (priorSkillsHome === undefined) delete process.env.KORYPHAIOS_SKILLS_HOME;
  else process.env.KORYPHAIOS_SKILLS_HOME = priorSkillsHome;
  rmSync(goalSkillsHome, { recursive: true, force: true });
});
beforeEach(async () => {
  await db.delete(goals);
});

describe('Goal Mode checklist invariants', () => {
  test('uses sequential dependencies and exact verified completion', async () => {
    const goal = await store.create({ objective: 'Ship a guarded goal flow', scope: 'workspace' });
    expect(goal.checklist).toHaveLength(3);
    expect(goal.checklist[1]?.dependsOn).toEqual([goal.checklist[0]?.id]);
    const runner = new GoalRunner(store);
    const first = await runner.startNext(goal.id);
    expect(first.item?.id).toBe(goal.checklist[0]?.id);
    await expect(
      store.completeItem(goal.id, goal.checklist[1]!.id, verifiedReview('not ready')),
    ).rejects.toThrow('Start the checklist item');
    await store.completeItem(goal.id, goal.checklist[0]!.id, verifiedReview('discovery artifact'));
    await runner.startNext(goal.id);
    await store.completeItem(
      goal.id,
      goal.checklist[1]!.id,
      verifiedReview('implementation check'),
    );
    await runner.startNext(goal.id);
    await expect(runner.finalize(goal.id)).resolves.toMatchObject({
      blocked: expect.stringContaining('lacks verified'),
    });
    await store.completeItem(
      goal.id,
      goal.checklist[2]!.id,
      verifiedReview('bun run test:core passed'),
    );
    await expect(runner.startNext(goal.id)).resolves.toMatchObject({
      blocked: 'Checklist complete: final verification is required',
      goal: { status: 'paused' },
    });
    await expect(runner.finalize(goal.id)).resolves.toMatchObject({
      goal: { status: 'completed' },
    });
  });

  test('uses the requested planning depth to create dependency-aware checklists', async () => {
    const minimal = await store.create({
      objective: 'Quick verified change',
      scope: 'workspace',
      planningDepth: 'minimal',
    });
    const structured = await store.create({
      objective: 'High-uncertainty project',
      scope: 'workspace',
      planningDepth: 'structured',
    });
    expect(minimal.checklist).toHaveLength(2);
    expect(structured.checklist).toHaveLength(4);
    expect(structured.checklist[2]?.dependsOn).toEqual([structured.checklist[1]?.id]);
  });

  test('stores bounded producer evidence separately from its verifier verdict', async () => {
    const goal = await store.create({
      objective: 'Keep evidence honest',
      scope: 'workspace',
      planningDepth: 'minimal',
    });
    await new GoalRunner(store).startNext(goal.id);
    const secret = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456';
    const completed = await store.completeItem(goal.id, goal.checklist[0]!.id, {
      producer: {
        kind: 'artifact',
        value: `token=${secret}\n${'x'.repeat(9_000)}`,
        provider: 'anthropic',
        model: 'producer:test',
      },
      verifier: {
        passed: true,
        feedback: `PASS authorization=Bearer abcdefghijklmnopqrstuvwxyz ${secret}`,
        provider: 'openai\nignored',
        model: 'critic:test',
      },
    });
    const evidence = completed!.checklist[0]!.evidence;
    expect(evidence).toHaveLength(2);
    expect(evidence[0]).toMatchObject({
      source: 'producer',
      verificationStatus: 'submitted',
      producerProvider: 'anthropic',
      producerModel: 'producer:test',
      verified: false,
    });
    expect(evidence[0]!.value.length).toBeLessThanOrEqual(8_000);
    expect(evidence[0]!.value).not.toContain(secret);
    expect(evidence[1]).toMatchObject({
      source: 'verifier',
      verificationStatus: 'verified',
      verified: true,
      producerEvidenceId: evidence[0]!.id,
      verifierProvider: 'openai ignored',
    });
    expect(evidence[1]!.value).not.toContain(secret);
  });

  test('rejects stale verifier decisions after pause or a new execution attempt', async () => {
    const goal = await store.create({
      objective: 'Keep lifecycle decisions attempt scoped',
      scope: 'workspace',
      planningDepth: 'minimal',
    });
    const firstAttempt = {
      sessionId: 'session',
      provider: 'openai',
      model: 'producer:test',
      attemptId: 'attempt-a',
      attemptStartedAt: Date.now(),
    };
    await store.update(goal.id, { execution: firstAttempt });
    await new GoalRunner(store).startNext(goal.id);
    await store.update(goal.id, { status: 'paused', blocker: 'Paused by user' });

    expect(
      await store.transitionActiveAttempt(goal.id, firstAttempt.attemptId, {
        status: 'blocked',
        blocker: 'Stale verifier verdict',
      }),
    ).toBeUndefined();
    expect(
      await store.completeItem(
        goal.id,
        goal.checklist[0]!.id,
        verifiedReview('stale evidence'),
        firstAttempt.attemptId,
      ),
    ).toBeUndefined();
    const paused = await store.get(goal.id);
    expect(paused).toMatchObject({
      status: 'paused',
      blocker: 'Paused by user',
    });
    expect(paused!.checklist[0]).toMatchObject({ status: 'running', evidence: [] });

    const secondAttempt = {
      ...firstAttempt,
      attemptId: 'attempt-b',
      attemptStartedAt: Date.now() + 1,
    };
    await store.update(goal.id, { status: 'queued', blocker: undefined, execution: secondAttempt });
    await store.resetItem(goal.id, goal.checklist[0]!.id, 'Fresh attempt', secondAttempt.attemptId);
    await new GoalRunner(store).startNext(goal.id);

    expect(
      await store.completeItem(
        goal.id,
        goal.checklist[0]!.id,
        verifiedReview('old attempt result'),
        firstAttempt.attemptId,
      ),
    ).toBeUndefined();
    const resumed = await store.get(goal.id);
    expect(resumed).toMatchObject({
      status: 'running',
      execution: expect.objectContaining({ attemptId: secondAttempt.attemptId }),
    });
    expect(resumed!.checklist[0]).toMatchObject({ status: 'running', evidence: [] });
  });

  test('rejects an exact producer/verifier provider and model identity match', async () => {
    const goal = await store.create({
      objective: 'Require genuinely separate verification provenance',
      scope: 'workspace',
      planningDepth: 'minimal',
    });
    await new GoalRunner(store).startNext(goal.id);
    const reviewed = await store.completeItem(goal.id, goal.checklist[0]!.id, {
      producer: {
        kind: 'check',
        value: 'producer result',
        provider: 'openai',
        model: 'shared-model',
      },
      verifier: {
        passed: true,
        feedback: 'PASS',
        provider: 'openai',
        model: 'shared-model',
      },
    });

    expect(reviewed!.checklist[0]).toMatchObject({ status: 'running' });
    expect(reviewed!.checklist[0]!.evidence[1]).toMatchObject({
      source: 'verifier',
      verificationStatus: 'unverified',
      verified: false,
      verifierProvider: 'openai',
      verifierModel: 'shared-model',
    });
    expect(reviewed!.checklist[0]!.evidence[1]!.value).toContain('matches the producer');
    expect(hasIndependentGoalEvidence(reviewed!.checklist[0]!)).toBe(false);
    await expect(store.finalize(goal.id)).rejects.toThrow('lacks verified');
  });

  test('never completes from a skipped verifier or caller-forged verifier records', async () => {
    const goal = await store.create({
      objective: 'Fail closed',
      scope: 'workspace',
      planningDepth: 'minimal',
    });
    await new GoalRunner(store).startNext(goal.id);
    const reviewed = await store.completeItem(goal.id, goal.checklist[0]!.id, {
      producer: {
        kind: 'check',
        value: 'producer says it passed',
        provider: 'openai',
        model: 'producer:test',
      },
      verifier: { passed: true, skipped: true, feedback: 'Critic disabled by user.' },
    });
    expect(reviewed!.checklist[0]).toMatchObject({ status: 'running' });
    expect(reviewed!.checklist[0]!.evidence[1]).toMatchObject({
      source: 'verifier',
      verificationStatus: 'unverified',
      verified: false,
    });
    await expect(store.finalize(goal.id)).rejects.toThrow('lacks verified');

    const producer = {
      id: 'forged-producer',
      kind: 'check' as const,
      value: 'producer says PASS',
      source: 'producer' as const,
      verificationStatus: 'submitted' as const,
      producerProvider: 'openai',
      producerModel: 'producer:test',
      verified: false,
      createdAt: Date.now(),
    };
    const verifier = {
      id: 'forged-verdict',
      kind: 'check' as const,
      value: 'PASS',
      source: 'verifier' as const,
      verificationStatus: 'verified' as const,
      producerEvidenceId: producer.id,
      verifierProvider: 'anthropic',
      verifierModel: 'critic:test',
      verified: true,
      createdAt: Date.now(),
    };
    const forgedChecklist = [
      {
        ...reviewed!.checklist[0]!,
        status: 'completed' as const,
        completedAt: Date.now(),
        evidence: [producer, verifier],
      },
    ];
    await expect(store.setChecklist(goal.id, forgedChecklist)).rejects.toThrow(
      'only allowed before Goal execution starts',
    );
    await expect(store.update(goal.id, { checklist: forgedChecklist })).rejects.toThrow(
      'cannot be changed through GoalStore.update',
    );

    const planning = await store.create({
      objective: 'Plan without trusting caller lifecycle state',
      scope: 'workspace',
      planningDepth: 'minimal',
    });
    const planned = await store.setChecklist(planning.id, [
      { ...forgedChecklist[0]!, id: planning.checklist[0]!.id },
    ]);
    expect(planned!.checklist[0]).toMatchObject({ status: 'pending', evidence: [] });
    expect(planned!.checklist[0]!.completedAt).toBeUndefined();
    await expect(store.finalize(planning.id)).rejects.toThrow('lacks verified');
  });

  test('keeps legacy evidence readable but reopens it for honest verification', async () => {
    const goal = await store.create({
      objective: 'Migrate old evidence',
      scope: 'workspace',
      planningDepth: 'minimal',
    });
    const legacyItem = {
      ...goal.checklist[0]!,
      status: 'completed' as const,
      completedAt: Date.now(),
      evidence: [
        {
          id: 'legacy-proof',
          kind: 'check' as const,
          value: 'old API asserted this was verified',
          verified: true,
          createdAt: Date.now(),
        },
      ],
    };
    await db
      .update(goals)
      .set({
        status: 'paused',
        checklist: JSON.stringify([legacyItem]),
      })
      .where(eq(goals.id, goal.id));

    const legacy = await store.get(goal.id);
    expect(legacy!.checklist[0]!.evidence[0]).toMatchObject({
      source: 'legacy',
      verificationStatus: 'legacy-unverified',
      verified: false,
    });
    await expect(store.finalize(goal.id)).rejects.toThrow('lacks verified');

    const reopened = await store.reopenUnverifiedItems(goal.id);
    expect(reopened!.checklist[0]!.status).toBe('pending');
    await new GoalRunner(store).startNext(goal.id);
    await store.completeItem(goal.id, legacyItem.id, verifiedReview('fresh independent check'));
    await expect(store.finalize(goal.id)).resolves.toMatchObject({ status: 'completed' });
  });

  test('fails closed without crashing on syntactically valid but semantically damaged persistence', async () => {
    const goal = await store.create({
      objective: 'Survive a damaged persisted goal',
      scope: 'workspace',
      planningDepth: 'minimal',
    });
    const secret = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456';
    await db
      .update(goals)
      .set({
        status: 'completed',
        checklist: JSON.stringify([
          null,
          {
            ...goal.checklist[0],
            status: 'completed',
            evidence: [
              {
                id: 'unpaired-verifier',
                kind: 'check',
                value: `PASS token=${secret}`,
                source: 'verifier',
                verificationStatus: 'verified',
                verified: true,
                createdAt: Date.now(),
                privateRuntimeEnvelope: { rawPrompt: secret },
              },
            ],
          },
        ]),
        linkedSessionIds: JSON.stringify('foreign-session'),
        activity: JSON.stringify([
          null,
          {
            id: 'safe-activity',
            type: 'activity',
            message: `authorization=Bearer ${secret}`,
            createdAt: Date.now(),
            privateRuntimeEnvelope: { rawPrompt: secret },
          },
        ]),
        execution: JSON.stringify('not-an-execution-object'),
      })
      .where(eq(goals.id, goal.id));

    const recovered = await store.get(goal.id);
    expect(recovered).toMatchObject({
      status: 'blocked',
      linkedSessionIds: [],
      blocker: expect.stringContaining('persistence is damaged'),
    });
    expect(recovered!.activity.at(-1)).toMatchObject({
      type: 'persistence_recovery_required',
    });
    expect(JSON.stringify(recovered)).not.toContain(secret);
    expect(hasIndependentGoalEvidence(recovered!.checklist[0]!)).toBe(false);
    await expect(store.finalize(goal.id)).rejects.toThrow('lacks verified');
  });

  test('accrues active time exactly once across live goal updates', async () => {
    const start = new Date('2026-08-03T12:00:00Z');
    setSystemTime(start);
    try {
      const goal = await store.create({ objective: 'Measure durable runtime', scope: 'workspace' });
      await new GoalRunner(store).startNext(goal.id);
      setSystemTime(new Date(start.getTime() + 10 * 60_000));
      await store.addActivity(goal.id, 'progress', 'Ten minutes of work');
      setSystemTime(new Date(start.getTime() + 25 * 60_000));
      await store.addActivity(goal.id, 'progress', 'Twenty-five minutes of work');
      setSystemTime(new Date(start.getTime() + 30 * 60_000));
      const paused = await store.update(goal.id, { status: 'paused' });
      expect(paused?.activeDurationMs).toBe(30 * 60_000);
    } finally {
      setSystemTime();
    }
  });

  test('fails closed for cloud approval and never upgrades native CLI output', () => {
    expect(goalProviderPolicy('jules')).toMatchObject({
      allowed: false,
      verification: 'remote-pending-review',
    });
    expect(goalProviderPolicy('jules', true)).toMatchObject({
      allowed: true,
      verification: 'remote-pending-review',
    });
    // Native CLI providers (claude, codex, kimicode) are 'unverified' when the
    // host has no OS-level filesystem isolation (Windows), but 'eligible' when
    // sandbox-exec/bwrap is available (macOS, Linux).
    const nativeVerification = goalProviderPolicy('claude').verification;
    expect(nativeVerification).toMatch(/^(unverified|eligible)$/);
    expect(goalProviderPolicy('codex').verification).toBe(nativeVerification);
    expect(goalProviderPolicy('kimicode').verification).toBe(nativeVerification);
    expect(goalProviderPolicy('openai')).toMatchObject({ allowed: true, verification: 'eligible' });
  });

  test('honors priority across simultaneously active dependency-ready goals', async () => {
    const lower = await store.create({
      objective: 'Lower priority',
      scope: 'workspace',
      priority: 1,
      sortOrder: 1,
    });
    const higher = await store.create({
      objective: 'Higher priority',
      scope: 'workspace',
      priority: 2,
      sortOrder: 99,
    });
    const runner = new GoalRunner(store);
    expect((await runner.nextEligible())?.id).toBe(higher.id);
    expect((await runner.startNextEligible()).item?.id).toBe(higher.checklist[0]?.id);
    expect((await store.get(lower.id))?.status).toBe('queued');
  });

  test('rejects circular checklist dependencies before they can be scheduled', async () => {
    await expect(
      store.create({
        objective: 'Invalid graph',
        scope: 'workspace',
        checklist: [
          { id: 'a', title: 'A', status: 'pending', order: 0, dependsOn: ['b'], evidence: [] },
          { id: 'b', title: 'B', status: 'pending', order: 1, dependsOn: ['a'], evidence: [] },
        ],
      }),
    ).rejects.toThrow('cycle');
  });

  test('renders goal context into every compiled provider prompt', () => {
    const root = mkdtempSync(join(tmpdir(), 'goal-contract-'));
    mkdirSync(join(root, '.git'));
    const compiled = compilePrompt({
      role: 'worker',
      mode: 'advanced',
      provider: 'openai',
      workingDirectory: root,
      taskContract: createTaskContract('Implement it', {
        goalContext: {
          goalId: 'goal-1',
          objective: 'Finish Goal Mode',
          itemId: 'item-1',
          itemTitle: 'Verify flow',
          verification: 'eligible',
        },
      }),
    });
    expect(compiled.systemPrompt).toContain('Goal ID: goal-1');
    expect(compiled.systemPrompt).toContain('Active checklist item: Verify flow');
  });

  test('manager create_goal persists and starts with the active routing', async () => {
    let started: { goalId: string; model: string } | undefined;
    setContext({
      goals: store,
      goalDriver: {
        start: async (goalId: string, execution: { model: string }) => {
          started = { goalId, model: execution.model };
          return store.get(goalId);
        },
      },
    } as any);
    const result = await new CreateGoalTool().run(
      {
        sessionId: 'chat-1',
        workingDirectory: '/tmp/project',
        activeProvider: 'openai',
        activeModel: 'openai:gpt-test',
      },
      {
        id: 'call-1',
        name: 'create_goal',
        input: { objective: 'Track the release', scope: 'project', planningDepth: 'structured' },
      },
    );
    expect(result.isError).toBe(false);
    expect((await store.list())[0]).toMatchObject({
      objective: 'Track the release',
      scope: 'project',
      status: 'queued',
    });
    expect(started).toMatchObject({ model: 'openai:gpt-test' });
  });

  test('the update_goal tool rejects stale turns and persists only redacted bounded evidence', async () => {
    const goal = await store.create({
      objective: 'Guard the Goal tool boundary',
      scope: 'workspace',
      planningDepth: 'minimal',
    });
    await new GoalRunner(store).startNext(goal.id);
    await store.update(goal.id, {
      execution: { sessionId: 'chat-tool', provider: 'openai', model: 'openai:test' },
    });
    setContext({ goals: store } as any);
    const tool = new UpdateGoalTool();
    const secret = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456';
    const accepted = await tool.run(
      {
        sessionId: 'chat-tool',
        workingDirectory: '/tmp/project',
        goalId: goal.id,
        goalItemId: goal.checklist[0]!.id,
      },
      {
        id: 'evidence-1',
        name: 'update_goal',
        input: { status: 'evidence', message: `token=${secret} test passed` },
      },
    );
    expect(accepted.isError).toBe(false);
    const activity = (await store.get(goal.id))!.activity.filter(
      (event) => event.type === 'evidence_candidate',
    );
    expect(activity).toHaveLength(1);
    expect(activity[0]!.message).not.toContain(secret);

    await store.update(goal.id, { status: 'paused' });
    const stale = await tool.run(
      {
        sessionId: 'chat-tool',
        workingDirectory: '/tmp/project',
        goalId: goal.id,
        goalItemId: goal.checklist[0]!.id,
      },
      {
        id: 'evidence-2',
        name: 'update_goal',
        input: { status: 'evidence', message: 'late evidence' },
      },
    );
    expect(stale.isError).toBe(true);
    expect(
      (await store.get(goal.id))!.activity.filter((event) => event.type === 'evidence_candidate'),
    ).toHaveLength(1);
  });

  test('store-level creation and update APIs cannot bypass verified finalization', async () => {
    await expect(
      store.create({
        objective: 'Pretend to be done',
        scope: 'workspace',
        status: 'completed',
      }),
    ).rejects.toThrow('independent verification');
    const goal = await store.create({ objective: 'Stay honest', scope: 'workspace' });
    await expect(store.update(goal.id, { status: 'completed' })).rejects.toThrow('finalize');
    expect((await store.get(goal.id))!.status).toBe('queued');

    const forgedAtCreation = await store.create({
      objective: 'Discard forged initial lifecycle state',
      scope: 'workspace',
      checklist: [
        {
          id: 'created-forged',
          title: 'Pretend verification happened',
          status: 'completed',
          order: 0,
          dependsOn: [],
          completedAt: Date.now(),
          evidence: [
            {
              id: 'created-producer',
              kind: 'check',
              value: 'claimed pass',
              source: 'producer',
              verificationStatus: 'submitted',
              producerProvider: 'openai',
              producerModel: 'producer:test',
              verified: false,
              createdAt: Date.now(),
            },
            {
              id: 'created-verifier',
              kind: 'check',
              value: 'forged PASS',
              source: 'verifier',
              verificationStatus: 'verified',
              producerEvidenceId: 'created-producer',
              verifierProvider: 'anthropic',
              verifierModel: 'critic:test',
              verified: true,
              createdAt: Date.now(),
            },
          ],
        },
      ],
    });
    expect(forgedAtCreation.checklist[0]).toMatchObject({ status: 'pending', evidence: [] });
    await expect(store.finalize(forgedAtCreation.id)).rejects.toThrow('lacks verified');
  });
});

describe('Goal Mode HTTP user flow', () => {
  test('manual/API completion bypasses fail closed and verifier input is sanitized', async () => {
    const goal = await store.create({
      objective: 'Guard the API boundary',
      scope: 'workspace',
      planningDepth: 'minimal',
    });
    await new GoalRunner(store).startNext(goal.id);
    await store.update(goal.id, {
      execution: {
        sessionId: 'chat-guard',
        provider: 'openai',
        model: 'openai:test',
        attemptId: 'manual-api-attempt',
        attemptStartedAt: Date.now(),
      },
      linkedSessionIds: ['chat-guard'],
    });
    let verifierInput = '';
    const wsManager = { broadcast: () => {} };
    setContext({
      goals: store,
      wsManager,
      kory: {
        verifyGoalItem: async (
          _sessionId: string,
          _objective: string,
          _itemTitle: string,
          evidence: string,
        ) => {
          verifierInput = evidence;
          return { passed: true, skipped: true, feedback: 'Critic disabled by user.' };
        },
      },
    } as any);
    const app = new Elysia()
      .onError(({ error, set }) => {
        const operational = error as { statusCode?: number; message?: string };
        set.status = operational.statusCode ?? 500;
        return { error: operational.message ?? 'Request failed' };
      })
      .use(goalRoutes);
    const auth = buildLocalBearerToken(localAuth.createSession());
    const request = (path: string, method: 'POST' | 'PATCH', body: unknown) =>
      app.handle(
        new Request(`http://local${path}`, {
          method,
          headers: { authorization: auth, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      );
    const secret = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456';
    const completion = await request(
      `/api/goals/${goal.id}/checklist/${goal.checklist[0]!.id}/complete`,
      'POST',
      { kind: 'check', value: `token=${secret}\n${'proof '.repeat(1_000)}` },
    );
    expect(completion.status).toBe(409);
    expect(verifierInput.length).toBeLessThanOrEqual(8_000);
    expect(verifierInput).not.toContain(secret);
    const stored = await store.get(goal.id);
    expect(stored!.checklist[0]).toMatchObject({ status: 'running' });
    expect(stored!.checklist[0]!.evidence).toEqual([
      expect.objectContaining({ source: 'producer', verified: false }),
      expect.objectContaining({
        source: 'verifier',
        verificationStatus: 'unverified',
        verified: false,
      }),
    ]);

    setContext({
      goals: store,
      wsManager,
      kory: {
        verifyGoalItem: async () => ({
          passed: true,
          feedback: 'PASS',
          provider: 'openai',
          model: 'openai:test',
        }),
      },
    } as any);
    const sameIdentity = await request(
      `/api/goals/${goal.id}/checklist/${goal.checklist[0]!.id}/complete`,
      'POST',
      { kind: 'check', value: 'same identity cannot independently verify itself' },
    );
    expect(sameIdentity.status).toBe(409);
    expect((await store.get(goal.id))!.checklist[0]!.status).toBe('running');

    const patched = await request(`/api/goals/${goal.id}`, 'PATCH', { status: 'completed' });
    expect(patched.status).toBe(409);
    const finalized = await request(`/api/goals/${goal.id}/finalize`, 'POST', {});
    expect(finalized.status).toBe(409);
    expect((await store.get(goal.id))!.status).not.toBe('completed');
  });

  test('one drive request continues, verifies, and finalizes through the guarded API', async () => {
    const emitted: unknown[] = [];
    const dispatched: unknown[][] = [];
    const projectRoot = mkdtempSync(join(tmpdir(), 'goal-http-'));
    const sessions = { get: async () => ({ id: 'chat-1', workingDirectory: projectRoot }) };
    const kory = {
      isSessionRunning: () => false,
      cancelSessionWorkers: async () => {},
      getRecordedSessionChanges: () => [],
      processTask: async (...args: unknown[]) => {
        dispatched.push(args);
        const goalContext = args[7] as { goalId: string; itemId: string };
        await store.addActivity(
          goalContext.goalId,
          'evidence_candidate',
          `${goalContext.itemId}|verified ${goalContext.itemId}`,
          'chat-1',
        );
      },
      verifyGoalItem: async () => ({
        passed: true,
        feedback: 'PASS',
        provider: 'anthropic',
        model: 'critic:test',
      }),
      verifyGoalBlocker: async () => ({ passed: true, feedback: 'PASS' }),
    };
    const wsManager = { broadcast: (message: unknown) => emitted.push(message) };
    const goalDriver = new GoalDriveService(store, sessions as any, kory as any, wsManager as any);
    setContext({
      goals: store,
      sessions,
      kory,
      wsManager,
      goalDriver,
    } as any);
    const app = new Elysia().use(goalRoutes);
    const auth = buildLocalBearerToken(localAuth.createSession());
    const call = async (path: string, body?: unknown) =>
      app.handle(
        new Request(`http://local${path}`, {
          method: body === undefined ? 'POST' : 'POST',
          headers: { authorization: auth, 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      );
    const created = await call('/api/goals', {
      objective: 'Exercise Goal Mode',
      scope: 'workspace',
    });
    const goal = (
      (await created.json()) as { data: { id: string; checklist: Array<{ id: string }> } }
    ).data;
    const driven = await call(`/api/goals/${goal.id}/drive`, {
      sessionId: 'chat-1',
      provider: 'openai',
      model: 'openai:gpt-test',
      instructions: 'focus the release',
    });
    expect(driven.status).toBe(200);
    const deadline = Date.now() + 2_000;
    while ((await store.get(goal.id))?.status !== 'completed' && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect((await store.get(goal.id))?.status).toBe('completed');
    expect(emitted.length).toBeGreaterThan(3);
    expect(dispatched).toHaveLength(goal.checklist.length);
    expect(String(dispatched[0]?.[1])).toContain('User direction for this goal');
    expect((dispatched[0]?.[7] as { goalId?: string })?.goalId).toBe(goal.id);
  });
});
