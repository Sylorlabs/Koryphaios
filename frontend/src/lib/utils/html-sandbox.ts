// Renders fenced `html` / `kory-html` / `html-sandbox` blocks as sandboxed
// iframes so agents can show arbitrary HTML + CSS layouts (grids, diagrams,
// styled cards, etc.) without escaping the chat's security boundary.
//
// Pipeline:
//   1. renderer.code emits a placeholder `<div class="kory-html-sandbox"
//      data-content="<base64>"></div>`. The base64 payload is UTF-8 safe and
//      survives DOMPurify (divs + data-* attributes are allowed by default).
//   2. After DOMPurify.sanitize runs on the marked output, call
//      expandHtmlSandboxes(html) to swap each placeholder for a real
//      `<iframe sandbox="" srcdoc="...">` whose document is locked down by a
//      strict CSP and the sandbox attribute (no scripts, no same-origin, no
//      forms, no navigation).

const CSP_META =
  '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; ' +
  'img-src data: blob:; style-src \'unsafe-inline\'; font-src data:; ' +
  'media-src data: blob:; form-action \'none\'; base-uri \'none\'">';

function encodeBase64(text: string): string {
  // UTF-8 safe base64 using TextEncoder (replaces deprecated escape/unescape).
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64(encoded: string): string {
  // UTF-8 safe base64 decode using TextDecoder (replaces deprecated escape/unescape).
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function escapeAttr(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

/** Wrap raw HTML with a strict CSP meta so the iframe document is locked down. */
export function sandboxedHtml(content: string): string {
  return /<head[\s>]/i.test(content)
    ? content.replace(/<head([^>]*)>/i, `<head$1>${CSP_META}`)
    : `${CSP_META}${content}`;
}

/**
 * Produce a DOMPurify-safe placeholder for a fenced HTML block. The actual
 * iframe is materialized later by `expandHtmlSandboxes`.
 */
export function htmlSandboxPlaceholder(content: string): string {
  const encoded = encodeBase64(content);
  return `<div class="kory-html-sandbox" data-content="${encoded}"></div>`;
}

const SANDBOX_PLACEHOLDER_RE = /<div class="kory-html-sandbox" data-content="([^"]*)"><\/div>/g;

/**
 * Replace every `kory-html-sandbox` placeholder with a sandboxed iframe.
 * Returns the input unchanged when no placeholders are present. A single
 * regex scan serves as both the existence check and the replacement pass.
 */
export function expandHtmlSandboxes(html: string): string {
  if (!SANDBOX_PLACEHOLDER_RE.test(html)) {
    SANDBOX_PLACEHOLDER_RE.lastIndex = 0;
    return html;
  }
  SANDBOX_PLACEHOLDER_RE.lastIndex = 0;
  return html.replace(SANDBOX_PLACEHOLDER_RE, (_, encoded) => {
    let content: string;
    try {
      content = decodeBase64(encoded);
    } catch (err: unknown) {
      console.debug('Failed to decode HTML sandbox content:', err instanceof Error ? err.message : String(err));
      return '<div class="kory-html-error">Unable to render HTML sandbox.</div>';
    }
    const srcdoc = escapeAttr(sandboxedHtml(content));
    return (
      '<iframe class="kory-html-frame" sandbox="" referrerpolicy="no-referrer" loading="lazy" ' +
      `title="Agent-rendered HTML" srcdoc="${srcdoc}"></iframe>`
    );
  });
}
