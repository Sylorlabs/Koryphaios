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

  it('marks a failure with a shaped badge, not only a colour, and keeps the tool glyph', () => {
    currentTool.mockReturnValue(undefined);
    const { container } = renderCard('error');
    // The glyph stays the transcript icon; the failure is an extra "!" badge.
    expect(container.querySelector('[data-tool-icon="command"]')).toBeTruthy();
    const badge = container.querySelector('.seg-badge');
    expect(badge?.getAttribute('data-badge')).toBe('error');
    expect(badge?.textContent?.trim()).toBe('!');
    // ...and the tab announces it in words.
    expect(screen.getByRole('tab').getAttribute('aria-label')).toBe('UI Worker, Failed');
  });

  it('dims a finished segment without adding a badge', () => {
    currentTool.mockReturnValue(undefined);
    const { container } = renderCard('done');
    expect(container.querySelector('.seg-icon.seg-done')).toBeTruthy();
    expect(container.querySelector('.seg-badge')).toBeNull();
  });

  it('gives waiting on the user its own "?" badge and holds the glyph still', () => {
    currentTool.mockReturnValue({ name: 'bash', input: { command: 'ls' } });
    const { container } = renderCard('waiting_user');
    const badge = container.querySelector('.seg-badge');
    expect(badge?.getAttribute('data-badge')).toBe('attention');
    expect(badge?.textContent?.trim()).toBe('?');
    // A parked worker is not running: its icon must not animate as busy.
    expect(container.querySelector('[data-tool-icon]')!.getAttribute('data-tool-state')).toBe('completed');
    expect(screen.getByRole('tab').getAttribute('aria-label')).toBe('UI Worker, Waiting on you');
  });

  it('names the current tool and its argument in the accessible name while running', () => {
    currentTool.mockReturnValue({ name: 'bash', input: { command: 'bun run test --reporter=dot' } });
    renderCard('tool_calling');
    expect(screen.getByRole('tab').getAttribute('aria-label')).toBe(
      'UI Worker, Running tool: bash · bun run test --reporter=dot',
    );
  });

  it('keeps the segment geometry stable across status changes', async () => {
    currentTool.mockReturnValue(undefined);
    const { container, rerender } = renderCard('thinking');
    const seg = container.querySelector('.agent-seg')!;
    const before = [...seg.children].map((child) => child.className.split(' ')[0]);
    await rerender({ agent: agent('error'), status: 'error', selected: false, onSelect: vi.fn(), onClose: vi.fn() });
    const after = [...seg.children].map((child) => child.className.split(' ')[0]);
    // Same row of children: the badge lives inside the icon slot, absolutely
    // positioned, so the name and close control never shift.
    expect(after).toEqual(before);
    expect(seg.querySelector('.seg-icon .seg-badge')).toBeTruthy();
  });
});
