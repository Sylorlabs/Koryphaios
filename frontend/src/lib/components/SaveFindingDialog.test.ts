import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ createChatFinding: vi.fn() }));
vi.mock('$lib/stores/notes.svelte', () => ({
  notesStore: { createChatFinding: mocks.createChatFinding, error: '' },
}));

import SaveFindingDialog from './SaveFindingDialog.svelte';

const finding = {
  title: 'Cache key includes the locale',
  body: 'The chat established the cache key includes the locale.',
  source: {
    sessionId: 'session-42',
    messageId: 'msg-7',
    role: 'assistant',
    provider: 'test-provider',
    model: 'test-model',
  },
};

afterEach(() => {
  cleanup();
  mocks.createChatFinding.mockReset();
});

describe('SaveFindingDialog', () => {
  it('saves the reviewed finding with its source provenance', async () => {
    mocks.createChatFinding.mockResolvedValue({
      id: 'note-9',
      title: 'Cache key includes the locale',
      folderPath: '/Findings',
    });
    render(SaveFindingDialog, { props: { finding, onClose: vi.fn() } });

    const title = screen.getByLabelText('Title') as HTMLInputElement;
    const body = screen.getByLabelText('Finding') as HTMLTextAreaElement;
    expect(title.value).toBe('Cache key includes the locale');
    expect(body.value).toContain('cache key includes the locale');

    await fireEvent.input(title, { target: { value: '  Locale-aware cache keys  ' } });
    await fireEvent.click(screen.getByRole('button', { name: /Save as sourced note/ }));
    await waitFor(() => expect(mocks.createChatFinding).toHaveBeenCalledTimes(1));
    expect(mocks.createChatFinding).toHaveBeenCalledWith({
      title: 'Locale-aware cache keys',
      body: 'The chat established the cache key includes the locale.',
      source: finding.source,
    });
  });

  it('offers opening the saved note and dispatches the workspace open event', async () => {
    mocks.createChatFinding.mockResolvedValue({
      id: 'note-9',
      title: 'Saved finding',
      folderPath: '/Findings',
    });
    const onClose = vi.fn();
    const dispatched = vi.fn();
    window.addEventListener('open-note', dispatched);
    render(SaveFindingDialog, { props: { finding, onClose } });

    await fireEvent.click(screen.getByRole('button', { name: /Save as sourced note/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open in Notes' })).toBeTruthy());
    await fireEvent.click(screen.getByRole('button', { name: 'Open in Notes' }));
    expect(dispatched).toHaveBeenCalled();
    const detail = (dispatched.mock.calls[0]![0] as CustomEvent).detail;
    expect(detail).toEqual({ title: 'Saved finding' });
    expect(onClose).toHaveBeenCalled();
    window.removeEventListener('open-note', dispatched);
  });

  it('keeps saving disabled until title and body are non-empty and reports failures', async () => {
    mocks.createChatFinding.mockResolvedValue(null);
    render(SaveFindingDialog, {
      props: {
        finding: { ...finding, title: '   ', body: '   ' },
        onClose: vi.fn(),
      },
    });
    const save = screen.getByRole('button', { name: /Save as sourced note/ });
    expect(save.hasAttribute('disabled')).toBe(true);

    await fireEvent.input(screen.getByLabelText('Title'), { target: { value: 'T' } });
    await fireEvent.input(screen.getByLabelText('Finding'), { target: { value: 'B' } });
    expect(save.hasAttribute('disabled')).toBe(false);
    await fireEvent.click(save);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/Failed to save/));
    expect(mocks.createChatFinding).toHaveBeenCalledTimes(1);
  });
});
