import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import type { AgentRole, AgentStatus } from '@koryphaios/shared';

import AgentRail from './AgentRail.svelte';
import type { AgentRailState } from './useAgentRail.svelte';

vi.mock('$lib/stores/agents.svelte', () => ({
  agentStore: { getAgentSteeringQueue: () => [], getAgentCurrentTool: () => undefined },
}));

function agent(id: string, status: AgentStatus, name: string) {
  return {
    identity: {
      id, name, role: 'worker' as AgentRole, domain: 'general' as const,
      provider: 'openai', model: 'gpt-test', glowColor: 'var(--color-accent)',
    },
    status, content: '', thinking: '', toolCalls: [], task: '',
    tokensUsed: 0, contextMax: 0, contextKnown: false, sessionId: 'session-1',
  };
}

function rail(chats: ReturnType<typeof agent>[], selectedAgentId = ''): AgentRailState {
  return {
    sessionAgentChats: chats,
    selectedAgentId,
    closingAgentIds: new Set<string>(),
    clearSelection: vi.fn(),
    selectAgent: vi.fn(),
    closeAgent: vi.fn(),
  } as unknown as AgentRailState;
}

describe('AgentRail segmented strip', () => {
  it('renders Main chat and one tab per active agent inside one tablist', () => {
    render(AgentRail, {
      props: {
        rail: rail([agent('w1', 'thinking', 'UI Worker'), agent('w2', 'streaming', 'API Worker')]),
        visible: false,
      },
    });
    const list = screen.getByRole('tablist');
    expect(list).toContainElement(screen.getByRole('tab', { name: 'Main chat' }));
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(3);
    // Continuous strip, not separate pills: one bordered container.
    expect(list.className).toContain('agent-strip');
    // No glow classes anywhere in the strip.
    expect(list.innerHTML).not.toContain('glow-');
  });

  it('marks the selected segment with aria-selected and the sliding highlight', () => {
    render(AgentRail, {
      props: { rail: rail([agent('w1', 'thinking', 'UI Worker')], 'w1'), visible: false },
    });
    expect(screen.getByTestId('agent-seg').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'Main chat' }).getAttribute('aria-selected')).toBe(
      'false',
    );
    expect(document.querySelector('.seg-highlight')).toBeTruthy();
  });

  it('moves focus with arrow keys and closes the focused agent on Delete', async () => {
    const state = rail([agent('w1', 'thinking', 'UI Worker')]);
    render(AgentRail, { props: { rail: state, visible: false } });
    const main = screen.getByRole('tab', { name: 'Main chat' });
    main.focus();
    await fireEvent.keyDown(main, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(screen.getByTestId('agent-seg'));
    await fireEvent.keyDown(document.activeElement!, { key: 'Delete' });
    expect(state.closeAgent).toHaveBeenCalledWith('w1');
    // Backspace on Main chat must not close anything.
    main.focus();
    await fireEvent.keyDown(main, { key: 'Backspace' });
    expect(state.closeAgent).toHaveBeenCalledTimes(1);
  });

  it('keeps dividers between Main chat and agent segments', () => {
    render(AgentRail, {
      props: { rail: rail([agent('w1', 'thinking', 'UI Worker')]), visible: false },
    });
    expect(document.querySelectorAll('.seg-divider').length).toBe(1);
  });

  it('keeps a failed worker in the strip until dismissed, and drops a finished one', () => {
    render(AgentRail, {
      props: {
        rail: rail([agent('w1', 'error', 'Broken Worker'), agent('w2', 'done', 'Finished Worker')]),
        visible: false,
      },
    });
    const list = screen.getByRole('tablist');
    expect(within(list).getByText('Broken Worker')).toBeTruthy();
    expect(within(list).queryByText('Finished Worker')).toBeNull();
  });

  it('jumps to the first and last tab with Home and End', async () => {
    render(AgentRail, {
      props: {
        rail: rail([agent('w1', 'thinking', 'One'), agent('w2', 'thinking', 'Two')]),
        visible: false,
      },
    });
    const main = screen.getByRole('tab', { name: 'Main chat' });
    main.focus();
    await fireEvent.keyDown(main, { key: 'End' });
    expect(document.activeElement?.getAttribute('data-seg-id')).toBe('w2');
    await fireEvent.keyDown(document.activeElement!, { key: 'Home' });
    expect(document.activeElement).toBe(main);
  });

  it('keeps each divider inside its segment so it leaves with it', () => {
    render(AgentRail, {
      props: { rail: rail([agent('w1', 'thinking', 'UI Worker'), agent('w2', 'thinking', 'API')]), visible: false },
    });
    for (const divider of document.querySelectorAll('.seg-divider')) {
      expect(divider.nextElementSibling?.classList.contains('agent-seg')).toBe(true);
    }
  });
});
