import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { initDb } from '../../db';
import { ChecklistStore } from '../../stores/checklist-store';
import { checklistTools } from '../../tools/checklists';
import { EditGoalChecklistTool } from '../../tools/goals';
import { GoalStore } from '../../stores/goal-store';
import { ToolRegistry } from '../../tools/registry';
import { setContext } from '../../context';
import { WSManager } from '../../ws/ws-manager';
import type { AppContext } from '../../context';

const store = new ChecklistStore();
const goals = new GoalStore();

beforeAll(async () => {
  await initDb();
  // The tools reach the store through the app context singleton, exactly as
  // they do at runtime. Only the two members they touch need to be real.
  setContext({ checklists: store, goals, wsManager: new WSManager() } as unknown as AppContext);
});

afterAll(async () => {
  // Leave no rows behind for the next file sharing this database.
  for (const checklist of await store.list({ includeArchived: true })) {
    await store.delete(checklist.id);
  }
  for (const goal of await goals.list()) await goals.delete(goal.id);
});

beforeEach(async () => {
  for (const checklist of await store.list({ includeArchived: true })) {
    await store.delete(checklist.id);
  }
});

/** A minimal ToolContext: the checklist tools only read these three fields. */
const ctx = (overrides: Record<string, unknown> = {}) =>
  ({
    sessionId: 'session-1',
    workingDirectory: '/tmp/project',
    ...overrides,
  }) as never;

const call = (name: string, input: Record<string, unknown>) => ({
  id: 'call-1',
  name,
  input,
});

