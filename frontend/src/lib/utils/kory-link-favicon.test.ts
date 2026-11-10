import { describe, expect, it } from 'vitest';
import {
  faviconUrlForHref,
  parseFileHref,
  parseNoteHref,
  dispatchNoteLinkClick,
  parseSessionHref,
  renderChatLink,
  sanitizeExternalHref,
} from './kory-link-favicon';

describe('sanitizeExternalHref', () => {
  it('accepts http(s) URLs', () => {
    expect(sanitizeExternalHref('https://example.com/page')).toContain('https://example.com');
    expect(sanitizeExternalHref('http://example.com')).toContain('http://example.com');
  });

  it('rejects active and credentialed URLs', () => {
    expect(sanitizeExternalHref('javascript:alert(1)')).toBeNull();
    expect(sanitizeExternalHref('data:text/html,<script>alert(1)</script>')).toBeNull();
    expect(sanitizeExternalHref('vbscript:msgbox(1)')).toBeNull();
    expect(sanitizeExternalHref('https://user:pass@example.com')).toBeNull();
    expect(sanitizeExternalHref('ftp://example.com')).toBeNull();
    expect(sanitizeExternalHref('not a url')).toBeNull();
  });
});

describe('parseFileHref & parseSessionHref', () => {
  it('parses file:// URLs with optional #Lstart-Lend fragments', () => {
    expect(parseFileHref('file:///Users/Shared/app/src/utils.ts#L10-L24')).toEqual({
      href: 'file:///Users/Shared/app/src/utils.ts#L10-L24',
      filePath: '/Users/Shared/app/src/utils.ts',
      startLine: 10,
      endLine: 24,
    });
    expect(parseFileHref('file:///Users/Shared/app/src/utils.ts#L42')).toEqual({
      href: 'file:///Users/Shared/app/src/utils.ts#L42',
      filePath: '/Users/Shared/app/src/utils.ts',
      startLine: 42,
    });
    expect(parseFileHref('file:///Users/Shared/../etc/passwd')).toBeNull();
  });

  it('parses session and thread URIs', () => {
    expect(parseSessionHref('kory-session://chat-123')).toEqual({
      href: 'kory-session://chat-123',
      sessionId: 'chat-123',
    });
    expect(parseSessionHref('t3-thread://v1/thread-abc-456')).toEqual({
      href: 't3-thread://v1/thread-abc-456',
      sessionId: 'thread-abc-456',
    });
  });
});

