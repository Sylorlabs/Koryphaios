import { beforeAll, beforeEach, describe, expect, setSystemTime, test } from 'bun:test';
import { initDb, db, goals } from '../../db';
import { GoalStore } from '../../stores/goal-store';
import { GoalRunner, goalProviderPolicy } from '../goal-runner';
import { compilePrompt, createTaskContract } from '../prompts';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Elysia } from 'elysia';
import { goalRoutes } from '../../routes/v1/goals';
import { setContext } from '../../context';
import { localAuth } from '../../auth/local-auth';
import { buildLocalBearerToken } from '../../auth/local-route-auth';
import { CreateGoalTool } from '../../tools/goals';
import { GoalDriveService } from '../goal-drive-service';

const store = new GoalStore();
beforeAll(async () => {
  await initDb();
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
      store.completeItem(goal.id, goal.checklist[1]!.id, { kind: 'check', value: 'not ready' }),
    ).rejects.toThrow('Start the checklist item');
    await store.completeItem(goal.id, goal.checklist[0]!.id, {
      kind: 'check',
      value: 'discovery artifact',
    });
    await runner.startNext(goal.id);
    await store.completeItem(goal.id, goal.checklist[1]!.id, {
      kind: 'check',
      value: 'implementation check',
    });
    await runner.startNext(goal.id);
    await expect(runner.finalize(goal.id)).resolves.toMatchObject({
      blocked: expect.stringContaining('lacks verified'),
    });
    await store.completeItem(goal.id, goal.checklist[2]!.id, {
      kind: 'check',
      value: 'bun run test:core passed',
    });
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
});

describe('Goal Mode HTTP user flow', () => {
  test('one drive request continues, verifies, and finalizes through the guarded API', async () => {
    const emitted: unknown[] = [];
    const dispatched: unknown[][] = [];
    const sessions = { get: async () => ({ id: 'chat-1', workingDirectory: undefined }) };
    const kory = {
      isSessionRunning: () => false,
      cancelSessionWorkers: () => {},
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
      verifyGoalItem: async () => ({ passed: true, feedback: 'PASS' }),
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
