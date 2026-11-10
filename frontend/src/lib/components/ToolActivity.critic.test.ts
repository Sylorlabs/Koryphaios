import { fireEvent, render, screen } from '@testing-library/svelte';
import { expect, it, vi } from 'vitest';
import ToolActivity from './ToolActivity.svelte';
import type { FeedEntryLocal } from '$lib/types';
import { OPEN_AGENT_THREAD_EVENT } from '$lib/utils/agent-thread-navigation';

vi.mock('$lib/stores/sessions.svelte', () => ({ sessionStore: { activeSessionId: 'chat' } }));

it('opens the running Critic evaluation instead of a generic tool output panel', async () => {
  const navigate = vi.fn();
  window.addEventListener(OPEN_AGENT_THREAD_EVENT, navigate);
  try {
    render(ToolActivity, {
      entry: {
        id: 'review',
        type: 'tool_call',
        timestamp: 1,
        agentId: 'kory-manager',
        agentName: 'Kory',
        glowClass: '',
        text: '',
        metadata: {
          toolCall: { id: 'review', name: 'critic_review', input: { agentId: 'critic-1' } },
        },
      } as FeedEntryLocal,
    });
    await fireEvent.click(screen.getByRole('button', { name: /Critic running.*View evaluation/ }));
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate.mock.calls[0][0].detail).toEqual({ sessionId: 'chat', agentId: 'critic-1' });
    expect(screen.queryByRole('region', { name: 'Tool details' })).toBeNull();
  } finally {
    window.removeEventListener(OPEN_AGENT_THREAD_EVENT, navigate);
  }
});

it('keeps a completed Critic evaluation as a clickable chat link', async () => {
  const navigate = vi.fn();
  window.addEventListener(OPEN_AGENT_THREAD_EVENT, navigate);
  try {
    render(ToolActivity, {
      entry: {
        id: 'review-complete',
        type: 'tool_result',
        timestamp: 1,
        agentId: 'kory-manager',
        agentName: 'Kory',
        glowClass: '',
        text: '{"verdict":"PASS"}',
        metadata: {
          toolCall: {
            id: 'review-complete',
            name: 'critic_review',
            input: { agentId: 'critic-1' },
          },
          toolResult: {
            callId: 'review-complete',
            name: 'critic_review',
            output: 'PASS',
            isError: false,
            criticOutcome: 'passed',
          },
        },
      } as FeedEntryLocal,
    });

    const link = screen.getByRole('button', { name: /Critic passed.*View evaluation/ });
    expect(link).toBeTruthy();
    await fireEvent.click(link);
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: { sessionId: 'chat', agentId: 'critic-1' },
      }),
    );
  } finally {
    window.removeEventListener(OPEN_AGENT_THREAD_EVENT, navigate);
  }
});

it('distinguishes a Critic run that produced partial output before failing', () => {
  render(ToolActivity, {
    entry: {
      id: 'review-partial',
      type: 'tool_result',
      timestamp: 1,
      agentId: 'kory-manager',
      agentName: 'Kory',
      glowClass: '',
      text: 'partial critic output',
      metadata: {
        toolCall: {
          id: 'review-partial',
          name: 'critic_review',
          input: { agentId: 'critic-1' },
        },
        toolResult: {
          callId: 'review-partial',
          name: 'critic_review',
          output: 'Critic ran and produced partial output before the execution error.',
          isError: true,
          criticOutcome: 'run_failed_after_output',
        },
      },
    } as FeedEntryLocal,
  });

  expect(screen.getByRole('button', { name: /Critic failed after partial output.*View evaluation/ })).toBeTruthy();
});
