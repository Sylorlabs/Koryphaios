import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import { providerExecutionCapabilities, showsExecutionModeSelector } from '@koryphaios/shared';
import ProviderExecutionModes from './ProviderExecutionModes.svelte';

describe('Provider execution location controls', () => {
  it.each(['claude', 'codex', 'cursor', 'devin', 'freebuff', 'local', 'ollama'])(
    'hides the selector for the local-only %s adapter',
    (name) => {
      const { container } = render(ProviderExecutionModes, {
        capabilities: providerExecutionCapabilities(name, 'local'),
      });
      expect(screen.queryByTestId('provider-execution-modes')).toBeNull();
      expect(container.querySelector('select')).toBeNull();
    },
  );
  it('does not confuse remote inference with cloud workspace execution', () => {
    const caps = providerExecutionCapabilities('openai', 'api');
    expect(caps.defaultMode).toBe('local');
    expect(showsExecutionModeSelector(caps)).toBe(false);
    expect(showsExecutionModeSelector()).toBe(false);
  });
  it('does not offer a selector for cloud-only Jules', () => {
    render(ProviderExecutionModes, {
      capabilities: providerExecutionCapabilities('jules', 'cloud'),
    });
    expect(screen.queryByTestId('provider-execution-modes')).toBeNull();
  });
  it('shows both-mode capability but never enables unsupported Hoplite execution', () => {
    render(ProviderExecutionModes, {
      capabilities: providerExecutionCapabilities('hoplite', 'hybrid'),
    });
    expect(screen.getByTestId('provider-execution-modes')).toBeVisible();
    expect(screen.getByRole('combobox', { name: 'Execution location' })).toBeDisabled();
    expect(screen.getByText(/live delegation is not implemented/)).toBeVisible();
  });
  it('offers local/cloud choices only when an integrated caller supplies capability and routing', async () => {
    const onchange = vi.fn();
    render(ProviderExecutionModes, {
      capabilities: {
        modes: [
          { id: 'local', available: true },
          { id: 'cloud', available: true },
        ],
        defaultMode: 'local',
      },
      onchange,
    });
    await fireEvent.click(screen.getByRole('combobox', { name: 'Execution location' }));
    await fireEvent.click(screen.getByRole('option', { name: /Cloud/ }));
    expect(onchange).toHaveBeenCalledWith('cloud');
  });
});
