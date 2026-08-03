import { beforeAll, beforeEach, describe, expect, setSystemTime, test } from 'bun:test';
import { initDb, db, goals } from '../src/db';
import { GoalStore } from '../src/stores/goal-store';
import { GoalRunner, goalProviderPolicy } from '../src/kory/goal-runner';
import { compilePrompt, createTaskContract } from '../src/kory/prompts';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Elysia } from 'elysia';
import { goalRoutes } from '../src/routes/v1/goals';
import { setContext } from '../src/context';
import { localAuth } from '../src/auth/local-auth';
import { buildLocalBearerToken } from '../src/auth/local-route-auth';
import { CreateGoalTool } from '../src/tools/goals';
import { GoalDriveService } from '../src/kory/goal-drive-service';

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
    expect(goalProviderPolicy('claude').verification).toBe('unverified');
    expect(goalProviderPolicy('codex').verification).toBe('unverified');
    expect(goalProviderPolicy('kimicode').verification).toBe('unverified');
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

  test('manager-created goals inherit the active routing and start autonomously', async () => {
    const starts: Array<{ id: string; execution: { sessionId: string; provider: string; model: string } }> = [];
    setContext({
      goals: store,
      kory: { getLastManagerRouting: () => ({ provider: 'openai', model: 'openai:gpt-test' }) },
      goalDriver: { start: async (id: string, execution: { sessionId: string; provider: string; model: string }) => { starts.push({ id, execution }); return (await store.get(id))!; } },
    } as any);
    const result = await new CreateGoalTool().run({ sessionId: 'chat-1', workingDirectory: '/tmp/project' }, { id: 'call-2', name: 'create_goal', input: { objective: 'Keep going', scope: 'workspace' } });
    expect(result.isError).toBe(false);
    expect(starts).toHaveLength(1);
    expect(starts[0]?.execution).toEqual({ sessionId: 'chat-1', provider: 'openai', model: 'openai:gpt-test' });
  });
});

describe('Goal Mode HTTP user flow', () => {
  test('one drive request continues, verifies, and finalizes through the guarded API', async () => {
    const emitted: unknown[] = [];
    const starts: unknown[] = [];
    const runner = new GoalRunner(store);
    setContext({
      goals: store,
      sessions: { get: async () => ({ id: 'chat-1', workingDirectory: undefined }) },
      kory: { verifyGoalItem: async () => ({ passed: true }) },
      goalDriver: { start: async (id: string, execution: unknown) => { starts.push(execution); await store.update(id, { execution: execution as never }); await runner.startNext(id); return (await store.get(id))!; } },
      wsManager: { broadcast: (message: unknown) => emitted.push(message) },
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
    expect(starts).toHaveLength(goal.checklist.length);
    expect(starts[0]).toMatchObject({ sessionId: 'chat-1', provider: 'openai', model: 'openai:gpt-test' });
  });
});

describe('Goal Mode durable continuation', () => {
  const waitFor = async (predicate: () => Promise<boolean>, timeoutMs = 3000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await Bun.sleep(10);
    }
    throw new Error('Timed out waiting for Goal Mode state');
  };

  test('keeps dispatching across checklist items and finalizes without browser drive calls', async () => {
    const goal = await store.create({ objective: 'Finish every item', scope: 'workspace' });
    let dispatches = 0;
    const service = new GoalDriveService(
      store,
      { get: async () => ({ id: 'chat-1' }) } as any,
      {
        isSessionRunning: () => false,
        processTask: async () => { dispatches += 1; },
        verifyGoalItem: async () => ({ passed: true, skipped: true }),
        cancelSessionWorkers: () => {},
      } as any,
      { broadcast: () => {} } as any,
    );
    await service.start(goal.id, { sessionId: 'chat-1', provider: 'openai', model: 'openai:gpt-test' });
    await waitFor(async () => (await store.get(goal.id))?.status === 'completed');
    expect(dispatches).toBe(goal.checklist.length);
    expect((await store.get(goal.id))?.checklist.every((item) => item.evidence.some((proof) => proof.verified))).toBe(true);
    expect((await store.get(goal.id))?.checklist.every((item) => item.evidence.some((proof) => proof.value.includes('Critic disabled by user')))).toBe(true);
  });

  test('a human pause interrupts the active run and prevents the next dispatch', async () => {
    const goal = await store.create({ objective: 'Pause safely', scope: 'workspace' });
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    let dispatches = 0;
    const service = new GoalDriveService(
      store,
      { get: async () => ({ id: 'chat-1' }) } as any,
      {
        isSessionRunning: () => false,
        processTask: async () => { dispatches += 1; await pending; },
        verifyGoalItem: async () => ({ passed: true }),
        cancelSessionWorkers: () => { release(); },
      } as any,
      { broadcast: () => {} } as any,
    );
    await service.start(goal.id, { sessionId: 'chat-1', provider: 'openai', model: 'openai:gpt-test' });
    await waitFor(async () => dispatches === 1);
    await service.pause(goal.id);
    await Bun.sleep(30);
    expect((await store.get(goal.id))?.status).toBe('paused');
    expect(dispatches).toBe(1);
  });

  test('stops only after the same concrete blocker recurs three times', async () => {
    const goal = await store.create({ objective: 'Exhaust alternatives', scope: 'workspace' });
    let dispatches = 0;
    const service = new GoalDriveService(
      store,
      { get: async () => ({ id: 'chat-1' }) } as any,
      {
        isSessionRunning: () => false,
        processTask: async () => {
          dispatches += 1;
          const current = (await store.get(goal.id))!;
          const item = current.checklist.find((entry) => entry.status === 'running')!;
          await store.addActivity(goal.id, 'blocker_candidate', `${item.id}|authorization: Missing required deployment credential`, 'chat-1');
        },
        verifyGoalItem: async () => ({ passed: false, feedback: 'Credential is still unavailable' }),
        verifyGoalBlocker: async () => ({ passed: true }),
        cancelSessionWorkers: () => {},
      } as any,
      { broadcast: () => {} } as any,
    );
    await service.start(goal.id, { sessionId: 'chat-1', provider: 'openai', model: 'openai:gpt-test' });
    await waitFor(async () => (await store.get(goal.id))?.status === 'blocked', 5000);
    expect(dispatches).toBe(3);
    expect((await store.get(goal.id))?.blocker).toContain('Critic confirmed after 3 attempts');
  });

  test('recovers a persisted in-flight item after a backend restart', async () => {
    const goal = await store.create({ objective: 'Survive restart', scope: 'workspace', execution: { sessionId: 'chat-1', provider: 'openai', model: 'openai:gpt-test' } });
    await new GoalRunner(store).startNext(goal.id);
    let dispatches = 0;
    const service = new GoalDriveService(
      store,
      { get: async () => ({ id: 'chat-1' }) } as any,
      {
        isSessionRunning: () => false,
        processTask: async () => { dispatches += 1; },
        verifyGoalItem: async () => ({ passed: true }),
        cancelSessionWorkers: () => {},
      } as any,
      { broadcast: () => {} } as any,
    );
    await service.recover();
    await waitFor(async () => (await store.get(goal.id))?.status === 'completed');
    expect(dispatches).toBe(goal.checklist.length);
  });
});
