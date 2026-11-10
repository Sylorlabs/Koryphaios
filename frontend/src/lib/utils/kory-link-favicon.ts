// External and workspace navigation links for chat markdown.
//
// 1. Standard `[label](https://example.com)` links render with the site's
//    favicon beside the label and open in a new tab.
// 2. Local file and symbol links (`[file.ts](file:///abs/path/file.ts#L10-L20)`)
//    render as interactive T3-style `.kory-file-link` pills with file path and
//    line-range metadata so clicking them opens the file at that line.
// 3. Session/thread links (`[title](kory-session://<id>)`, `t3-thread://v1/<id>`,
//    `conversation://<id>`) render as `.kory-session-link` anchors that navigate
//    directly to the referenced chat thread.

/** Favicon service: always 200s, even for unknown domains. */
export const FAVICON_SERVICE_BASE = 'https://www.google.com/s2/favicons?sz=32&domain_url=';

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Validated external URL, or null when the href must not become an external web link. */
export function sanitizeExternalHref(rawHref: string): string | null {
  const href = rawHref.trim();
  if (!href) return null;
  const lowered = href.toLowerCase();
  if (
    lowered.startsWith('javascript:') ||
    lowered.startsWith('data:') ||
    lowered.startsWith('vbscript:') ||
    lowered.startsWith('file:')
  ) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  // Credentialed URLs (https://user:pass@host) are a phishing vector.
  if (url.username || url.password) return null;
  return url.toString();
}

export interface ParsedFileHref {
  href: string;
  filePath: string;
  startLine?: number;
  endLine?: number;
}

/**
 * Parse a `file:///absolute/path#L10-L20` link into its local filesystem path
 * and optional 1-indexed line range.
 */
