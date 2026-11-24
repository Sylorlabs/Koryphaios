import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/svelte';
import Harness from './__fixtures__/AgentRailHarness.svelte';

const fetchMock = vi.fn();
const okResponse = (body: unknown = { ok: true }) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

vi.mock('$lib/utils/api-url', () => ({
  apiUrl: (path: string) => `http://127.0.0.1:3001${path}`,
  getWsUrl: () => '',
}));
vi.mock('$lib/api.svelte', () => ({
  apiFetch: (...args: unknown[]) => fetchMock(...args),
  parseJsonResponse: async (res: Response) => res.json(),
}));
vi.mock('$lib/stores/toast.svelte', () => ({
  toastStore: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
vi.mock('$lib/stores/sessions.svelte', () => ({
  sessionStore: { activeSessionId: 's1' },
}));
vi.mock('$lib/stores/websocket.svelte', () => ({
  wsStore: {
    agents: new Map(),
    markAgentStopped: vi.fn(),
    get agentThreadVersion() {
      return 0;
    },
    getAgentThreadFeed: () => [],
    loadAgentThreadMessages: vi.fn(),
  },
}));
const agentRecords = vi.hoisted(() => new Map<string, unknown>());
vi.mock('$lib/stores/agents.svelte', () => ({
  agentStore: {
    getAgent: (sessionId: string, agentId: string) => agentRecords.get(`${sessionId}::${agentId}`),
    getSessionAgents: (sessionId: string) =>
      [...agentRecords.values()].filter(
        (a) => (a as { sessionId: string }).sessionId === sessionId,
      ),
    closeAgentCard: vi.fn(),
    reopenAgentCard: vi.fn(),
  },
}));
vi.mock('$lib/stores/run-state-core', () => ({
  ACTIVE_AGENT_STATUSES: new Set(['thinking', 'streaming', 'tool_calling']),
  TERMINAL_AGENT_STATUSES: new Set(['done', 'idle', 'error']),
}));

import { wsStore } from '$lib/stores/websocket.svelte';
import { agentStore } from '$lib/stores/agents.svelte';
import { toastStore } from '$lib/stores/toast.svelte';
import type { AgentRailState } from './useAgentRail.svelte';

/**
 * useAgentRail declares $effect, which Svelte only permits inside a component
 * tree. The close path itself is plain state plus one awaited request, so a
 * throwaway host component is enough to get a real, effect-scoped rail.
 */
function makeRail(): AgentRailState {
  let rail!: AgentRailState;
  render(Harness, { props: { onReady: (r) => (rail = r) } });
  return rail;
}

function seedAgent(id: string, status: string, name = 'Backend') {
  agentRecords.set(`s1::${id}`, {
    identity: { id, name, role: 'worker', domain: 'backend', provider: 'openai', model: 'gpt' },
    status,
    content: '',
    thinking: '',
    toolCalls: [],
    task: '',
    tokensUsed: 0,
    contextMax: 0,
    contextKnown: false,
    sessionId: 's1',
  });
}

describe('agent rail close', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    agentRecords.clear();
    (agentStore.closeAgentCard as ReturnType<typeof vi.fn>).mockReset();
    (toastStore.error as ReturnType<typeof vi.fn>).mockReset();
  });
  // @testing-library/svelte unmounts after each test, which tears down the
  // effect tree the rail's $effect blocks live in.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends the cancel to an absolute backend URL for a running worker', async () => {
    fetchMock.mockResolvedValue(okResponse());
    seedAgent('w1', 'thinking');
    const rail = makeRail();

    await rail.closeAgent('w1');

    // The original bug: a relative '/api/...' that never left the app origin.
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:3001/api/agent/w1/cancel', {
      method: 'POST',
    });
    expect(agentStore.closeAgentCard).toHaveBeenCalledWith('s1', 'w1');
  });

  it('percent-encodes an agent id that contains URL-significant characters', async () => {
    fetchMock.mockResolvedValue(okResponse());
    seedAgent('a/b?c', 'thinking');
    const rail = makeRail();

    await rail.closeAgent('a/b?c');

    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:3001/api/agent/a%2Fb%3Fc/cancel');
  });

  it('skips the network entirely for an already-finished worker', async () => {
    seedAgent('w2', 'done');
    const rail = makeRail();

    await rail.closeAgent('w2');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(agentStore.closeAgentCard).toHaveBeenCalledWith('s1', 'w2');
  });

  it('keeps the card and reports the error when the cancel fails', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: 'boom' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    seedAgent('w3', 'streaming', 'Frontend');
    const rail = makeRail();

    await rail.closeAgent('w3');

    // Dropping a card whose worker is still live would hide running work.
    expect(agentStore.closeAgentCard).not.toHaveBeenCalled();
    expect(toastStore.error).toHaveBeenCalledWith(expect.stringContaining('Frontend'));
  });

  it('keeps the card when the request rejects outright', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    seedAgent('w4', 'streaming');
    const rail = makeRail();

    await rail.closeAgent('w4');

    expect(agentStore.closeAgentCard).not.toHaveBeenCalled();
    expect(toastStore.error).toHaveBeenCalled();
  });

  it('returns to the manager feed when the open transcript is closed', async () => {
    fetchMock.mockResolvedValue(okResponse());
    seedAgent('w5', 'thinking');
    const rail = makeRail();

    rail.selectAgent('w5');
    expect(rail.selectedAgentId).toBe('w5');

    await rail.closeAgent('w5');

    expect(rail.selectedAgentId).toBe('');
  });

  it('ignores a close for an agent that is not in the rail', async () => {
    const rail = makeRail();

    await rail.closeAgent('ghost');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(agentStore.closeAgentCard).not.toHaveBeenCalled();
  });
});
