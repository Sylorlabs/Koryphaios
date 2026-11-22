import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import ToolActivity from './ToolActivity.svelte';
import type { FeedEntryLocal } from '$lib/types';
import { partsToFeedEntries } from '$lib/stores/transcript-turns';

vi.mock('$lib/stores/sessions.svelte', () => ({ sessionStore: { activeSessionId: 'chat' } }));

function bashRow(timeUnknown: boolean, durationMs?: number): FeedEntryLocal {
  const [row] = partsToFeedEntries({
    sessionId: 'chat',
    messageId: 'm1',
    agentName: 'Kory',
    glowClass: '',
    parts: [
      {
        kind: 'tool',
        callId: 'call-1',
        name: 'bash',
        input: { command: 'ls' },
        startedAt: 1_000,
        endedAt: 1_000,
        output: 'a.ts',
        ...(durationMs !== undefined ? { durationMs } : {}),
        ...(timeUnknown ? { timeUnknown: true as const } : {}),
      },
    ],
  });
  return row;
}

describe('ToolActivity with an unknown duration', () => {
  it('shows a recorded duration', () => {
    const { container } = render(ToolActivity, { entry: bashRow(false, 1_500) });
    expect(container.querySelector('.tool-duration')?.textContent).toBe('1.5 s');
  });

  it('hides the duration and never renders 0 ms when the source recorded none', async () => {
    const row = bashRow(true);
    expect(row.durationUnknown).toBe(true);
    expect((row.metadata?.toolResult as { durationMs?: number }).durationMs).toBeUndefined();

    const { container } = render(ToolActivity, { entry: row });
    expect(container.querySelector('.tool-duration')).toBeNull();
    expect(container.textContent).not.toMatch(/\b0 ms\b|0\.0 ?s/);

    await fireEvent.click(container.querySelector('.tool-summary') as HTMLElement);
    const details = screen.getByRole('region', { name: 'Tool details' });
    expect(details.textContent).toContain('time unknown');
    expect(details.textContent).not.toMatch(/\b0 ms\b/);
  });

  it('does not tick a live clock for an unfinished call with no recorded time', () => {
    const entry: FeedEntryLocal = {
      id: 'call',
      type: 'tool_call',
      timestamp: Date.now() - 60_000,
      agentId: 'kory-manager',
      agentName: 'Kory',
      glowClass: '',
      text: 'Calling tool: bash',
      durationUnknown: true,
      metadata: { toolCall: { id: 'call', name: 'bash', input: { command: 'ls' } } },
    };
    const { container } = render(ToolActivity, { entry });
    expect(container.querySelector('.tool-duration')).toBeNull();
  });
});
