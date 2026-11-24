import { render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import type { AgentIdentity } from '@koryphaios/shared';
import ToolActivity from './ToolActivity.svelte';
import type { FeedEntryLocal } from '$lib/types';
import { agentStore, noteAgentToolCall } from '$lib/stores/agents.svelte';

vi.mock('$lib/stores/sessions.svelte', () => ({ sessionStore: { activeSessionId: 'chat' } }));

function delegation(type: 'tool_call' | 'tool_result', agentId: string): FeedEntryLocal {
  return {
    id: `spawn-${agentId}-${type}`,
    type,
    timestamp: 1,
    agentId: 'kory-manager',
    agentName: 'Kory',
    glowClass: '',
    text: '',
    metadata: {
      sessionId: 'chat',
      toolCall: {
        id: `agent-spawn-${agentId}`,
        name: 'delegate_to_worker',
        input: { agentId, agentName: 'frontend' },
      },
      ...(type === 'tool_result'
        ? {
            toolResult: {
              callId: `agent-spawn-${agentId}`,
              name: 'delegate_to_worker',
              output: 'frontend done',
              isError: false,
              durationMs: 64_000,
            },
          }
        : {}),
    },
  } as FeedEntryLocal;
}

const worker = (id: string): AgentIdentity =>
  ({
    id,
    name: 'frontend',
    role: 'coder',
    provider: 'codex',
    model: 'gpt',
    domain: 'ui',
    glowColor: '',
  }) as AgentIdentity;

describe('delegation row', () => {
  it('follows the delegated agent: status and current tool while it works', () => {
    agentStore.spawnAgent('chat', worker('dw1'), 'Build charts');
    agentStore.updateAgentStatus('chat', 'dw1', 'tool_calling');
    noteAgentToolCall('chat', 'dw1', { id: 'c', name: 'bash', input: { command: 'bun test' } });
    render(ToolActivity, { entry: delegation('tool_call', 'dw1') });
    expect(screen.getByTestId('delegated-status').textContent).toBe(
      'Running tool: bash · bun test',
    );
  });

  it('says when the delegated agent is waiting on the user', () => {
    agentStore.spawnAgent('chat', worker('dw2'), 'Ask');
    agentStore.updateAgentStatus('chat', 'dw2', 'waiting_user');
    render(ToolActivity, { entry: delegation('tool_call', 'dw2') });
    const status = screen.getByTestId('delegated-status');
    expect(status.textContent).toBe('Waiting on you');
    expect(status.getAttribute('data-tone')).toBe('attention');
  });

  it('drops the live line once complete and shows the run duration instead', () => {
    agentStore.spawnAgent('chat', worker('dw3'), 'Done');
    agentStore.updateAgentStatus('chat', 'dw3', 'done');
    render(ToolActivity, { entry: delegation('tool_result', 'dw3') });
    expect(screen.queryByTestId('delegated-status')).toBeNull();
    expect(screen.getByText('1m 4s')).toBeTruthy();
  });
});
