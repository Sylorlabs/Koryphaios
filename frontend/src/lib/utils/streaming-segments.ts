// Streaming-aware segment scanner for rich fenced blocks.
//
// During streaming, marked.parse can't reliably render partial markdown —
// unclosed fences produce broken output. Instead of waiting for the stream
// to complete, this scanner walks the streaming text line-by-line and splits
// it into segments:
//
//   - { kind: 'text', text }  → raw text, rendered as plain text content
//   - { kind: 'block', html } → pre-rendered HTML from a completed fenced block
//
// A fenced block is "complete" when both the opening ```lang and closing ```
// are present. Incomplete fences (still being streamed) are treated as raw
// text — the user sees the fence as-is until the closing ``` arrives, at
// which point the block renders immediately, mid-stream.
//
// Only rich block languages (chart, color, html) are rendered during
// streaming. Other fenced code blocks (python, typescript, etc.) are left as
// raw text and rendered by marked's syntax highlighter after streaming
// completes.
//
// Security: raw text segments are rendered as text content (not HTML) in the
// template, so there's no XSS risk. Block HTML is safe by construction —
// the renderers escape all agent-controlled input, and HTML sandbox iframes
// use sandbox="" + CSP + escaped srcdoc. No DOMPurify is needed during
// streaming because no agent-generated HTML is injected into the parent DOM
// (iframe content lives in srcdoc, which is a separate document).

import { renderKoryChart } from './chart-renderer';
import { renderKoryColors } from './color-renderer';
import { htmlSandboxPlaceholder, expandHtmlSandboxes } from './html-sandbox';

export interface StreamingSegment {
  id: number;
  kind: 'text' | 'block';
  text?: string;
  html?: string;
}

const RICH_LANGS = new Set([
  'chart', 'kory-chart',
  'color', 'kory-color',
  'html', 'kory-html', 'html-sandbox',
]);

// Opening fence: ```lang (optional whitespace after lang)
const FENCE_OPEN_RE = /^```(\S+)\s*$/;
// Closing fence: ``` (optional whitespace)
const FENCE_CLOSE_RE = /^```\s*$/;

function renderBlock(lang: string, content: string): string | null {
  switch (lang) {
    case 'chart':
    case 'kory-chart':
      return renderKoryChart(content);
    case 'color':
    case 'kory-color':
      return renderKoryColors(content);
    case 'html':
    case 'kory-html':
    case 'html-sandbox':
      // Expand the sandbox immediately — the iframe markup is safe by
      // construction (sandbox="", CSP, escaped srcdoc), and the raw text
      // segments are rendered as text content, not HTML.
      return expandHtmlSandboxes(htmlSandboxPlaceholder(content));
    default:
      return null;
  }
}

/**
 * Split streaming text into segments: completed rich blocks (rendered to
 * HTML) and raw text (everything else, including incomplete fences).
 */
export function computeStreamingSegments(text: string): StreamingSegment[] {
  if (!text) return [];
  const lines = text.split('\n');
  const segments: StreamingSegment[] = [];
  let segId = 0;
  let i = 0;
  let textBuffer: string[] = [];

  const flushText = () => {
    if (textBuffer.length) {
      segments.push({ id: segId++, kind: 'text', text: textBuffer.join('\n') });
      textBuffer = [];
    }
  };

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    const openMatch = FENCE_OPEN_RE.exec(trimmed);

    if (openMatch) {
      const lang = openMatch[1].toLowerCase();
      if (RICH_LANGS.has(lang)) {
        // Look for a closing fence.
        let j = i + 1;
        const contentLines: string[] = [];
        let foundClose = false;
        while (j < lines.length) {
          if (FENCE_CLOSE_RE.test(lines[j].trim())) {
            foundClose = true;
            break;
          }
          contentLines.push(lines[j]);
          j++;
        }
        if (foundClose) {
          // Complete rich block — flush buffered text, then render.
          flushText();
          const content = contentLines.join('\n');
          const html = renderBlock(lang, content);
          if (html) {
            segments.push({ id: segId++, kind: 'block', html });
          } else {
            // Renderer returned null (malformed input) — treat the whole
            // block as raw text, including the fences.
            textBuffer.push(line, ...contentLines, lines[j]);
          }
          i = j + 1;
          continue;
        }
        // No closing fence — incomplete block. Fall through to text buffer
        // so the user sees the fence as-is while it streams.
      }
    }
    textBuffer.push(line);
    i++;
  }
  flushText();
  return segments;
}
