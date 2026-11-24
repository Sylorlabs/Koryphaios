// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import DOMPurify from 'dompurify';
import { codeLanguageLabel, handleCodeCopyClick, wrapCodeBlock } from './code-block';

function mount(html: string): HTMLElement {
  const host = document.createElement('div');
  host.className = 'markdown-content';
  // Same boundary the feed uses: chrome must survive sanitization.
  host.innerHTML = DOMPurify.sanitize(html);
  document.body.append(host);
  return host;
}

describe('code block chrome', () => {
  it('labels known languages and keeps unknown fence names', () => {
    expect(codeLanguageLabel('ts')).toBe('TypeScript');
    expect(codeLanguageLabel('PY')).toBe('Python');
    expect(codeLanguageLabel('')).toBe('Text');
    expect(codeLanguageLabel(undefined)).toBe('Text');
    expect(codeLanguageLabel('zig')).toBe('zig');
  });

  it('escapes a hostile fence info string', () => {
    const html = wrapCodeBlock('<pre><code>x</code></pre>', '"><img src=x onerror=alert(1)>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('survives sanitization with an accessible copy button', () => {
    const host = mount(wrapCodeBlock('<pre><code>const a = 1;\n</code></pre>', 'ts'));
    const button = host.querySelector<HTMLButtonElement>('[data-kory-copy-code]');
    expect(button).not.toBeNull();
    expect(button?.type).toBe('button');
    expect(button?.getAttribute('aria-label')).toBe('Copy TypeScript code');
    expect(host.querySelector('.kory-code-lang')?.textContent).toBe('TypeScript');
    host.remove();
  });

  it('copies the block text without the trailing newline and confirms', async () => {
    vi.useFakeTimers();
    const host = mount(wrapCodeBlock('<pre><code>line 1\nline 2\n</code></pre>', 'text'));
    const button = host.querySelector<HTMLElement>('[data-kory-copy-code]')!;
    const write = vi.fn(async () => {});
    const event = { target: button, preventDefault: vi.fn(), stopPropagation: vi.fn() };

    expect(handleCodeCopyClick(event, write)).toBe(true);
    expect(event.stopPropagation).toHaveBeenCalled();
    expect(write).toHaveBeenCalledWith('line 1\nline 2');
    await vi.waitFor(() => expect(button.hasAttribute('data-copied')).toBe(true));
    expect(button.textContent).toBe('Copied');
    vi.advanceTimersByTime(1600);
    expect(button.textContent).toBe('Copy');
    vi.useRealTimers();
    host.remove();
  });

  it('ignores clicks outside a copy button', () => {
    const host = mount('<p>plain</p>');
    const event = {
      target: host.querySelector('p'),
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };
    expect(handleCodeCopyClick(event)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    host.remove();
  });
});
