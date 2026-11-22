import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import type { AgentStatus } from '@koryphaios/shared';

import AgentRail from './AgentRail.svelte';
import type { AgentRailState } from './useAgentRail.svelte';

vi.mock('$lib/stores/agents.svelte', () => ({
  agentStore: { getAgentSteeringQueue: () => [], getAgentCurrentTool: () => undefined },
}));

function agent(
  id: string,
  status: AgentStatus,
  name: string,
  role: 'worker' | 'critic' = 'worker',
) {
  return {
    identity: {
      id,
      name,
      role,
      domain: role === 'critic' ? 'critic' : 'general',
      provider: 'openai',
      model: 'gpt-test',
      glowColor: 'var(--color-accent)',
    },
    status,
    content: '',
    thinking: '',
    toolCalls: [],
    task: '',
    tokensUsed: 0,
    contextMax: 0,
    contextKnown: false,
    sessionId: 'session-1',
  };
}

function rail(sessionAgentChats: ReturnType<typeof agent>[]): AgentRailState {
  const closeAgent = vi.fn();
  return {
    sessionAgentChats,
    selectedAgentId: '',
    closingAgentIds: new Set<string>(),
    clearSelection: vi.fn(),
    selectAgent: vi.fn(),
    closeAgent,
  } as unknown as AgentRailState;
}

describe('AgentRail active worker tabs', () => {
  it('shows a live sub-agent in the top row without opening Activity details', () => {
    render(AgentRail, {
      props: { rail: rail([agent('worker-1', 'thinking', 'General Worker')]), visible: false },
    });

    const tabs = screen.getByTestId('active-agent-tabs');
    expect(tabs).toContainElement(screen.getByText('General Worker'));
    expect(screen.getByRole('button', { name: 'Stop and close General Worker' })).toBeTruthy();
  });

  it('keeps completed workers in Activity details while removing them from the active tab row', () => {
    render(AgentRail, {
      props: {
        rail: rail([agent('worker-1', 'done', 'Finished Worker')]),
        visible: true,
      },
    });

    expect(screen.getByTestId('active-agent-tabs')).not.toContainElement(
      screen.getByText('Finished Worker'),
    );
    expect(screen.getByLabelText('Activity details')).toContainElement(
      screen.getByText('Finished Worker'),
    );
  });

  it('lets the user close a live worker from its top-row tab', async () => {
    const state = rail([agent('worker-1', 'streaming', 'Streaming Worker')]);
    render(AgentRail, { props: { rail: state, visible: false } });

    await fireEvent.click(screen.getByRole('button', { name: 'Stop and close Streaming Worker' }));

    expect(state.closeAgent).toHaveBeenCalledWith('worker-1');
  });

  it('keeps a live Critic visible above the chat and exposes its completed card in Activity', async () => {
    const state = rail([agent('critic-1', 'thinking', 'Critic', 'critic')]);
    const { rerender } = render(AgentRail, { props: { rail: state, visible: false } });

    expect(screen.getByTestId('active-agent-tabs')).toContainElement(screen.getByText('Critic'));

    state.sessionAgentChats[0].status = 'done';
    await rerender({ rail: state, visible: true });

    expect(screen.getByTestId('active-agent-tabs')).not.toContainElement(
      screen.getByText('Critic'),
    );
    expect(screen.getByLabelText('Activity details')).toContainElement(screen.getByText('Critic'));
  });
});