describe('renderChatLink', () => {
  it('renders external links with favicon, target, and rel', () => {
    const html = renderChatLink({ href: 'https://example.com/docs', text: 'Docs' });
    expect(html).toContain('class="kory-external-link"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    // The & in the service URL is HTML-escaped in the attribute.
    expect(html).toContain('s2/favicons');
    expect(html).toContain('domain_url=https%3A%2F%2Fexample.com');
    expect(html).toContain('referrerpolicy="no-referrer"');
    expect(html).toContain('Docs');
  });

  it('renders file:/// links with file path and line range attributes', () => {
    const html = renderChatLink({
      href: 'file:///Users/Shared/app/src/utils.ts#L12-L20',
      text: 'utils.ts',
    });
    expect(html).toContain('class="kory-file-link"');
    expect(html).toContain('data-kory-file-path="/Users/Shared/app/src/utils.ts"');
    expect(html).toContain('data-kory-line-start="12"');
    expect(html).toContain('data-kory-line-end="20"');
    expect(html).toContain(':12-20');
  });

  it('renders session links with data-kory-session-id', () => {
    const html = renderChatLink({
      href: 'kory-session://session-42',
      text: 'UI cleanup thread',
    });
    expect(html).toContain('class="kory-session-link"');
    expect(html).toContain('data-kory-session-id="session-42"');
    expect(html).toContain('UI cleanup thread');
  });

  it('keeps formatted labels and escapes titles', () => {
    const html = renderChatLink({
      href: 'https://example.com',
      title: '"><script>alert(1)</script>',
      text: '<strong>Bold</strong>',
    });
    expect(html).toContain('<strong>Bold</strong>');
    expect(html).not.toContain('<script>');
  });

  it('renders relative links without icons', () => {
    const html = renderChatLink({ href: '#section', text: 'Jump' });
    expect(html).toBe('<a href="#section">Jump</a>');
  });

  it('renders rejected schemes as inert text', () => {
    expect(renderChatLink({ href: 'javascript:alert(1)', text: 'click' })).toBe('click');
  });
});

describe('faviconUrlForHref', () => {
  it('looks up arbitrary registrable domains and nested subdomains from the actual origin', () => {
    expect(faviconUrlForHref('https://docs.unlisted.example.co.uk/path')).toContain(
      'domain_url=https%3A%2F%2Fdocs.unlisted.example.co.uk',
    );
  });

  it('preserves an explicit non-default port in the origin', () => {
    expect(faviconUrlForHref('http://localhost:8080/docs')).toContain(
      'domain_url=http%3A%2F%2Flocalhost%3A8080',
    );
  });

  it('normalizes internationalized hostnames and rejects unsafe hrefs', () => {
    expect(faviconUrlForHref('https://münich.example/path')).toContain(
      'domain_url=https%3A%2F%2Fxn--mnich-kva.example',
    );
    expect(faviconUrlForHref('javascript:alert(1)')).toBe('');
  });
});

describe('note destinations', () => {
  it('decodes paths and IDs once without losing case or reserved characters', () => {
    expect(parseNoteHref('kory-note://path/%2FFindings%2FNotes%20%26%20Links')).toEqual({
      path: '/Findings/Notes & Links',
    });
    expect(parseNoteHref('kory-note://id/project-document%3AAbC')).toEqual({
      id: 'project-document:AbC',
    });
    expect(parseNoteHref('kory-note://title/Caf%C3%A9%20%231')).toEqual({ title: 'Café #1' });
    expect(parseNoteHref('kory-note://path/docs/100%2525.md')).toEqual({ path: 'docs/100%25.md' });
  });

  it.each([
    'kory-note://path/%ZZ',
    'kory-note://path/%00',
    'kory-note://path/../secret',
    'kory-note://path/docs/%2E%2E/secret',
    'kory-note://id/',
    'kory-note://other/value',
    'javascript:alert(1)',
    'kory-note://title/A?project=other',
  ])('rejects invalid destinations %s', (href) => {
    expect(parseNoteHref(href)).toBeNull();
  });

  it('renders encoded note paths with safe navigation metadata', () => {
    const html = renderChatLink({
      href: 'kory-note://path/%2FFindings%2FNotes%20%26%20Links',
      text: '<strong>Notes</strong>',
    });
    expect(html).toContain('data-note-path="/Findings/Notes &amp; Links"');
    expect(html).toContain('<strong>Notes</strong>');
    expect(html).not.toContain('onclick');
  });
});

describe('note link click dispatch', () => {
  it('routes a click on a nested label to an application note event', () => {
    const container = document.createElement('div');
    container.innerHTML = renderChatLink({
      href: 'kory-note://path/%2FFindings%2FGuide',
      text: '<strong>Guide</strong>',
    });
    document.body.append(container);
    const destinations: unknown[] = [];
    /** Observe the real event payload dispatched by the link interceptor. */
    const observe = (event: Event) => destinations.push((event as CustomEvent).detail);
    window.addEventListener('open-note', observe);
    container.addEventListener('click', dispatchNoteLinkClick);
    try {
      const click = new MouseEvent('click', { bubbles: true, cancelable: true });
      container.querySelector('strong')!.dispatchEvent(click);
      expect(click.defaultPrevented).toBe(true);
      expect(destinations).toEqual([{ path: '/Findings/Guide' }]);
    } finally {
      window.removeEventListener('open-note', observe);
      container.remove();
    }
  });
});
