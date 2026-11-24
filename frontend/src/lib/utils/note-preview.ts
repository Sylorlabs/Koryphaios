// One-line plain-text excerpt for a note list row. The list previously showed
// the first 60 raw characters, so a Markdown note read "# Analytics Dashboard
// - Revenue…" and a canvas read as its JSON source.

const PREVIEW_CHARS = 120;

function summarizeCanvas(content: string): string | null {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith('{') || !trimmed.includes('"cards"')) return null;
  try {
    const doc = JSON.parse(trimmed) as { v?: unknown; cards?: unknown; edges?: unknown };
    if (doc?.v !== 1 || !Array.isArray(doc.cards)) return null;
    const cards = doc.cards.length;
    const edges = Array.isArray(doc.edges) ? doc.edges.length : 0;
    const parts = [`Canvas · ${cards} ${cards === 1 ? 'card' : 'cards'}`];
    if (edges > 0) parts.push(`${edges} ${edges === 1 ? 'link' : 'links'}`);
    return parts.join(' · ');
  } catch {
    return null;
  }
}

function stripHtml(content: string): string {
  return content
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function stripMarkdown(content: string): string {
  return (
    content
      // YAML front matter
      .replace(/^---\n[\s\S]*?\n---\n?/, '')
      // fenced code: keep nothing of the fence lines, keep the code text out
      .replace(/^```[^\n]*\n[\s\S]*?(?:\n```|$)/gm, ' ')
      // images, embeds
      .replace(/!\[\[[^\]]*\]\]/g, ' ')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
      // wikilinks [[target|alias]] → alias, [[target]] → target
      .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
      .replace(/\[\[([^\]]+)\]\]/g, '$1')
      // links [label](url) → label
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      // headings, quotes, list and task markers at line start
      .replace(/^\s{0,3}#{1,6}\s+/gm, '')
      .replace(/^\s{0,3}>\s?/gm, '')
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/gm, '')
      // horizontal rules and table separators
      .replace(/^\s*(?:[-*_]\s*){3,}$/gm, ' ')
      .replace(/^\s*\|?(?:\s*:?-+:?\s*\|)+\s*:?-*:?\s*$/gm, ' ')
      .replace(/\|/g, ' ')
      // emphasis, inline code, highlight
      .replace(/(\*\*|__|==|~~)(.+?)\1/g, '$2')
      .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?=[^\w*]|$)/g, '$1$2')
      .replace(/`([^`]+)`/g, '$1')
  );
}

/** Plain-text excerpt of a note's body for list rows (no title repetition). */
export function notePreviewText(
  content: string | null | undefined,
  format: 'markdown' | 'html' | undefined = 'markdown',
  title?: string,
): string {
  if (!content) return '';
  const canvas = summarizeCanvas(content);
  if (canvas) return canvas;
  let text = format === 'html' ? stripHtml(content) : stripMarkdown(content);
  text = text.replace(/\s+/g, ' ').trim();
  // Most notes open with their own title as a heading; skip the repeat.
  if (title) {
    const normalizedTitle = title.trim();
    if (normalizedTitle && text.toLowerCase().startsWith(normalizedTitle.toLowerCase())) {
      text = text.slice(normalizedTitle.length).replace(/^[\s:–—-]+/, '');
    }
  }
  return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS).trimEnd()}…` : text;
}
