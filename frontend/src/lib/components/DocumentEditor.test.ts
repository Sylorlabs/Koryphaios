import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { EditorView } from 'codemirror';
import { describe, expect, it, vi } from 'vitest';
import DocumentEditor from './DocumentEditor.svelte';

describe('document editing across knowledge workspaces', () => {
  it('switches between writing, exact source, and preview without rewriting the saved document', async () => {
    const source = '# Findings\n\n| Claim | Evidence |\n| --- | --- |\n| Kept | Exact source |\n\n[[Related note]]\n';
    const onchange = vi.fn();
    const { container } = render(DocumentEditor, { value: source, onchange, sourceLabel: 'Saved source' });
    await screen.findByRole('textbox', { name: 'Document editor' });
    await fireEvent.click(screen.getByRole('button', { name: 'Source' }));
    await screen.findByRole('textbox', { name: 'Saved source' });
    const view = EditorView.findFromDOM(container.querySelector<HTMLElement>('.cm-editor')!)!;
    expect(view.state.doc.toString()).toBe(source);
    await fireEvent.click(screen.getByRole('button', { name: 'Split view' }));
    await waitFor(() => expect(container.querySelector('article table')).toBeTruthy());
    expect(onchange).not.toHaveBeenCalled();
  });

  it('routes a visual skill edit through its body callback without replacing legacy metadata', async () => {
    const body = 'Review the evidence.';
    const source = `---\nname: review\ndescription: Preserve this metadata\n---\n${body}`;
    const onchange = vi.fn();
    const onvisualchange = vi.fn();
    render(DocumentEditor, { value: source, visualValue: body, onchange, onvisualchange });
    await screen.findByRole('textbox', { name: 'Document editor' });
    await fireEvent.click(screen.getByRole('button', { name: 'Heading' }));
    await waitFor(() => expect(onvisualchange).toHaveBeenCalledWith('## Review the evidence.'));
    expect(onchange).not.toHaveBeenCalled();
  });

  it('keeps HTML previews sandboxed when a document contains scripts or remote content', async () => {
    const { container } = render(DocumentEditor, {
      value: '<script>window.bad = true</script><h1>Instructions</h1>',
      format: 'html', renderer: 'html', mode: 'split', onchange: vi.fn(),
    });
    const preview = await screen.findByTitle('Sandboxed document HTML preview');
    expect(preview.getAttribute('sandbox')).toBe('');
    expect(preview.getAttribute('srcdoc')).toContain("script-src 'none'");
    expect(container.querySelector('script')).toBeNull();
  });
});
