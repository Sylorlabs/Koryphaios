import { language as languageFacet } from '@codemirror/language';
import { render, screen, waitFor } from '@testing-library/svelte';
import { EditorView } from 'codemirror';
import { describe, expect, it, vi } from 'vitest';
import SkillCodeEditor from './SkillCodeEditor.svelte';

function mountedEditor(container: HTMLElement): EditorView {
  const editor = container.querySelector<HTMLElement>('.cm-editor');
  if (!editor) throw new Error('CodeMirror editor did not mount');

  const view = EditorView.findFromDOM(editor);
  if (!view) throw new Error('Mounted CodeMirror view was not discoverable');
  return view;
}

describe('SkillCodeEditor', () => {
  it('emits exact user edits and synchronizes external values without callback loops', async () => {
    const onchange = vi.fn();
    const { container, rerender } = render(SkillCodeEditor, {
      props: {
        value: '# Initial',
        language: 'markdown',
        onchange,
        ariaLabel: 'Exact Markdown source',
      },
    });

    const textbox = await screen.findByRole('textbox', { name: 'Exact Markdown source' });
    const view = mountedEditor(container);
    expect(view.state.doc.toString()).toBe('# Initial');
    expect(view.state.facet(languageFacet)?.name).toBe('markdown');
    expect(textbox).toHaveAttribute('aria-multiline', 'true');

    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: '# Edited\n\nExact body.' },
    });
    expect(onchange).toHaveBeenCalledTimes(1);
    expect(onchange).toHaveBeenLastCalledWith('# Edited\n\nExact body.');

    await rerender({
      value: '<h1>External HTML</h1>',
      language: 'html',
      onchange,
      ariaLabel: 'Exact HTML source',
    });

    await waitFor(() => {
      expect(view.state.doc.toString()).toBe('<h1>External HTML</h1>');
      expect(view.state.facet(languageFacet)?.name).toBe('html');
    });
    expect(onchange).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('textbox', { name: 'Exact HTML source' })).toBe(textbox);
  });

  it('uses renderer-aware custom highlighting and exposes a real read-only state', async () => {
    const { container, rerender } = render(SkillCodeEditor, {
      props: {
        value: '<section>Instructions</section>',
        language: 'custom',
        renderer: 'html',
        'aria-label': 'Custom source',
      },
    });

    const textbox = await screen.findByRole('textbox', { name: 'Custom source' });
    const view = mountedEditor(container);
    expect(view.state.facet(languageFacet)?.name).toBe('html');
    expect(view.state.readOnly).toBe(false);
    expect(textbox).toHaveAttribute('aria-readonly', 'false');

    await rerender({
      value: '<section>Instructions</section>',
      language: 'custom',
      renderer: 'markdown',
      readonly: true,
      'aria-label': 'Read-only custom source',
    });

    await waitFor(() => {
      expect(view.state.facet(languageFacet)?.name).toBe('markdown');
      expect(view.state.readOnly).toBe(true);
      expect(textbox).toHaveAttribute('aria-readonly', 'true');
    });
    expect(textbox).toHaveAttribute('contenteditable', 'false');

    await rerender({
      value: 'Unparsed exact text',
      language: 'plain',
      readonly: false,
      'aria-label': 'Plain text source',
    });

    await waitFor(() => {
      expect(view.state.facet(languageFacet)).toBeNull();
      expect(view.state.readOnly).toBe(false);
      expect(screen.getByRole('textbox', { name: 'Plain text source' })).toBe(textbox);
    });
  });
});