export function parseFileHref(rawHref: string): ParsedFileHref | null {
  const href = rawHref.trim();
  if (!href.toLowerCase().startsWith('file://')) return null;
  if (/(?:^|[\\/])\.\.(?:[\\/#?]|$)|%2e%2e/i.test(href)) return null;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== 'file:') return null;
  if (url.username || url.password) return null;

  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  // Normalize Windows `/C:/Users/...` pathname from URL parser.
  if (/^\/[a-zA-Z]:\//.test(decodedPath)) {
    decodedPath = decodedPath.slice(1);
  }
  if (!decodedPath || /[\0<>"']/.test(decodedPath)) return null;
  // Reject traversal segments.
  const segments = decodedPath.split(/[\\/]+/);
  if (segments.includes('..')) return null;

  let startLine: number | undefined;
  let endLine: number | undefined;
  const hash = url.hash.replace(/^#/, '').trim();
  if (hash) {
    const lineMatch = /^L(\d+)(?:-L?(\d+))?$/i.exec(hash);
    if (lineMatch) {
      const start = Number.parseInt(lineMatch[1]!, 10);
      const end = lineMatch[2] ? Number.parseInt(lineMatch[2], 10) : undefined;
      if (Number.isFinite(start) && start >= 1) {
        startLine = start;
        if (end !== undefined && Number.isFinite(end) && end >= start) {
          endLine = end;
        }
      }
    }
  }

  return {
    href: url.toString(),
    filePath: decodedPath,
    ...(startLine !== undefined ? { startLine } : {}),
    ...(endLine !== undefined ? { endLine } : {}),
  };
}

/** A note destination within the active project's vault. */
export type NoteLinkTarget = { id: string } | { path: string } | { title: string };

/** Decode a note URI once, preserving case and rejecting malformed destinations. */
export function parseNoteHref(rawHref: string): NoteLinkTarget | null {
  const match = /^kory-note:\/\/(id|path|title)\/([^?#]+)$/i.exec(rawHref.trim());
  if (!match) return null;
  let value: string;
  try {
    value = decodeURIComponent(match[2]);
  } catch {
    return null;
  }
  if (!value.trim() || /[\u0000-\u001f\u007f]/.test(value)) return null;
  const kind = match[1].toLowerCase();
  if (kind === 'path') {
    if (value.split(/[\\/]/).some((segment) => segment === '..' || segment === '.')) return null;
    return { path: value };
  }
  return kind === 'id' ? { id: value } : { title: value };
}

/** Route note anchors through application events after sanitized Markdown renders. */
export function dispatchNoteLinkClick(event: MouseEvent): boolean {
  if (event.defaultPrevented || !(event.target instanceof Element)) return false;
  const anchor = event.target.closest('a');
  const target = parseNoteHref(anchor?.getAttribute('href') ?? '');
  if (!target) return false;
  event.preventDefault();
  window.dispatchEvent(new CustomEvent('open-note', { detail: target }));
  return true;
}

export interface ParsedSessionHref {
  href: string;
  sessionId: string;
}

/**
 * Parse a thread/session URI (`kory-session://<id>`, `t3-thread://v1/<id>`,
 * or `conversation://<id>`).
 */
export function parseSessionHref(rawHref: string): ParsedSessionHref | null {
  const href = rawHref.trim();
  const match =
    /^(?:kory-session:\/\/(?:v1\/)?|t3-thread:\/\/v1\/|conversation:\/\/)([a-zA-Z0-9._:-]+)$/i.exec(
      href,
    );
  if (!match) return null;
  const sessionId = match[1]!;
  if (!sessionId || /[<>"']/.test(sessionId)) return null;
  return { href, sessionId };
}

export function faviconUrlForHref(href: string): string {
  const safeHref = sanitizeExternalHref(href);
  if (!safeHref) return '';
  return `${FAVICON_SERVICE_BASE}${encodeURIComponent(new URL(safeHref).origin)}`;
}

export interface ChatLinkInput {
  href?: string | null;
  title?: string | null;
  /** Already-parsed inline HTML from marked (labels may carry formatting). */
  text?: string | null;
}

/**
 * Render a marked link token:
 * - External http(s) links get `kory-external-link`, target=_blank, and a site favicon.
 * - Local `file:///path#L10-L20` links get `kory-file-link` + line range data attributes.
 * - Thread/session links (`kory-session://`, `t3-thread://v1/`, `conversation://`) get `kory-session-link`.
 * - Relative links / anchors / mailto render as safe anchors.
 * - Rejected schemes render as inert escaped text.
 */
export function renderChatLink({ href, title, text }: ChatLinkInput): string {
  const label = text ?? href ?? '';
  const safeTitle = title ? ` title="${escapeHtml(title)}"` : '';
  const external = href ? sanitizeExternalHref(href) : null;
  if (external) {
    const favicon = faviconUrlForHref(external);
    const icon = favicon
      ? `<img class="kory-link-favicon" src="${escapeHtml(favicon)}" alt="" aria-hidden="true" loading="eager" decoding="async" referrerpolicy="no-referrer" draggable="false" width="16" height="16">`
      : '';
    return (
      `<a class="kory-external-link" href="${escapeHtml(external)}"` +
      ` target="_blank" rel="noopener noreferrer"${safeTitle}>${icon}${label}</a>`
    );
  }

  const fileTarget = href ? parseFileHref(href) : null;
  if (fileTarget) {
    const lineRangeSuffix =
      fileTarget.startLine !== undefined
        ? fileTarget.endLine !== undefined && fileTarget.endLine !== fileTarget.startLine
          ? `:${fileTarget.startLine}-${fileTarget.endLine}`
          : `:${fileTarget.startLine}`
        : '';
    const defaultTitle = `${fileTarget.filePath}${lineRangeSuffix}`;
    const titleAttr = safeTitle || ` title="${escapeHtml(defaultTitle)}"`;
    const startAttr =
      fileTarget.startLine !== undefined ? ` data-kory-line-start="${fileTarget.startLine}"` : '';
    const endAttr =
      fileTarget.endLine !== undefined ? ` data-kory-line-end="${fileTarget.endLine}"` : '';
    const lineBadge =
      lineRangeSuffix &&
      !label.includes(lineRangeSuffix) &&
      !label.includes(`#L${fileTarget.startLine}`)
        ? `<span class="kory-file-link-lines">${escapeHtml(lineRangeSuffix)}</span>`
        : '';
    return (
      `<a class="kory-file-link" href="${escapeHtml(fileTarget.href)}"` +
      ` data-kory-file-path="${escapeHtml(fileTarget.filePath)}"${startAttr}${endAttr}${titleAttr}>` +
      `${label}${lineBadge}</a>`
    );
  }

  const noteTarget = href ? parseNoteHref(href) : null;
  if (noteTarget) {
    const [kind, value] = Object.entries(noteTarget)[0];
    return `<a class="kory-note-link wikilink" href="kory-note://${kind}/${encodeURIComponent(value)}" data-note-${kind}="${escapeHtml(value)}"${safeTitle}>${label}</a>`;
  }

  const sessionTarget = href ? parseSessionHref(href) : null;
  if (sessionTarget) {
    const titleAttr = safeTitle || ` title="Open thread ${escapeHtml(sessionTarget.sessionId)}"`;
    return (
      `<a class="kory-session-link" href="${escapeHtml(sessionTarget.href)}"` +
      ` data-kory-session-id="${escapeHtml(sessionTarget.sessionId)}"${titleAttr}>${label}</a>`
    );
  }

  if (href && href.trim()) {
    // Relative links, anchors, mailto: — safe anchor, no icon, no new tab.
    const trimmed = href.trim();
    if (/^(#|\/|mailto:|tel:)/i.test(trimmed) && !/[<>"']/.test(trimmed)) {
      return `<a href="${escapeHtml(trimmed)}"${safeTitle}>${label}</a>`;
    }
  }
  return label;
}
