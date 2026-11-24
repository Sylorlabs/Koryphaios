import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({
  processes: [] as Array<Record<string, unknown>>,
  isLoading: false,
  loadSessionProcesses: vi.fn(async () => {}),
  loadProcessLogs: vi.fn(async () => ({ stdout: 'ready on :5173', stderr: '' })),
  writeInput: vi.fn(async () => true),
  killProcess: vi.fn(),
}));
vi.mock('$lib/stores/processes.svelte', () => ({ processStore: store }));
vi.mock('@koryphaios/shared', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isAgentBackgroundProcess: () => true,
}));

import BackgroundShells from './BackgroundShells.svelte';

describe('BackgroundShells', () => {
  it('renders nothing without running shells', () => {
    store.processes = [];
    const { container } = render(BackgroundShells, { props: { sessionId: 's' } });
    expect(container.querySelector('section')).toBeNull();
  });

  it('lists shells as rows with a status in words and a sentence-case heading', async () => {
    store.processes = [
      { id: 'p1', sessionId: 's', name: 'dev server', command: 'bun run dev', status: 'running' },
      { id: 'p2', sessionId: 's', name: 'watcher', command: 'tsc -w', status: 'starting' },
    ];
    render(BackgroundShells, { props: { sessionId: 's' } });
    expect(screen.getByRole('heading', { name: 'Background shells' })).toBeTruthy();
    expect(screen.getByText('Running')).toBeTruthy();
    expect(screen.getByText('Starting')).toBeTruthy();

    const toggle = screen.getAllByRole('button', { expanded: false })[0];
    await fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(await screen.findByText('ready on :5173')).toBeTruthy();

    await fireEvent.click(screen.getByRole('button', { name: 'Stop dev server' }));
    expect(store.killProcess).toHaveBeenCalledWith('p1');
  });
});
