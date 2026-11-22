import { render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import type { AgentRole, AgentStatus } from '@koryphaios/shared';

import WorkerCard from './WorkerCard.svelte';

const currentTool = vi.fn();
vi.mock('$lib/stores/agents.svelte', () => ({
  agentStore: {
    getAgentSteeringQueue: () => [],
    getAgentCurrentTool: (...args: unknown[]) => currentTool(...args),
  },
}));

function agent(status: AgentStatus) {
  return {
    identity: {
      id: 'w1', name: 'UI Worker', role: 'worker' as AgentRole, domain: 'ui' as const,
      provider: 'openai', model: 'gpt-test', glowColor: 'var(--color-accent)',
    },
    status, content: '', thinking: '', toolCalls: [], task: '',
    tokensUsed: 0, contextMax: 0, contextKnown: false, sessionId: 'session-1',
  };
}

function renderCard(status: AgentStatus) {
  return render(WorkerCard, {
    props: { agent: agent(status), status, selected: false, onSelect: vi.fn(), onClose: vi.fn() },
  });
}

describe('WorkerCard live tool icon', () => {
  it('renders the transcript Command glyph in green for an in-flight bash call', () => {
    currentTool.mockReturnValue({ name: 'bash', input: { command: 'ls' } });
    renderCard('tool_calling');
    const icon = document.querySelector('[data-tool-icon="command"]');
    expect(icon).toBeTruthy();
    expect((icon as HTMLElement).style.color).toBe('#34d399');
    expect(icon!.getAttribute('data-tool-state')).toBe('running');
  });

  it('switches glyph with the current tool (search for grep)', () => {
    currentTool.mockReturnValue({ name: 'grep', input: { pattern: 'x' } });
    renderCard('tool_calling');
    expect(document.querySelector('[data-tool-icon="search"]')).toBeTruthy();
  });

  it('falls back to the green Command glyph when nothing is in flight', () => {
    currentTool.mockReturnValue(undefined);
    renderCard('thinking');
    expect(document.querySelector('[data-tool-icon="command"]')).toBeTruthy();
  });

  it('shows the error dot and the done-opacity state without changing the icon', () => {
    currentTool.mockReturnValue(undefined);
    renderCard('error');
    expect(document.querySelector('.seg-err-dot')).toBeTruthy();
    const { container } = renderCard('done');
    expect(container.querySelector('.seg-icon.seg-done')).toBeTruthy();
  });
});
