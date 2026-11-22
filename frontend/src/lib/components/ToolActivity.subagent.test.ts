import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import type { SubagentTranscript, TranscriptPart } from '@koryphaios/shared';
import ToolActivity from './ToolActivity.svelte';
import type { FeedEntryLocal } from '$lib/types';
import { partsToFeedEntries } from '$lib/stores/transcript-turns';

vi.mock('$lib/stores/sessions.svelte', () => ({ sessionStore: { activeSessionId: 'chat' } }));

const innermost: SubagentTranscript = {
  name: 'summarizer',
  turns: [
    { role: 'user', text: 'Summarize the findings.', createdAt: Date.UTC(2026, 0, 1, 12, 0) },
    { role: 'assistant', parts: [{ kind: 'text', text: 'Innermost summary.', startedAt: 3 }] },
  ],
};

const explorer: SubagentTranscript = {
  agentId: 'agent-1',
  name: 'Explore',
  task: 'Find every caller of parseConfig.',
  model: 'claude-haiku',
  turns: [
    { role: 'user', text: 'Search the repo for parseConfig.', createdAt: Date.UTC(2026, 0, 1, 10, 50) },
    {
      role: 'assistant',
      parts: [
        { kind: 'reasoning', text: 'I should grep first.', startedAt: 1, endedAt: 1, timeUnknown: true },
        {
          kind: 'tool',
          callId: 'nested-grep',
          name: 'grep',
          input: { pattern: 'parseConfig' },
          startedAt: 1,
          endedAt: 1,
          output: 'src/a.ts',
          timeUnknown: true,
        },
        {
          kind: 'tool',
          callId: 'nested-task',
          name: 'Task',
          input: { description: 'summarize' },
          startedAt: 2,
          endedAt: 2,
          output: 'done',
          timeUnknown: true,
          subagent: innermost,
        },
        { kind: 'text', text: 'Found **one** caller.', startedAt: 2 },
      ],
    },
  ],
};

function taskRow(subagent: SubagentTranscript): FeedEntryLocal {
  const parts: TranscriptPart[] = [
    {
      kind: 'tool',
      callId: 'task-1',
      name: 'Task',
      input: { description: 'explore' },
      startedAt: 1,
      endedAt: 1,
      output: 'Explored.',
      timeUnknown: true,
      subagent,
    },
  ];
  return partsToFeedEntries({ sessionId: 'chat', messageId: 'm1', parts, agentName: 'Kory', glowClass: '' })[0];
}

describe('ToolActivity sub-agent transcript', () => {
  it('renders collapsed, then expands into nested turns, reasoning, tools and a nested sub-agent', async () => {
    const { container } = render(ToolActivity, { entry: taskRow(explorer) });

    const summary = screen.getByRole('button', { name: /Sub-agent · Explore · 2 turns · claude-haiku/ });
    expect(summary.getAttribute('aria-expanded')).toBe('false');
    expect(summary.getAttribute('aria-controls')).toBeNull();
    // Lazy: nothing nested is rendered while collapsed.
    expect(container.textContent).not.toContain('Search the repo for parseConfig.');
    expect(container.querySelector('.thinking-row')).toBeNull();

    await fireEvent.click(summary);
    expect(summary.getAttribute('aria-expanded')).toBe('true');
    const regionId = summary.getAttribute('aria-controls');
    expect(regionId).toBeTruthy();
    const region = screen.getByRole('region', { name: 'Explore sub-agent transcript' });
    expect(region.id).toBe(regionId);

    expect(region.textContent).toContain('Find every caller of parseConfig.');
    const turns = region.querySelectorAll(':scope > ol > li.turn');
    expect(turns).toHaveLength(2);
    expect(turns[0].getAttribute('data-role')).toBe('user');
    expect(turns[0].textContent).toContain('Search the repo for parseConfig.');
    expect(turns[0].textContent).not.toContain('Time unknown');
    // The assistant turn has no createdAt.
    expect(turns[1].querySelector('.turn-time')?.textContent).toBe('Time unknown');

    // Reasoning goes through ThinkingBlock with its unknown duration.
    const thinking = turns[1].querySelector('.thinking-row') as HTMLElement;
    expect(thinking.textContent).toContain('time unknown');
    expect(thinking.textContent).not.toContain('0.0s');
    // Text goes through the markdown renderer.
    expect(turns[1].querySelector('.markdown-content strong')?.textContent).toBe('one');
    // Tools go through the tool row, without a duration.
    expect(turns[1].querySelectorAll('.tool-summary').length).toBeGreaterThanOrEqual(2);
    expect(turns[1].querySelector('.tool-duration')).toBeNull();

    // A nested-nested sub-agent renders recursively, also lazily.
    const nested = within(region).getByRole('button', { name: /Sub-agent · summarizer · 2 turns/ });
    expect(region.textContent).not.toContain('Innermost summary.');
    await fireEvent.click(nested);
    const nestedRegion = screen.getByRole('region', { name: 'summarizer sub-agent transcript' });
    expect(nestedRegion.textContent).toContain('Summarize the findings.');
    expect(nestedRegion.textContent).toContain('Innermost summary.');

    await fireEvent.click(summary);
    expect(screen.queryByRole('region', { name: 'Explore sub-agent transcript' })).toBeNull();
  });

  it('reveals huge transcripts progressively', async () => {
    const turns = Array.from({ length: 120 }, (_, index) => ({
      role: 'user' as const,
      text: `turn ${index}`,
    }));
    render(ToolActivity, { entry: taskRow({ name: 'Bulk', turns }) });
    await fireEvent.click(screen.getByRole('button', { name: /Sub-agent · Bulk · 120 turns/ }));
    const region = screen.getByRole('region', { name: 'Bulk sub-agent transcript' });
    expect(region.querySelectorAll('li.turn')).toHaveLength(50);
    await fireEvent.click(within(region).getByRole('button', { name: /Show 50 more turns \(70 remaining\)/ }));
    expect(region.querySelectorAll('li.turn')).toHaveLength(100);
    await fireEvent.click(within(region).getByRole('button', { name: /Show 20 more turns/ }));
    expect(region.querySelectorAll('li.turn')).toHaveLength(120);
    expect(within(region).queryByRole('button', { name: /Show .* more/ })).toBeNull();
  });
});
