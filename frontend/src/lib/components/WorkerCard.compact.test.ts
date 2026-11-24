import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import type { AgentIdentity, AgentStatus } from '@koryphaios/shared';

import WorkerCard from './WorkerCard.svelte';

vi.mock('$lib/stores/agents.svelte', () => ({
  agentStore: { getAgentSteeringQueue: () => [], getAgentCurrentTool: () => undefined },
}));

function agent(overrides: Record<string, unknown> = {}) {
  return {
    identity: {
      id: 'worker-1',
      name: 'Critic',
      role: 'worker',
      domain: 'critic',
      provider: 'commandcode',
      model: 'xiaomi/mimo-v2.6-pro',
    } as unknown as AgentIdentity,
    status: 'thinking' as AgentStatus,
    content: '',
    thinking: '',
    toolCalls: [{ name: 'grep', status: 'ok' }],
    task: 'Review delegated work',
    tokensUsed: 42_000,
    contextMax: 200_000,
    contextKnown: true,
    ...overrides,
  };
}

function card(state: ReturnType<typeof agent>, selected = false) {
  return render(WorkerCard, {
    props: { agent: state, status: state.status, selected, onSelect: vi.fn() },
  });
}

describe('sub-agent cards are a single compact row', () => {
  it('shows only the agent name, a status icon and the close control', () => {
    const { container } = card(agent());

    // A worker card is a glanceable chip, not a panel: the rail budget goes to
    // how many agents are live, not to restating each one's whole transcript.
    expect(container.textContent?.trim()).toBe('Critic');
    expect(container.querySelector('.seg-icon')).not.toBeNull();
    expect(container.querySelectorAll('button')).toHaveLength(1);
  });

  it('is one fixed-height row rather than a stacked card', () => {
    const { container } = card(agent());
    const root = container.querySelector('.agent-seg')!;

    expect(root.getAttribute('role')).toBe('tab');
    expect(root.querySelectorAll('.seg-name')).toHaveLength(1);
    expect(root.querySelector('.agent-card')).toBeNull();
  });

  it('does not render provider, task, context percentage or tool chips inline', () => {
    const { container } = card(agent({ toolCalls: [{ name: 'bash' }, { name: 'grep' }] }));

    expect(container.textContent).not.toContain('Commandcode');
    expect(container.textContent).not.toContain('xiaomi/mimo-v2.6-pro');
    expect(container.textContent).not.toContain('Review delegated work');
    expect(container.textContent).not.toContain('21%');
    expect(container.textContent).not.toContain('grep');
    expect(container.textContent).not.toContain('bash');
    expect(container.textContent).not.toContain('Open transcript & steer');
  });

  it('keeps only provider, model and context in the tooltip', () => {
    const { container } = card(agent());
    const details = container.querySelector('.agent-seg')!.getAttribute('title')!;

    // The hover card answers "which model is this, and how full is it".
    // Anything more turns every pass of the rail into a paragraph of text.
    expect(details).toBe('Commandcode xiaomi/mimo-v2.6-pro\nContext 21%');
  });

  it('keeps the status, task and steering hint out of the tooltip', () => {
    const { container } = card(agent({ toolCalls: [{ name: 'bash' }, { name: 'grep' }] }), true);
    const details = container.querySelector('.agent-seg')!.getAttribute('title')!;

    expect(details).not.toContain('Thinking…');
    expect(details).not.toContain('Review delegated work');
    expect(details).not.toContain('Transcript open');
    expect(details).not.toContain('grep');
    expect(details).not.toContain('bash');
  });

  it('drops the context line when the provider has no trusted window', () => {
    const { container } = card(agent({ contextKnown: false, contextMax: 0, tokensUsed: 0 }));
    const details = container.querySelector('.agent-seg')!.getAttribute('title')!;

    expect(details).toBe('Commandcode xiaomi/mimo-v2.6-pro');
  });

  it('closes via the X without also selecting the card', async () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const state = agent();
    render(WorkerCard, { props: { agent: state, status: state.status, onSelect, onClose } });

    await fireEvent.click(screen.getByRole('button', { name: /Stop and close Critic/ }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('labels the control Close, not Stop, once the agent is terminal', () => {
    card(agent({ status: 'done' }));

    expect(screen.getByRole('button', { name: 'Close Critic' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Stop and close/ })).toBeNull();
  });

  it('is announced by name and status, while the model stays in the tooltip', () => {
    const { container } = card(agent());
    const tab = container.querySelector('.agent-seg')!;

    // The accessible name used to be the provider/model tooltip, so a screen
    // reader heard "Commandcode xiaomi/…" and never the agent's name.
    expect(tab.getAttribute('aria-label')).toBe('Critic, Thinking');
    expect(tab.getAttribute('aria-label')).not.toContain('xiaomi');
    expect(tab.getAttribute('data-status')).toBe('thinking');
  });

  it('says Stopped, not Done, for a worker the user cancelled', () => {
    const { container } = card(agent({ status: 'done', stopReason: 'cancelled' }));
    expect(container.querySelector('.agent-seg')!.getAttribute('aria-label')).toBe('Critic, Stopped');
  });
});