const run = (name: string, input: Record<string, unknown>, context = ctx()) => {
  const tool = checklistTools.find((entry) => entry.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  return tool.run(context, call(name, input));
};

describe('checklist store', () => {
  test('creates with ordered pending items', async () => {
    const checklist = await store.create({
      title: 'Ship the thing',
      items: ['design', 'build', 'test'],
    });
    expect(checklist.items.map((item) => item.title)).toEqual(['design', 'build', 'test']);
    expect(checklist.items.every((item) => item.status === 'pending')).toBe(true);
    expect(checklist.items.map((item) => item.order)).toEqual([0, 1, 2]);
    expect(checklist.scope).toBe('workspace');
  });

  test('scopes a checklist created inside a chat to that chat', async () => {
    const checklist = await store.create({ title: 'Per-chat plan', sessionId: 'session-a' });
    expect(checklist.scope).toBe('session');
    expect(checklist.sessionId).toBe('session-a');
    const here = await store.listVisible({ sessionId: 'session-a' });
    const elsewhere = await store.listVisible({ sessionId: 'session-b' });
    expect(here.map((entry) => entry.id)).toContain(checklist.id);
    expect(elsewhere.map((entry) => entry.id)).not.toContain(checklist.id);
  });

  test('rejects an empty title and a scope it cannot satisfy', async () => {
    await expect(store.create({ title: '   ' })).rejects.toThrow(/require a title/);
    await expect(store.create({ title: 'x', scope: 'project' })).rejects.toThrow(
      /project directory/,
    );
    await expect(store.create({ title: 'x', scope: 'session' })).rejects.toThrow(/owning chat/);
  });

  test('addItems appends without needing existing ids', async () => {
    const checklist = await store.create({ title: 'Later', items: ['one'] });
    const updated = await store.addItems(checklist.id, ['two', 'three']);
    expect(updated?.items.map((item) => item.title)).toEqual(['one', 'two', 'three']);
    expect(updated?.items.map((item) => item.order)).toEqual([0, 1, 2]);
  });

  test('setItemStatus toggles and is idempotent', async () => {
    const checklist = await store.create({ title: 'Toggle', items: ['step'] });
    const itemId = checklist.items[0]!.id;
    const done = await store.setItemStatus(checklist.id, itemId, 'done');
    expect(done?.items[0]!.status).toBe('done');
    expect(done?.items[0]!.completedAt).toBeNumber();
    // Re-sending the same state must not throw, so a retried agent call is safe.
    const again = await store.setItemStatus(checklist.id, itemId, 'done');
    expect(again?.items[0]!.status).toBe('done');
    const reopened = await store.setItemStatus(checklist.id, itemId, 'pending');
    expect(reopened?.items[0]!.status).toBe('pending');
    expect(reopened?.items[0]!.completedAt).toBeUndefined();
  });

  test('finishing every item archives the list, and reopening un-archives it', async () => {
    const checklist = await store.create({ title: 'Settle', items: ['a', 'b'] });
    const [first, second] = checklist.items;
    await store.setItemStatus(checklist.id, first!.id, 'done');
    const finished = await store.setItemStatus(checklist.id, second!.id, 'skipped');
    expect(finished?.archivedAt).toBeNumber();
    expect((await store.list()).some((entry) => entry.id === checklist.id)).toBe(false);
    // A skipped item still counts as settled, so only a reopen brings it back.
    const reopened = await store.setItemStatus(checklist.id, second!.id, 'pending');
    expect(reopened?.archivedAt).toBeUndefined();
    expect((await store.list()).some((entry) => entry.id === checklist.id)).toBe(true);
  });

  test('edit preserves status for surviving items and drops omitted ones', async () => {
    const checklist = await store.create({ title: 'Reshape', items: ['keep', 'drop'] });
    const keep = checklist.items[0]!;
    await store.setItemStatus(checklist.id, keep.id, 'done');
    const updated = await store.edit(checklist.id, [
      { id: keep.id, title: 'renamed', order: 0 },
      { title: 'brand new', order: 1 },
    ]);
    expect(updated?.items.map((item) => item.title)).toEqual(['renamed', 'brand new']);
    // The crucial invariant: an edit cannot rewrite a settled item.
    expect(updated?.items[0]!.status).toBe('done');
    expect(updated?.items[1]!.status).toBe('pending');
  });

  test('an empty plan clears the list', async () => {
    const checklist = await store.create({ title: 'Clear me', items: ['a', 'b'] });
    const cleared = await store.edit(checklist.id, []);
    expect(cleared?.items).toEqual([]);
  });

  test('records which actor changed the list', async () => {
    const checklist = await store.create({ title: 'Audit', items: ['a'] });
    const updated = await store.setItemStatus(checklist.id, checklist.items[0]!.id, 'done', {
      name: 'worker agent',
      role: 'worker',
    });
    const last = updated?.activity.at(-1);
    expect(last?.actor).toBe('worker agent');
    expect(last?.actorRole).toBe('worker');
  });

  test('listVisible scopes by chat and workspace', async () => {
    const global = await store.create({ title: 'Global', scope: 'workspace' });
    const mine = await store.create({ title: 'Mine', scope: 'session', sessionId: 'session-1' });
    await store.create({ title: 'Theirs', scope: 'session', sessionId: 'session-2' });
    const visible = await store.listVisible({ sessionId: 'session-1' });
    const ids = visible.map((entry) => entry.id);
    expect(ids).toContain(global.id);
    expect(ids).toContain(mine.id);
    expect(ids).not.toContain('nope');
    expect(ids.some((id) => visible.find((entry) => entry.id === id)!.title === 'Theirs')).toBe(
      false,
    );
  });
});

describe('checklist tools', () => {
  test('every checklist tool is reachable by every role', () => {
    const registry = new ToolRegistry();
    for (const tool of checklistTools) registry.register(tool);
    for (const role of ['manager', 'worker', 'critic'] as const) {
      const names = registry.getToolDefsForRole(role).map((entry) => entry.name);
      for (const tool of checklistTools) {
        expect(names).toContain(tool.name);
        expect(registry.isAllowedForRole(tool.name, role)).toBe(true);
      }
    }
  });

  test('an agent checklist stays inside the chat that asked for it', async () => {
    const result = await run('create_checklist', { title: 'Agent plan' });
    expect(result.isError).toBe(false);
    const [created] = await store.list();
    expect(created?.scope).toBe('session');
    expect(created?.sessionId).toBe('session-1');
    expect(await store.listVisible({ sessionId: 'another-chat' })).toEqual([]);
  });

  test('create returns an embed token so the transcript can render it', async () => {
    const result = await run('create_checklist', { title: 'Embed me' });
    expect(result.isError).toBe(false);
    expect(result.output).toMatch(/\{\{checklist:[A-Za-z0-9_-]+\}\}/);
  });

  test('check_checklist_item is a no-op-safe toggle, not a completion claim', async () => {
    const created = await run('create_checklist', { title: 'Toggle me', items: ['step'] });
    const id = created.output.match(/\(([A-Za-z0-9_-]+)\)/)![1]!;
    const itemId = created.output.match(/\[.\]\s+(\S+)\s/)?.[1];
    const result = await run('check_checklist_item', { id, itemId: itemId ?? '', status: 'done' });
    expect(result.isError).toBe(false);
    expect(result.output).toContain('1/1 done');
  });

  test('reports a missing checklist instead of silently succeeding', async () => {
    const result = await run('read_checklist', { id: 'does-not-exist' });
    expect(result.isError).toBe(true);
    expect(result.output).toContain('No checklist');
  });

  test('requires a title', async () => {
    const result = await run('create_checklist', { title: '  ' });
    expect(result.isError).toBe(true);
  });

  test('list reports an empty result without calling it an error', async () => {
    const result = await run('list_checklists', {});
    expect(result.isError).toBe(false);
    expect(result.output).toMatch(/No checklists found|done, scope/);
  });
});

describe('goal checklist plan editing stays shape-only', () => {
  test('an agent can reshape a plan but cannot complete a check', async () => {
    const goal = await goals.create({ objective: 'Verify the gate', scope: 'workspace' });
    const tool = new EditGoalChecklistTool();
    const result = await tool.run(
      ctx() as never,
      call(tool.name, {
        goalId: goal.id,
        items: [{ title: 'first thing' }, { title: 'second thing' }],
      }),
    );
    expect(result.isError).toBe(false);
    const stored = await goals.get(goal.id);
    expect(stored?.checklist.map((item) => item.title)).toEqual(['first thing', 'second thing']);
    // Shape changed; nothing was settled.
    expect(stored?.checklist.every((item) => item.status === 'pending')).toBe(true);
  });

  test('a client-supplied status is ignored, not obeyed', async () => {
    const goal = await goals.create({ objective: 'No forging', scope: 'workspace' });
    await goals.editChecklistPlan(goal.id, [{ title: 'only step' }]);
    const stored = await goals.get(goal.id);
    const step = stored!.checklist[0]!;
    const forged = await goals.editChecklistPlan(goal.id, [
      { id: step.id, title: 'only step' } as never,
    ]);
    expect(forged?.checklist[0]!.status).toBe('pending');
    expect(forged?.checklist[0]!.evidence).toEqual([]);
  });

  test('attributes the edit to the agent rather than a person', async () => {
    const goal = await goals.create({ objective: 'Attribution', scope: 'workspace' });
    const tool = new EditGoalChecklistTool();
    await tool.run(
      ctx({ callerRole: 'worker' }) as never,
      call(tool.name, { goalId: goal.id, items: [{ title: 'a' }, { title: 'b' }] }),
    );
    const stored = await goals.get(goal.id);
    expect(stored?.activity.at(-1)?.message).toContain('worker agent');
  });

  test('rejects a plan with no titles', async () => {
    const goal = await goals.create({ objective: 'Empty plan', scope: 'workspace' });
    const tool = new EditGoalChecklistTool();
    const result = await tool.run(
      ctx() as never,
      call(tool.name, { goalId: goal.id, items: [{ title: '   ' }] }),
    );
    expect(result.isError).toBe(true);
  });
});
