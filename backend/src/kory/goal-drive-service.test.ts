import { describe, expect, test } from 'bun:test';
import type { Goal, GoalChecklistItem } from '@koryphaios/shared';
import { GoalDriveService } from './goal-drive-service';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { advanceWorkflow, getWorkflowDefinition, startWorkflow } from './workflows';

const waitFor = async (predicate: () => boolean) => {
  const deadline = Date.now() + 2_000;
  while (!predicate() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  expect(predicate()).toBe(true);
};

function harness(criticSkipped = false, workflowRoot?: string) {
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
    async addActivity(id: string, type: string, message: string, sessionId?: string) {
      return this.update(id, {
        activity: [
          ...goal.activity,
          { id: crypto.randomUUID(), type, message, sessionId, createdAt: Date.now() },
        ],
      });
    },
    async resetItem(id: string, itemId: string, reason: string) {
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
    async completeItem(
      id: string,
      itemId: string,
      evidence: { kind: 'check' | 'artifact' | 'note'; value: string },
    ) {
      return this.update(id, {
        checklist: goal.checklist.map((item) =>
          item.id === itemId
            ? {
                ...item,
                status: 'completed',
                completedAt: Date.now(),
                evidence: [
                  ...item.evidence,
                  { id: crypto.randomUUID(), ...evidence, verified: true, createdAt: Date.now() },
                ],
              }
            : item,
        ),
      });
    },
    async finalize(id: string) {
      return this.update(id, { status: 'completed' });
    },
  };
  let turns = 0;
  const kory = {
    isSessionRunning: () => false,
    cancelSessionWorkers: () => {},
    async processTask() {
      turns += 1;
      const running = goal.checklist.find((item) => item.status === 'running')!;
      if (workflowRoot && running.id === 'one') {
        let workflow = startWorkflow(workflowRoot, {
          workflowId: 'design-quality',
          sessionId: 'session',
          goalId: goal.id,
          goalItemId: running.id,
          task: running.title,
          requestedBy: 'agent',
        });
        for (const stage of getWorkflowDefinition('design-quality')!.stages) {
          workflow = advanceWorkflow(workflowRoot, workflow.id, { evidence: `${stage.id} proof` });
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
    async verifyGoalItem() {
      return {
        passed: true,
        skipped: criticSkipped,
        feedback: criticSkipped ? 'Critic disabled by user.' : 'PASS',
      };
    },
    async verifyGoalBlocker() {
      return { passed: true };
    },
  };
  const driver = new GoalDriveService(
    store as never,
    { get: async () => ({ id: 'session', workingDirectory: workflowRoot }) } as never,
    kory as never,
    { broadcast: () => {} } as never,
  );
  return {
    driver,
    get goal() {
      return goal;
    },
    get turns() {
      return turns;
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
  });

  test('respects the global Critic-off state while still requiring producer evidence', async () => {
    const state = harness(true);
    await state.driver.start('goal', {
      sessionId: 'session',
      provider: 'openai',
      model: 'openai:test',
    });
    await waitFor(() => state.goal.status === 'completed');
    expect(state.goal.checklist[0]?.evidence[0]?.value).toContain('Critic disabled by user');
    expect(state.goal.checklist[0]?.evidence[0]?.value).toContain('verified artifact one');
  });

  test('replays an interrupted checklist item after a backend restart', async () => {
    const state = harness();
    state.interruptFirstItem();
    await state.driver.recover();
    await waitFor(() => state.goal.status === 'completed');
    expect(state.turns).toBe(2);
    expect(state.goal.activity.some((event) => event.type === 'item_retry')).toBe(true);
  });

  test('promotes completed linked workflow evidence through the Goal critic gate', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kory-goal-workflow-'));
    try {
      const state = harness(false, root);
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
