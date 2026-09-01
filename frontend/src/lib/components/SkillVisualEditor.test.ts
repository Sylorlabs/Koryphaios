import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import SkillVisualEditor from './SkillVisualEditor.svelte';

describe('SkillVisualEditor', () => {
  it('edits supported CommonMark through real ProseMirror commands', async () => {
    const onchange = vi.fn();
    render(SkillVisualEditor, {
      props: { value: 'Review the evidence.', format: 'markdown', renderer: 'markdown', onchange },
    });

    expect(await screen.findByRole('textbox', { name: 'Visual skill editor' })).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: 'Heading' }));

    await waitFor(() => expect(onchange).toHaveBeenCalledWith('## Review the evidence.'));
  });

  it('keeps unsupported Markdown byte-for-byte locked inside the visual document', async () => {
    const source = '- [x] Keep this exact\n\n:::custom\nraw payload\n:::';
    const onrequestsource = vi.fn();
    render(SkillVisualEditor, {
      props: { value: source, format: 'markdown', renderer: 'markdown', onrequestsource },
    });

    const protectedSource = await screen.findByTestId('locked-raw-source');
    expect(protectedSource.textContent).toBe(source);
    expect(screen.getByRole('textbox', { name: 'Visual skill editor' })).toBeTruthy();
    expect(protectedSource.closest('[contenteditable="false"]')).toBeTruthy();

    await fireEvent.click(screen.getByRole('button', { name: 'Open Source mode' }));
    expect(onrequestsource).toHaveBeenCalledOnce();
  });

  it('never mounts rejected HTML as executable or navigable DOM', async () => {
    const raw = '<script>globalThis.compromised = true</script>';
    const source = `${raw}<p>Keep editable</p>`;
    const view = render(SkillVisualEditor, {
      props: { value: source, format: 'html', renderer: 'html' },
    });

    expect(await screen.findByText('Raw source protected')).toBeTruthy();
    expect(view.container.querySelector('script')).toBeNull();
    expect(view.container.querySelector('[contenteditable="true"]')).toBeTruthy();
    expect(screen.getByTestId('locked-raw-source').textContent).toBe(raw);
    expect(screen.getByText('Keep editable')).toBeTruthy();
  });

  it('edits supported Markdown around a byte-exact locked raw block', async () => {
    const locked = '\n\n:::custom\r\nraw  payload  \r\n:::\n\n';
    const source = `Editable intro${locked}Editable tail`;
    const onchange = vi.fn();
    render(SkillVisualEditor, {
      props: { value: source, format: 'markdown', renderer: 'markdown', onchange },
    });

    const editor = await screen.findByRole('textbox', { name: 'Visual skill editor' });
    expect(editor.textContent).toContain('Editable intro');
    expect(editor.textContent).toContain('Editable tail');
    expect(screen.getByTestId('locked-raw-source').textContent).toBe(locked);

    await fireEvent.click(screen.getByRole('button', { name: 'Heading' }));
    await waitFor(() =>
      expect(onchange).toHaveBeenCalledWith(`## Editable intro${locked}Editable tail`),
    );
  });

  it('edits supported HTML siblings without mounting or rewriting a raw element', async () => {
    const locked =
      '\n<section data-mode="exact"><custom-tag>Raw &amp; exact</custom-tag></section>\n';
    const source = `<p>Editable intro</p>${locked}<p>Editable tail</p>`;
    const onchange = vi.fn();
    const view = render(SkillVisualEditor, {
      props: { value: source, format: 'html', renderer: 'html', onchange },
    });

    expect(await screen.findByText('Editable intro')).toBeTruthy();
    expect(screen.getByText('Editable tail')).toBeTruthy();
    expect(screen.getByTestId('locked-raw-source').textContent).toBe(locked);
    expect(view.container.querySelector('custom-tag')).toBeNull();

    await fireEvent.click(screen.getByRole('button', { name: 'Heading' }));
    await waitFor(() =>
      expect(onchange).toHaveBeenCalledWith(`<h2>Editable intro</h2>${locked}<p>Editable tail</p>`),
    );
  });

  it('does not delete a selected locked raw block from Visual mode', async () => {
    const locked = '\n\n:::custom\nraw payload\n:::\n\n';
    const onchange = vi.fn();
    render(SkillVisualEditor, {
      props: {
        value: `Editable intro${locked}Editable tail`,
        format: 'markdown',
        renderer: 'markdown',
        onchange,
      },
    });

    const rawBlock = await screen.findByRole('note', { name: 'Locked raw source' });
    await fireEvent.click(rawBlock);
    await fireEvent.keyDown(screen.getByRole('textbox', { name: 'Visual skill editor' }), {
      key: 'Backspace',
    });

    expect(screen.getByTestId('locked-raw-source').textContent).toBe(locked);
    expect(onchange).not.toHaveBeenCalledWith(expect.not.stringContaining(locked));
  });

  it('renders Markdown images as inert placeholders instead of network-loading images', async () => {
    const view = render(SkillVisualEditor, {
      props: {
        value: '![Architecture](https://example.invalid/private.png)',
        format: 'markdown',
        renderer: 'markdown',
      },
    });

    expect(await screen.findByRole('img', { name: 'Architecture' })).toBeTruthy();
    expect(view.container.querySelector('img')).toBeNull();
  });

  it('preserves plain-text whitespace in the visual document', async () => {
    const source = 'First line  \n  indented second line\n';
    render(SkillVisualEditor, {
      props: { value: source, format: 'text', renderer: 'plain' },
    });

    const editor = await screen.findByRole('textbox', { name: 'Visual skill editor' });
    expect(editor.textContent).toBe(source);
    expect(screen.queryByRole('button', { name: 'Heading' })).toBeNull();
  });

  it('pastes rich clipboard data into plain skills as exact plain text', async () => {
    const onchange = vi.fn();
    render(SkillVisualEditor, {
      props: { value: 'Start', format: 'text', renderer: 'plain', onchange },
    });

    const editor = await screen.findByRole('textbox', { name: 'Visual skill editor' });
    await fireEvent.paste(editor, {
      clipboardData: {
        getData: (type: string) =>
          type === 'text/plain' ? '<literal>\nsecond line' : '<strong>rich source</strong>',
      },
    });

    await waitFor(() => expect(onchange).toHaveBeenCalled());
    const emitted = onchange.mock.calls.at(-1)?.[0] as string;
    expect(emitted).toContain('<literal>\nsecond line');
    expect(emitted).not.toContain('<strong>');
  });
});
