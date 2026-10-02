import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  unsubscribeFromSession: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('$lib/api.svelte', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('$lib/utils/api-url', () => ({ apiUrl: (path: string) => path }));
vi.mock('./toast.svelte', () => ({
  toastStore: { success: mocks.success, error: mocks.error },
}));
vi.mock('./websocket.svelte', () => ({
  wsStore: { unsubscribeFromSession: mocks.unsubscribeFromSession },
}));
vi.mock('./project.svelte', () => ({
  projectStore: {
    workspaceRoot: null,
    currentPath: '/tmp/project',
    scope: 'all',
    setScope: vi.fn(),
  },
}));

import type { Goal } from '@koryphaios/shared';
import { sessionStore, type LifecycleSession } from './sessions.svelte';
import { goalStore } from './goals.svelte';
import { feedStore } from './feed.svelte';
import { notifySessionRemoved, onSessionRemoved } from './session-removal';

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function session(id: string, overrides: Partial<LifecycleSession> = {}): LifecycleSession {
  return {
    id,
    title: `Chat ${id}`,
    workingDirectory: '/tmp/project',
    messageCount: 2,
    totalTokensIn: 10,
    totalTokensOut: 20,
    totalCost: 0.01,
    version: 1,
    createdAt: 1_000,
    updatedAt: 2_000,
    ...overrides,
  };
}

function goal(id: string, overrides: Partial<Goal> = {}): Goal {
  return {
    id,
    objective: `Objective ${id}`,
    scope: 'workspace',
    priority: 0,
    sortOrder: 0,
    status: 'running',
    checklist: [],
    linkedSessionIds: [],
    activity: [],
    activeDurationMs: 0,
    createdAt: 1_000,
    updatedAt: 2_000,
    ...overrides,
  };
}

function seedGoal(value: Goal): void {
  goalStore.handleUpdated({ goal: value });
}

/** The server's post-erasure goal projection, once the DELETE has committed. */
function mockErasure(goals: Goal[] = [], status = 200, extra: Record<string, unknown> = {}): void {
  mocks.apiFetch.mockResolvedValueOnce(response({ ok: true, ...extra }, status));
  mocks.apiFetch.mockResolvedValueOnce(response({ ok: true, data: goals }));
}

function goalFetchCount(): number {
  return mocks.apiFetch.mock.calls.filter(([url]) => url === '/api/goals').length;
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionStore.seedDemoSessions([session('one'), session('two')], 'one');
  feedStore.activateSessionFeed('');
});

describe('deleting a chat that owns goal state', () => {
  it('prunes the goal that ran in the deleted chat and resyncs from the server', async () => {
    seedGoal(goal('g1', { execution: { sessionId: 'one' } as Goal['execution'] }));
    goalStore.selectedGoalId = 'g1';
    mockErasure();

    await expect(sessionStore.deleteSession('one')).resolves.toBe(true);

    expect(goalStore.goals).toEqual([]);
    expect(goalStore.selectedGoalId).toBe('');
    await vi.waitFor(() => expect(goalFetchCount()).toBe(1));
  });

  it('keeps a surviving goal but drops its link to the deleted chat', async () => {
    seedGoal(goal('owned', { scope: 'session', sessionId: 'one' }));
    seedGoal(goal('other', { linkedSessionIds: ['one', 'two'] }));
    goalStore.selectedGoalId = 'owned';
    mockErasure();

    await sessionStore.deleteSession('one');

    expect(goalStore.goals.map((item) => item.id)).toEqual(['other']);
    expect(goalStore.goals[0]?.linkedSessionIds).toEqual(['two']);
    expect(goalStore.selectedGoalId).toBe('');
    await vi.waitFor(() => expect(goalFetchCount()).toBe(1));
  });

  it('drops the deleted chat transcript without leaving a loading state', async () => {
    feedStore.activateSessionFeed('one');
    feedStore.addFeedEntry({
      type: 'content',
      agentId: 'kory-manager',
      agentName: 'Kory',
      glowClass: '',
      text: 'hello',
      timestamp: 5,
      metadata: { sessionId: 'one' },
    });
    expect(feedStore.lastEntryForSession('one')?.text).toBe('hello');
    mockErasure();

    await sessionStore.deleteSession('one');

    expect(feedStore.lastEntryForSession('one')).toBeUndefined();
    expect(feedStore.isLoadingSession).toBe(false);
    expect(sessionStore.activeSessionId).toBe('two');
  });

  it('reconciles every window when another client deletes the chat', async () => {
    seedGoal(goal('g1', { execution: { sessionId: 'one' } as Goal['execution'] }));
    mocks.apiFetch.mockResolvedValueOnce(response({ ok: true, data: [] }));

    sessionStore.handleSessionDeleted('one');

    expect(goalStore.goals).toEqual([]);
    await vi.waitFor(() => expect(goalFetchCount()).toBe(1));
  });

  it('cleans up on delete-all and coalesces the resync into one request', async () => {
    seedGoal(goal('g1', { execution: { sessionId: 'one' } as Goal['execution'] }));
    seedGoal(goal('g2', { execution: { sessionId: 'two' } as Goal['execution'] }));
    mockErasure([], 200, { deleted: 2 });

    await expect(sessionStore.deleteAllSessions()).resolves.toBe(true);

    expect(goalStore.goals).toEqual([]);
    expect(sessionStore.activeSessionId).toBe('');
    await vi.waitFor(() => expect(goalFetchCount()).toBe(1));
  });

  it('leaves goal state untouched when the deletion is refused', async () => {
    seedGoal(goal('g1', { execution: { sessionId: 'one' } as Goal['execution'] }));
    mocks.apiFetch.mockResolvedValueOnce(
      response({ error: 'Session one has a process start in flight' }, 409),
    );

    await expect(sessionStore.deleteSession('one')).resolves.toBe(false);

    expect(goalStore.goals.map((item) => item.id)).toEqual(['g1']);
    expect(goalFetchCount()).toBe(0);
  });
});

describe('session removal fan-out', () => {
  it('keeps notifying the remaining stores when one listener throws', () => {
    const seen: string[] = [];
    const stopThrower = onSessionRemoved(() => {
      throw new Error('store blew up');
    });
    const stopRecorder = onSessionRemoved((id) => seen.push(id));

    notifySessionRemoved('one');

    expect(seen).toEqual(['one']);
    stopThrower();
    stopRecorder();
  });

  it('supports unsubscribing', () => {
    const seen: string[] = [];
    const stop = onSessionRemoved((id) => seen.push(id));
    stop();
    notifySessionRemoved('one');
    expect(seen).toEqual([]);
  });
});
