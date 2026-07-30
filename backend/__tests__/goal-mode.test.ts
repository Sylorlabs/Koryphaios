import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
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

const store = new GoalStore();
beforeAll(async () => { await initDb(); });
beforeEach(async () => { await db.delete(goals); });

describe('Goal Mode checklist invariants', () => {
  test('uses sequential dependencies and exact verified completion', async () => {
    const goal = await store.create({ objective: 'Ship a guarded goal flow', scope: 'workspace' });
    expect(goal.checklist).toHaveLength(3);
    expect(goal.checklist[1]?.dependsOn).toEqual([goal.checklist[0]?.id]);
    const runner = new GoalRunner(store);
    const first = await runner.startNext(goal.id);
    expect(first.item?.id).toBe(goal.checklist[0]?.id);
    await expect(store.completeItem(goal.id, goal.checklist[1]!.id, { kind: 'check', value: 'not ready' })).rejects.toThrow('Start the checklist item');
    await store.completeItem(goal.id, goal.checklist[0]!.id, { kind: 'check', value: 'discovery artifact' });
    await runner.startNext(goal.id);
    await store.completeItem(goal.id, goal.checklist[1]!.id, { kind: 'check', value: 'implementation check' });
    await runner.startNext(goal.id);
    await expect(runner.finalize(goal.id)).resolves.toMatchObject({ blocked: expect.stringContaining('lacks verified') });
    await store.completeItem(goal.id, goal.checklist[2]!.id, { kind: 'check', value: 'bun run test:core passed' });
    await expect(runner.startNext(goal.id)).resolves.toMatchObject({ blocked: 'Checklist complete: final verification is required', goal: { status: 'paused' } });
    await expect(runner.finalize(goal.id)).resolves.toMatchObject({ goal: { status: 'completed' } });
  });

  test('uses the requested planning depth to create dependency-aware checklists', async () => {
    const minimal = await store.create({ objective: 'Quick verified change', scope: 'workspace', planningDepth: 'minimal' });
    const structured = await store.create({ objective: 'High-uncertainty project', scope: 'workspace', planningDepth: 'structured' });
    expect(minimal.checklist).toHaveLength(2);
    expect(structured.checklist).toHaveLength(4);
    expect(structured.checklist[2]?.dependsOn).toEqual([structured.checklist[1]?.id]);
  });

  test('fails closed for cloud approval and never upgrades native CLI output', () => {
    expect(goalProviderPolicy('jules')).toMatchObject({ allowed: false, verification: 'remote-pending-review' });
    expect(goalProviderPolicy('jules', true)).toMatchObject({ allowed: true, verification: 'remote-pending-review' });
    expect(goalProviderPolicy('claude').verification).toBe('unverified');
    expect(goalProviderPolicy('codex').verification).toBe('unverified');
    expect(goalProviderPolicy('kimicode').verification).toBe('unverified');
    expect(goalProviderPolicy('openai')).toMatchObject({ allowed: true, verification: 'eligible' });
  });

  test('honors priority across simultaneously active dependency-ready goals', async () => {
    const lower = await store.create({ objective: 'Lower priority', scope: 'workspace', priority: 1, sortOrder: 1 });
    const higher = await store.create({ objective: 'Higher priority', scope: 'workspace', priority: 2, sortOrder: 99 });
    const runner = new GoalRunner(store);
    expect((await runner.nextEligible())?.id).toBe(higher.id);
    expect((await runner.startNextEligible()).item?.id).toBe(higher.checklist[0]?.id);
    expect((await store.get(lower.id))?.status).toBe('queued');
  });

  test('rejects circular checklist dependencies before they can be scheduled', async () => {
    await expect(store.create({ objective: 'Invalid graph', scope: 'workspace', checklist: [
      { id: 'a', title: 'A', status: 'pending', order: 0, dependsOn: ['b'], evidence: [] },
      { id: 'b', title: 'B', status: 'pending', order: 1, dependsOn: ['a'], evidence: [] },
    ] })).rejects.toThrow('cycle');
  });

  test('renders goal context into every compiled provider prompt', () => {
    const root = mkdtempSync(join(tmpdir(), 'goal-contract-')); mkdirSync(join(root, '.git'));
    const compiled = compilePrompt({ role: 'worker', mode: 'advanced', provider: 'openai', workingDirectory: root, taskContract: createTaskContract('Implement it', { goalContext: { goalId: 'goal-1', objective: 'Finish Goal Mode', itemId: 'item-1', itemTitle: 'Verify flow', verification: 'eligible' } }) });
    expect(compiled.systemPrompt).toContain('Goal ID: goal-1');
    expect(compiled.systemPrompt).toContain('Active checklist item: Verify flow');
  });

  test('manager create_goal tool persists an explicit scoped goal without completing it', async () => {
    setContext({ goals: store } as any);
    const result = await new CreateGoalTool().run({ sessionId: 'chat-1', workingDirectory: '/tmp/project' }, { id: 'call-1', name: 'create_goal', input: { objective: 'Track the release', scope: 'project', planningDepth: 'structured' } });
    expect(result.isError).toBe(false);
    expect((await store.list())[0]).toMatchObject({ objective: 'Track the release', scope: 'project', status: 'queued' });
  });
});

describe('Goal Mode HTTP user flow', () => {
  test('creates, drives, evidences, and finalizes through the guarded API', async () => {
    const emitted: unknown[] = [];
    const dispatched: unknown[][] = [];
    setContext({
      goals: store,
      sessions: { get: async () => ({ id: 'chat-1', workingDirectory: undefined }) },
      kory: { processTask: async (...args: unknown[]) => { dispatched.push(args); } },
      wsManager: { broadcast: (message: unknown) => emitted.push(message) },
    } as any);
    const app = new Elysia().use(goalRoutes);
    const auth = buildLocalBearerToken(localAuth.createSession());
    const call = async (path: string, body?: unknown) => app.handle(new Request(`http://local${path}`, { method: body === undefined ? 'POST' : 'POST', headers: { authorization: auth, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }));
    const created = await call('/api/goals', { objective: 'Exercise Goal Mode', scope: 'workspace' });
    const goal = (await created.json() as { data: { id: string; checklist: Array<{ id: string }> } }).data;
    for (const item of goal.checklist) {
      const driven = await call(`/api/goals/${goal.id}/drive`, { sessionId: 'chat-1', provider: 'openai', model: 'openai:gpt-test', instructions: `focus item ${item.id}` });
      expect(driven.status).toBe(200);
      const complete = await call(`/api/goals/${goal.id}/checklist/${item.id}/complete`, { kind: 'check', value: `verified ${item.id}` });
      expect(complete.status).toBe(200);
    }
    const finalized = await call(`/api/goals/${goal.id}/finalize`);
    expect(finalized.status).toBe(200);
    expect((await finalized.json() as { data: { status: string } }).data.status).toBe('completed');
    expect(emitted.length).toBeGreaterThan(3);
    expect(String(dispatched[0]?.[1])).toContain('User direction for this item');
    expect((dispatched[0]?.[7] as { goalId?: string })?.goalId).toBe(goal.id);
  });
});
