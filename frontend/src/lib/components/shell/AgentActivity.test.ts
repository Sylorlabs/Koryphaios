import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import type { AgentStatus } from '@koryphaios/shared';

import AgentActivity from './AgentActivity.svelte';
import type { AgentRailState } from './useAgentRail.svelte';

function makeAgent(status: AgentStatus = 'thinking') {
  return {
    identity: {
      id: 'worker-1',
      name: 'General Worker',
      role: 'worker',
      domain: 'general',
      provider: 'openai',
      model: 'gpt-test',
      glowColor: 'var(--color-accent)',
    },
    status,
    content: '',
    thinking: '',
    toolCalls: [],
    task: 'Inspect the delegated task',
    tokensUsed: 0,
    contextMax: 0,
    contextKnown: false,
    sessionId: 'session-1',
  };
}

function makeRail() {
  return {
    sessionAgentChats: [makeAgent()],
    selectedAgentId: '',
    closingAgentIds: new Set<string>(),
    clearSelection: vi.fn(),
    selectAgent: vi.fn(),
    closeAgent: vi.fn(),
    closeAllAgents: vi.fn(),
  } as unknown as AgentRailState;
}

describe('AgentActivity', () => {
  it('shows a compact activity list on hover', async () => {
    render(AgentActivity, { props: { rail: makeRail() } });

    await fireEvent.pointerEnter(screen.getByRole('group', { name: 'Agent activity' }));

    expect(screen.getByText('General Worker')).toBeTruthy();
    expect(screen.getByText('thinking')).toBeTruthy();
    expect(screen.queryByText('Inspect the delegated task')).toBeNull();
  });

  it('opens the detailed activity menu when Activity is clicked', async () => {
    const rail = makeRail();
    render(AgentActivity, { props: { rail } });

    await fireEvent.click(screen.getByRole('button', { name: 'Activity' }));

    expect(screen.getByRole('region', { name: 'Activity details' })).toBeTruthy();
    expect(screen.getByText('Inspect the delegated task')).toBeTruthy();
    expect(screen.getByText('openai · gpt-test')).toBeTruthy();
  });

  it('shows per-agent dismiss controls and clears every agent from the preview', async () => {
    const rail = makeRail();
    render(AgentActivity, { props: { rail } });

    await fireEvent.pointerEnter(screen.getByRole('group', { name: 'Agent activity' }));

    expect(screen.getByRole('button', { name: 'Stop and close General Worker' })).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(rail.closeAllAgents).toHaveBeenCalledTimes(1);
  });
});
