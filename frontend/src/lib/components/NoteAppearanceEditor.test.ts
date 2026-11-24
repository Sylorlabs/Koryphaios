import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, expect, it, vi } from 'vitest';
import NoteAppearanceEditor from './NoteAppearanceEditor.svelte';

afterEach(() => {
  cleanup();
});

function renderEditor(props: Record<string, unknown> = {}) {
  const onSave = vi.fn().mockResolvedValue(true);
  const onClose = vi.fn();
  render(NoteAppearanceEditor, {
    props: {
      target: { kind: 'folder', path: '/Projects/api' },
      x: 100,
      y: 120,
      onSave,
      onClose,
      ...props,
    },
  });
  return { onSave, onClose };
}

it('names the folder it edits and keeps the stored emoji', () => {
  renderEditor({ emoji: '🚀', color: 'teal' });
  expect(screen.getByRole('dialog', { name: 'Appearance for /Projects/api' })).toBeTruthy();
  expect((screen.getByLabelText('Emoji') as HTMLInputElement).value).toBe('🚀');
  expect(screen.getByRole('button', { name: 'Color teal' }).getAttribute('aria-pressed')).toBe(
    'true',
  );
});

it('saves a chosen palette swatch together with the emoji', async () => {
  const { onSave, onClose } = renderEditor({ emoji: '🚀' });
  await fireEvent.click(screen.getByRole('button', { name: 'Color rose' }));
  await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await vi.waitFor(() => expect(onSave).toHaveBeenCalledWith({ emoji: '🚀', color: 'rose' }));
  expect(onClose).toHaveBeenCalled();
});

it('normalizes a custom hex color to lowercase six digits before saving', async () => {
  const { onSave } = renderEditor();
  const hex = screen.getByLabelText('Custom hex color') as HTMLInputElement;
  await fireEvent.input(hex, { target: { value: '#ABC' } });
  await fireEvent.click(screen.getByRole('button', { name: 'Use hex' }));
  await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await vi.waitFor(() => expect(onSave).toHaveBeenCalledWith({ emoji: null, color: '#aabbcc' }));
});

it('shows an inline error and does not save an invalid hex color', async () => {
  const { onSave } = renderEditor();
  await fireEvent.input(screen.getByLabelText('Custom hex color'), {
    target: { value: 'rgb(1,2,3)' },
  });
  await fireEvent.click(screen.getByRole('button', { name: 'Use hex' }));
  expect(screen.getByRole('alert').textContent).toMatch(/accent, a palette name, or a #hex/);
  expect(onSave).not.toHaveBeenCalled();
});

it('rejects more than one emoji and text without saving', async () => {
  const { onSave } = renderEditor();
  await fireEvent.input(screen.getByLabelText('Emoji'), { target: { value: '🚀🚀' } });
  await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(screen.getByRole('alert').textContent).toMatch(/exactly one emoji/);
  expect(onSave).not.toHaveBeenCalled();
});

it('quick emoji picks fill the emoji field', async () => {
  const { onSave } = renderEditor();
  await fireEvent.click(screen.getByRole('button', { name: 'Use 📚' }));
  await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await vi.waitFor(() => expect(onSave).toHaveBeenCalledWith({ emoji: '📚', color: null }));
});

it('Reset clears both the emoji and the color in one save', async () => {
  const { onSave, onClose } = renderEditor({ emoji: '🚀', color: 'sky' });
  await fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
  await vi.waitFor(() => expect(onSave).toHaveBeenCalledWith({ emoji: null, color: null }));
  expect(onClose).toHaveBeenCalled();
});

it('Escape closes the editor without saving', async () => {
  const { onSave, onClose } = renderEditor();
  await fireEvent.keyDown(window, { key: 'Escape' });
  expect(onClose).toHaveBeenCalled();
  expect(onSave).not.toHaveBeenCalled();
});

it('edits tag appearance with the tag heading', () => {
  renderEditor({ target: { kind: 'tag', tag: 'urgent' } });
  expect(screen.getByRole('dialog', { name: 'Appearance for #urgent' })).toBeTruthy();
});

it('previews the draft emoji and color live and uses only defined text tokens', async () => {
  renderEditor({ target: { kind: 'tag', tag: 'spec' } });
  const dialog = screen.getByRole('dialog', { name: 'Appearance for #spec' });
  await fireEvent.click(screen.getByRole('button', { name: 'Use 🚀' }));
  await fireEvent.click(screen.getByRole('button', { name: 'Color rose' }));
  const preview = dialog.querySelector('.appearance-preview') as HTMLElement;
  expect(preview.textContent).toContain('🚀');
  expect(preview.getAttribute('style')).toContain('--preview-tint');
  // `--color-text` is not a theme token; it silently fell back before.
  expect(dialog.outerHTML).not.toMatch(/var\(--color-text\)/);
});
