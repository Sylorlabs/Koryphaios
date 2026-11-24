import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import type { AgentStatus } from '@koryphaios/shared';

import AgentActivity from './AgentActivity.svelte';
import type { AgentRailState } from './useAgentRail.svelte';

const currentTools = vi.hoisted(() => new Map<string, { name: string; input?: Record<string, unknown> }>());
vi.mock('$lib/stores/agents.svelte', () => ({
  agentStore: {
    getAgentSteeringQueue: () => [],
    getAgentCurrentTool: (_sessionId: string, agentId: string) => currentTools.get(agentId),
  },
}));

interface Fixture {
  id?: string;
  name?: string;
  status?: AgentStatus;
  task?: string;
  content?: string;
  parentAgentId?: string;
  startedAt?: number;
  endedAt?: number;
  stopReason?: 'cancelled';
  provider?: string;
  model?: string;
}

function makeAgent(fixture: Fixture = {}) {
  const id = fixture.id ?? 'worker-1';
  return {
    identity: {
      id,
      name: fixture.name ?? 'General Worker',
      role: 'worker',
      domain: 'general',
      provider: fixture.provider ?? 'openai',
      model: fixture.model ?? 'gpt-test',
      glowColor: 'var(--color-accent)',
    },
    status: fixture.status ?? ('thinking' as AgentStatus),
    content: fixture.content ?? '',
    thinking: '',
    toolCalls: [],
    task: fixture.task ?? 'Inspect the delegated task',
    tokensUsed: 0,
    contextMax: 0,
    contextKnown: false,
    sessionId: 'session-1',
    parentAgentId: fixture.parentAgentId,
    startedAt: fixture.startedAt,
    endedAt: fixture.endedAt,
    stopReason: fixture.stopReason,
  };
}

function makeRail(agents = [makeAgent()]) {
  return {
    sessionAgentChats: agents,
    selectedAgentId: '',
    closingAgentIds: new Set<string>(),
    clearSelection: vi.fn(),
    selectAgent: vi.fn(),
    closeAgent: vi.fn(),
    closeAllAgents: vi.fn(),
  } as unknown as AgentRailState;
}

async function openDetails(rail: AgentRailState) {
  render(AgentActivity, { props: { rail } });
  await fireEvent.click(screen.getByRole('button', { name: /^Activity/ }));
  return screen.getByRole('region', { name: 'Activity details' });
}

function rowOf(agentId: string): HTMLElement {
  return document.querySelector<HTMLElement>(`[data-agent-id="${agentId}"]`)!;
}

