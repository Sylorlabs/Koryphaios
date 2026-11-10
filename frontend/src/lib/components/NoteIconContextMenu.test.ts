import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import NoteIconContextMenu from './NoteIconContextMenu.svelte';

const mocks = vi.hoisted(() => ({ setNoteIcon: vi.fn() }));
vi.mock('$lib/stores/notes.svelte', () => ({ notesStore: { setNoteIcon: mocks.setNoteIcon } }));
vi.mock('$lib/stores/project.svelte', () => ({ projectStore: { currentPath: '/project' } }));
beforeEach(() => { mocks.setNoteIcon.mockReset(); mocks.setNoteIcon.mockResolvedValue(true); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('saves a built-in icon for the selected note and offers reset', async () => {
  const onclose = vi.fn();
  render(NoteIconContextMenu, { noteId: 'alpha', x: 10, y: 20, icon: { kind: 'builtin', value: '⭐' }, onclose });
  await fireEvent.click(screen.getByRole('menuitemradio', { name: 'Idea' }));
  expect(mocks.setNoteIcon).toHaveBeenCalledWith('alpha', { kind: 'builtin', value: '💡' });
  await waitFor(() => expect(onclose).toHaveBeenCalled());
  await fireEvent.click(screen.getByRole('menuitem', { name: 'Reset to default' }));
  expect(mocks.setNoteIcon).toHaveBeenLastCalledWith('alpha', null);
});

it('keeps a failed save visible and dismisses with Escape or outside click', async () => {
  const onclose = vi.fn();
  mocks.setNoteIcon.mockResolvedValue(false);
  render(NoteIconContextMenu, { noteId: 'alpha', x: 10000, y: 10000, onclose });
  await fireEvent.click(screen.getByRole('menuitemradio', { name: 'Task' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not save');
  expect(onclose).not.toHaveBeenCalled();
  await fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
  expect(onclose).toHaveBeenCalledTimes(1);
  await fireEvent.pointerDown(document.body);
  expect(onclose).toHaveBeenCalledTimes(2);
});

it('rejects unsupported upload types with useful feedback', async () => {
  render(NoteIconContextMenu, { noteId: 'alpha', x: 10, y: 20, onclose: vi.fn() });
  await fireEvent.change(screen.getByLabelText('Upload a note icon'), {
    target: { files: [new File(['hello'], 'text.txt', { type: 'text/plain' })] },
  });
  expect(await screen.findByRole('alert')).toHaveTextContent('Choose a PNG');
  expect(mocks.setNoteIcon).not.toHaveBeenCalled();
});

it('resizes a custom upload into a compact PNG before saving', async () => {
  const drawImage = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,aGVsbG8=');
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:icon-upload');
  const revoke = vi.spyOn(URL, 'revokeObjectURL');
  vi.stubGlobal('Image', class {
    src = '';
    naturalWidth = 400;
    naturalHeight = 200;
    decode = async () => {};
  });
  render(NoteIconContextMenu, { noteId: 'alpha', x: 10, y: 20, onclose: vi.fn() });
  await fireEvent.change(screen.getByLabelText('Upload a note icon'), {
    target: { files: [new File(['image'], 'icon.png', { type: 'image/png' })] },
  });
  await waitFor(() => expect(mocks.setNoteIcon).toHaveBeenCalledWith('alpha', {
    kind: 'image', value: 'data:image/png;base64,aGVsbG8=',
  }));
  expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 24, 96, 48);
  expect(revoke).toHaveBeenCalledWith('blob:icon-upload');
});
