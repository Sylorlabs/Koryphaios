import { fireEvent, render, screen } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage } from '@koryphaios/shared';
import { EXPAND_ANCHOR_EVENT } from '$lib/utils/expand-anchor';

const mocks = vi.hoisted(() => ({
  messages: [] as AgentMessage[],
  hydrate: vi.fn(),
  markRead: vi.fn(),
  decide: vi.fn(),
}));
vi.mock('$lib/stores/sessions.svelte', () => ({
  sessionStore: { activeSessionId: 'session-1' },
}));
vi.mock('$lib/stores/agent-messages.svelte', () => ({
  agentMessagesFor: () => mocks.messages,
  agentMessageUnreadCount: () => mocks.messages.length,
  hasPendingAgentApproval: () => mocks.messages.some((message) => message.status === 'pending_approval'),
  hydrateAgentMessages: mocks.hydrate,
  markAgentMessagesRead: mocks.markRead,
  decideAgentMessage: mocks.decide,
}));
import AgentMessages from './AgentMessages.svelte';

function message(): AgentMessage {
  return {
    id: 'message-1', threadId: 'thread-1', fromSessionId: 'session-2',
    fromAgentId: 'worker-1', fromRole: 'worker', fromLabel: 'Review',
    toSessionId: 'session-1', toRole: 'manager', toLabel: 'Kory',
    crossProject: false, isRelayRequest: false, subject: 'Check the change',
    body: 'Review request\n'.repeat(100), reply: 'I will review it.',
    status: 'pending_approval', createdAt: Date.now(),
  };
}

describe('AgentMessages transcript details', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.messages = [message()];
    mocks.decide.mockResolvedValue(undefined);
  });

  it('links its disclosure to a bounded, keyboard-scrollable history', async () => {
    const { container } = render(AgentMessages);
    const onAnchor = vi.fn();
    container.addEventListener(EXPAND_ANCHOR_EVENT, onAnchor);
    const toggle = screen.getByRole('button', { name: /Agent messages/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('agent-message-entry')).toBeNull();

    await fireEvent.click(toggle);
    const history = screen.getByRole('region', { name: 'Agent messages' });
    expect(toggle).toHaveAttribute('aria-controls', history.id);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(history).toHaveAttribute('tabindex', '0');
    expect(history).toHaveClass('max-h-80', 'overflow-y-auto');
    expect(history.textContent).toContain(mocks.messages[0].body);
    expect(screen.getByText(/I will review it/)).toBeTruthy();
    expect(mocks.markRead).toHaveBeenCalledWith('session-1');
    expect(onAnchor).toHaveBeenCalledTimes(1);

    await fireEvent.click(toggle);
    expect(screen.queryByRole('region', { name: 'Agent messages' })).toBeNull();
    expect(onAnchor).toHaveBeenCalledTimes(2);
  });

  it.each([['Approve', true], ['Decline', false]] as const)('preserves the %s action', async (name, approved) => {
    render(AgentMessages);
    await fireEvent.click(screen.getByRole('button', { name: /Agent messages/ }));
    await fireEvent.click(screen.getByRole('button', { name }));
    expect(mocks.decide).toHaveBeenCalledWith('message-1', approved);
  });

  it('uses a concise empty state', async () => {
    mocks.messages = [];
    render(AgentMessages);
    await fireEvent.click(screen.getByRole('button', { name: /Agent messages/ }));
    expect(screen.getByText('No messages yet.')).toBeTruthy();
  });
});
