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

it('saves a free emoji after a live preview and the Use button', async () => {
  const onclose = vi.fn();
  render(NoteIconContextMenu, { noteId: 'alpha', x: 10, y: 20, onclose });
  const input = screen.getByLabelText('Any emoji');
  await fireEvent.input(input, { target: { value: '👩🏽‍💻' } });
  expect(screen.getByText('👩🏽‍💻', { selector: '.emoji-preview' })).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
  await fireEvent.click(screen.getByRole('button', { name: 'Use' }));
  expect(mocks.setNoteIcon).toHaveBeenCalledWith('alpha', { kind: 'emoji', value: '👩🏽‍💻' });
  await waitFor(() => expect(onclose).toHaveBeenCalled());
});

it('accepts flags and heart variation sequences from the keyboard', async () => {
  render(NoteIconContextMenu, { noteId: 'alpha', x: 10, y: 20, onclose: vi.fn() });
  const input = screen.getByLabelText('Any emoji');
  await fireEvent.input(input, { target: { value: '🇯🇵' } });
  await fireEvent.keyDown(input, { key: 'Enter' });
  expect(mocks.setNoteIcon).toHaveBeenLastCalledWith('alpha', { kind: 'emoji', value: '🇯🇵' });
  await fireEvent.input(input, { target: { value: '❤️' } });
  await fireEvent.keyDown(input, { key: 'Enter' });
  expect(mocks.setNoteIcon).toHaveBeenLastCalledWith('alpha', { kind: 'emoji', value: '❤️' });
});

it('shows invalid free input inline and never saves it', async () => {
  render(NoteIconContextMenu, { noteId: 'alpha', x: 10, y: 20, onclose: vi.fn() });
  const input = screen.getByLabelText('Any emoji');
  await fireEvent.input(input, { target: { value: 'ab' } });
  expect(await screen.findByRole('alert')).toHaveTextContent('Enter exactly one emoji');
  expect(input).toHaveAttribute('aria-invalid', 'true');
  expect(screen.getByRole('button', { name: 'Use' })).toBeDisabled();
  await fireEvent.keyDown(input, { key: 'Enter' });
  await fireEvent.input(input, { target: { value: '🙂🙂' } });
  expect(await screen.findByRole('alert')).toHaveTextContent('Enter exactly one emoji');
  expect(mocks.setNoteIcon).not.toHaveBeenCalled();
});

it('filters the searchable emoji grid and saves the chosen entry as an emoji icon', async () => {
  const onclose = vi.fn();
  render(NoteIconContextMenu, { noteId: 'alpha', x: 10, y: 20, onclose });
  await fireEvent.input(screen.getByRole('searchbox', { name: 'Search emoji' }), { target: { value: 'light bulb' } });
  expect(screen.queryByRole('menuitemradio', { name: 'turtle slow' })).toBeNull();
  await fireEvent.click(screen.getByRole('menuitemradio', { name: 'idea light bulb' }));
  expect(mocks.setNoteIcon).toHaveBeenCalledWith('alpha', { kind: 'emoji', value: '💡' });
  await waitFor(() => expect(onclose).toHaveBeenCalled());
});

it('reports when no emoji matches the search', async () => {
  render(NoteIconContextMenu, { noteId: 'alpha', x: 10, y: 20, onclose: vi.fn() });
  await fireEvent.input(screen.getByRole('searchbox', { name: 'Search emoji' }), { target: { value: 'zzqq' } });
  expect(screen.getByText(/No emoji match/)).toHaveTextContent('zzqq');
});
