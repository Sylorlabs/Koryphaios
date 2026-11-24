import { render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import type { AgentIdentity, AgentStatus } from '@koryphaios/shared';

const tool = vi.hoisted(() => ({ current: undefined as undefined | { name: string; input?: Record<string, unknown> } }));
vi.mock('$lib/stores/agents.svelte', () => ({
  agentStore: {
    getAgentSteeringQueue: () => [],
    loadAgentSteeringQueue: async () => {},
    getAgentCurrentTool: () => tool.current,
    applySessionFeedVisibility: vi.fn(),
    setAgentSteeringQueue: vi.fn(),
  },
}));
vi.mock('$lib/stores/websocket.svelte', () => ({ wsStore: { isLoadingSession: false } }));
vi.mock('$lib/stores/feed.svelte', () => ({ feedStore: { deleteEntry: vi.fn() } }));
vi.mock('$lib/stores/sessions.svelte', () => ({ sessionStore: { activeSessionId: 's' } }));
vi.mock('$lib/stores/toast.svelte', () => ({ toastStore: { error: vi.fn() } }));
vi.mock('$lib/api.svelte', () => ({ apiFetch: vi.fn(), parseJsonResponse: vi.fn() }));

import AgentThreadFeed from './AgentThreadFeed.svelte';

function agent(status: AgentStatus, extra: Record<string, unknown> = {}) {
  return {
    identity: { id: 'w', name: 'frontend', role: 'coder', provider: 'codex', model: 'gpt-5.6-sol', domain: 'ui', glowColor: '' } as AgentIdentity,
    status,
    sessionId: 's',
    ...extra,
  };
}

describe('AgentThreadFeed header and empty state', () => {
  it('says the status in words with the current tool, beside the glyph', () => {
    tool.current = { name: 'bash', input: { command: 'bun run test' } };
    render(AgentThreadFeed, { props: { agent: agent('tool_calling'), feed: [], onClose: vi.fn() } });
    expect(screen.getByTestId('agent-thread-status').textContent).toMatch(/Running tool\s*·\s*bash · bun run test/);
    expect(screen.getByText('Codex CLI · gpt-5.6-sol · ui')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Stop worker/ })).toBeTruthy();
    tool.current = undefined;
  });

  it('shows a frozen duration and a Close control once finished', () => {
    render(AgentThreadFeed, {
      props: { agent: agent('done', { startedAt: 0, endedAt: 65_000 }), feed: [], onClose: vi.fn() },
    });
    expect(screen.getByTestId('agent-thread-status').textContent).toMatch(/Done\s*·\s*1m 05s/);
    expect(screen.getByRole('button', { name: /Close worker/ })).toBeTruthy();
  });

  it('uses a one-line empty state that offers the next step, not a hero card', () => {
    render(AgentThreadFeed, { props: { agent: agent('error'), feed: [] } });
    const empty = screen.getByTestId('agent-thread-empty');
    expect(empty.tagName).toBe('P');
    expect(empty.textContent).toMatch(/stopped with an error before writing anything/);
  });
});
