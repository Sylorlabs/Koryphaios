// Fenced code block chrome for rendered chat Markdown: a language label and a
// copy button overlaid on the block (styles in chat-markdown.css).
//
// The button is plain markup inside sanitized HTML, so it cannot carry a
// Svelte handler. A single delegated click listener (installed by the root
// layout) recognises it by `data-kory-copy-code` and copies the sibling
// `<pre>`'s text.

const COPY_ATTR = 'data-kory-copy-code';
const COPIED_ATTR = 'data-copied';
const COPIED_RESET_MS = 1500;

const LANGUAGE_LABELS: Record<string, string> = {
  bash: 'Bash',
  sh: 'Shell',
  shell: 'Shell',
  zsh: 'Shell',
  cpp: 'C++',
  c: 'C',
  css: 'CSS',
  scss: 'SCSS',
  diff: 'Diff',
  go: 'Go',
  java: 'Java',
  javascript: 'JavaScript',
  js: 'JavaScript',
  jsx: 'JSX',
  json: 'JSON',
  markdown: 'Markdown',
  md: 'Markdown',
  python: 'Python',
  py: 'Python',
  rust: 'Rust',
  rs: 'Rust',
  sql: 'SQL',
  typescript: 'TypeScript',
  ts: 'TypeScript',
  tsx: 'TSX',
  xml: 'XML',
  html: 'HTML',
  svelte: 'Svelte',
  yaml: 'YAML',
  yml: 'YAML',
  toml: 'TOML',
  swift: 'Swift',
  kotlin: 'Kotlin',
  ruby: 'Ruby',
  plaintext: 'Text',
  text: 'Text',
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Human label for a fence language; unknown languages keep their own name. */
export function codeLanguageLabel(language: string | undefined | null): string {
  const key = (language ?? '').trim().toLowerCase();
  if (!key) return 'Text';
  return LANGUAGE_LABELS[key] ?? key;
}

/**
 * Wraps an already-rendered `<pre>` block with the label + copy chrome.
 * `preHtml` must be trusted renderer output (it is not escaped here); the
 * language is escaped because it comes from the fence info string.
 */
export function wrapCodeBlock(preHtml: string, language?: string | null): string {
  const label = escapeHtml(codeLanguageLabel(language));
  return (
    `<div class="kory-code-block" data-language="${label}">` +
    `<div class="kory-code-tools">` +
    `<span class="kory-code-lang">${label}</span>` +
    `<button type="button" class="kory-code-copy" ${COPY_ATTR}="" aria-label="Copy ${label} code">Copy</button>` +
    `</div>${preHtml}</div>`
  );
}

type ClipboardWriter = (text: string) => Promise<void>;

function defaultWriter(text: string): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text);
  }
  return Promise.reject(new Error('Clipboard unavailable'));
}

/**
 * Delegated click handler. Returns true when the click was a code-copy click
 * (so the caller can stop handling it), false otherwise.
 */
export function handleCodeCopyClick(
  event: Pick<MouseEvent, 'target' | 'preventDefault' | 'stopPropagation'>,
  write: ClipboardWriter = defaultWriter,
): boolean {
  const target = event.target as Element | null;
  const button = target?.closest?.(`[${COPY_ATTR}]`) as HTMLElement | null;
  if (!button) return false;
  event.preventDefault();
  // The feed row behind the block is itself clickable (selection); a copy
  // click must not also select the row.
  event.stopPropagation();
  const block = button.closest('.kory-code-block');
  const code = block?.querySelector('pre code') ?? block?.querySelector('pre');
  const text = code?.textContent ?? '';
  void write(text.replace(/\n$/, '')).then(
    () => {
      button.setAttribute(COPIED_ATTR, '');
      button.textContent = 'Copied';
      setTimeout(() => {
        button.removeAttribute(COPIED_ATTR);
        button.textContent = 'Copy';
      }, COPIED_RESET_MS);
    },
    () => {
      button.textContent = 'Copy failed';
      setTimeout(() => {
        button.textContent = 'Copy';
      }, COPIED_RESET_MS);
    },
  );
  return true;
}