describe('AgentActivity', () => {
  it('shows a compact activity list on hover with the status in words', async () => {
    render(AgentActivity, { props: { rail: makeRail() } });

    await fireEvent.pointerEnter(screen.getByRole('group', { name: 'Agent activity' }));

    expect(screen.getByText('General Worker')).toBeTruthy();
    expect(screen.getByText('Thinking')).toBeTruthy();
    expect(screen.queryByText('Inspect the delegated task')).toBeNull();
  });

  it('opens the detailed activity menu when Activity is clicked', async () => {
    await openDetails(makeRail());

    expect(screen.getByText('Inspect the delegated task')).toBeTruthy();
    // Provider ids are shown as product names.
    expect(screen.getByText('OpenAI · gpt-test')).toBeTruthy();
  });

  it('shows per-agent dismiss controls and clears every agent from the preview', async () => {
    const rail = makeRail();
    render(AgentActivity, { props: { rail } });

    await fireEvent.pointerEnter(screen.getByRole('group', { name: 'Agent activity' }));

    expect(screen.getByRole('button', { name: 'Stop and close General Worker' })).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(rail.closeAllAgents).toHaveBeenCalledTimes(1);
  });

  it('summarises the run on the trigger, in words for anything that needs the user', () => {
    render(AgentActivity, {
      props: {
        rail: makeRail([
          makeAgent({ id: 'a', status: 'tool_calling' }),
          makeAgent({ id: 'b', status: 'thinking' }),
          makeAgent({ id: 'c', status: 'waiting_user' }),
          makeAgent({ id: 'd', status: 'error' }),
        ]),
      },
    });

    const trigger = screen.getByRole('button', { name: /^Activity/ });
    expect(trigger.getAttribute('aria-label')).toBe('Activity, 2 running, 1 needs you, 1 failed');
    expect(trigger.textContent).toContain('1 needs you');
  });

  it('shows what a running agent is doing right now: tool and short argument', async () => {
    currentTools.set('runner', { name: 'bash', input: { command: 'bun run test src/lib/charts --reporter=dot' } });
    try {
      await openDetails(makeRail([makeAgent({ id: 'runner', status: 'tool_calling' })]));
      expect(within(rowOf('runner')).getByText(/^Running tool: bash · bun run test/)).toBeTruthy();
    } finally {
      currentTools.clear();
    }
  });

  it('draws lineage: a child of a child sits under its parent, indented by depth', async () => {
    await openDetails(
      makeRail([
        makeAgent({ id: 'critic', name: 'Critic', status: 'criticizing' }),
        makeAgent({ id: 'reviewer', name: 'Review Specialist', status: 'tool_calling', parentAgentId: 'critic' }),
        makeAgent({ id: 'probe', name: 'Probe', status: 'thinking', parentAgentId: 'reviewer' }),
        makeAgent({ id: 'other', name: 'Other', status: 'thinking' }),
      ]),
    );

    const order = [...document.querySelectorAll<HTMLElement>('[data-agent-id]')].map((row) => row.dataset.agentId);
    expect(order).toEqual(['critic', 'reviewer', 'probe', 'other']);
    expect(rowOf('critic').dataset.depth).toBe('0');
    expect(rowOf('reviewer').dataset.depth).toBe('1');
    expect(rowOf('probe').dataset.depth).toBe('2');
    expect(screen.getByText(/indented agents were started by the agent above them/)).toBeTruthy();
  });

  it('orders roots by what needs the user first: waiting, failed, running, finished', async () => {
    await openDetails(
      makeRail([
        makeAgent({ id: 'done', status: 'done' }),
        makeAgent({ id: 'run', status: 'streaming' }),
        makeAgent({ id: 'fail', status: 'error' }),
        makeAgent({ id: 'ask', status: 'waiting_user' }),
      ]),
    );
    const order = [...document.querySelectorAll<HTMLElement>('[data-agent-id]')].map((row) => row.dataset.agentId);
    expect(order).toEqual(['ask', 'fail', 'run', 'done']);
  });

  it('labels failed, cancelled and waiting agents in words, never colour alone', async () => {
    await openDetails(
      makeRail([
        makeAgent({ id: 'fail', status: 'error' }),
        makeAgent({ id: 'stop', status: 'done', stopReason: 'cancelled' }),
        makeAgent({ id: 'ask', status: 'waiting_user' }),
        makeAgent({ id: 'ok', status: 'done', content: '## Summary\nAdded migration 0050.' }),
      ]),
    );
    expect(within(rowOf('fail')).getByText('Failed')).toBeTruthy();
    expect(within(rowOf('stop')).getByText('Stopped')).toBeTruthy();
    expect(within(rowOf('ask')).getByText('Waiting on you')).toBeTruthy();
    // A finished agent shows a one-line result, skipping the heading.
    expect(within(rowOf('ok')).getByText('Done')).toBeTruthy();
    expect(within(rowOf('ok')).getByText('Added migration 0050.')).toBeTruthy();
  });

  it('shows a frozen duration for a finished agent and none when the start is unknown', async () => {
    await openDetails(
      makeRail([
        makeAgent({ id: 'timed', status: 'done', startedAt: 1_000, endedAt: 1_000 + 125_000 }),
        makeAgent({ id: 'untimed', status: 'thinking' }),
      ]),
    );
    expect(within(rowOf('timed')).getByText('2m 05s')).toBeTruthy();
    expect(rowOf('untimed').querySelector('.elapsed')!.textContent).toBe('');
  });

  it('expands a row to show the full task and result with aria-expanded', async () => {
    const longTask = 'Refactor the query layer '.repeat(12).trim();
    await openDetails(makeRail([makeAgent({ id: 'x', status: 'error', task: longTask })]));
    const toggle = within(rowOf('x')).getByRole('button', { name: /Show details for/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(within(rowOf('x')).getByText(longTask)).toBeTruthy();
    expect(within(rowOf('x')).getByText(/stopped with an error before reporting a result/)).toBeTruthy();
  });

  it('folds finished agents behind one disclosure when many have run', async () => {
    const finished = Array.from({ length: 6 }, (_, i) => makeAgent({ id: `f${i}`, status: 'done' }));
    await openDetails(makeRail([makeAgent({ id: 'live', status: 'thinking' }), ...finished]));

    expect(document.querySelectorAll('[data-group="finished"]')).toHaveLength(3);
    const more = screen.getByRole('button', { name: 'Show 3 more finished agents' });
    expect(more.getAttribute('aria-expanded')).toBe('false');
    await fireEvent.click(more);
    expect(document.querySelectorAll('[data-group="finished"]')).toHaveLength(6);
    expect(screen.getByRole('button', { name: 'Show fewer finished agents' })).toBeTruthy();
  });

  it('opens an agent chat from its row', async () => {
    const rail = makeRail([makeAgent({ id: 'w', name: 'A very long worker name that will be truncated in the row' })]);
    await openDetails(rail);
    await fireEvent.click(screen.getByRole('button', { name: /^Open A very long worker name/ }));
    expect(rail.selectAgent).toHaveBeenCalledWith('w');
  });

  it('offers a next step instead of an empty panel when no agents ran', async () => {
    render(AgentActivity, { props: { rail: makeRail([]) } });
    await fireEvent.click(screen.getByRole('button', { name: 'Activity' }));
    expect(screen.getByText(/No agents in this chat yet/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Clear all' })).toBeNull();
  });
});
