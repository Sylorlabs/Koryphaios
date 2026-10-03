import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { EXPAND_ANCHOR_EVENT } from '$lib/utils/expand-anchor';

const mocks = vi.hoisted(() => ({ copyText: vi.fn() }));
vi.mock('$lib/utils/clipboard', () => ({ copyText: mocks.copyText }));
import ToolOutputPanel from './ToolOutputPanel.svelte';

describe('ToolOutputPanel', () => {
  beforeEach(() => {
    mocks.copyText.mockReset();
    mocks.copyText.mockResolvedValue(undefined);
  });

  it('copies full output through the shared clipboard and anchors collapse', async () => {
    const content = 'full log\n'.repeat(100);
    const { container } = render(ToolOutputPanel, {
      props: { open: true, content, command: 'bun test' },
    });
    const onAnchor = vi.fn();
    container.addEventListener(EXPAND_ANCHOR_EVENT, onAnchor);
    expect(container.querySelector('pre')).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('region', { name: 'Command' })).toHaveAttribute('tabindex', '0');
    await fireEvent.click(screen.getByRole('button', { name: 'Copy output' }));
    expect(mocks.copyText).toHaveBeenCalledWith(content);
    expect(screen.getByRole('button', { name: 'Copied output' })).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: 'Collapse tool output' }));
    expect(onAnchor).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Tool output' })).toBeNull());
  });

  it('does not render when closed or offer copy for empty content', async () => {
    const { rerender } = render(ToolOutputPanel, { props: { open: false } });
    expect(screen.queryByRole('region', { name: 'Tool output' })).toBeNull();
    await rerender({ open: true });
    expect(screen.queryByRole('button', { name: 'Copy output' })).toBeNull();
  });

  it('bounds command and log surfaces without nesting filled cards', () => {
    const source = readFileSync('src/lib/components/ToolOutputPanel.svelte', 'utf8');
    expect(source).toMatch(/max-height: 20rem;/);
    expect(source).toMatch(/overflow: auto;/);
    expect(source).not.toContain('background: var(--color-surface-1)');
  });
});
