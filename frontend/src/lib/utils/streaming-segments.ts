// Streaming-aware scanner: completed rich fences keep stable DOM identities.
// All prose, including untrusted partial Markdown, crosses the same sanitizer
// as final chat messages. Never trust model output as executable HTML.

import { createChatMarkdown, renderChatMarkdown } from './chat-markdown';
const streamMarkdown = createChatMarkdown(false);
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
  'chart',
  'kory-chart',
  'color',
  'kory-color',
  'html',
  'kory-html',
  'html-sandbox',
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

export function computeStreamingSegments(text: string): StreamingSegment[] {
  return scanSegments(text, 0).segments;
}

/**
 * Incremental memoizer for per-token streaming renders. The full scan above
 * is O(n) in the response length (line scan + marked parse), so re-running it
 * on every token gets linearly slower as the response grows.
 *
 * Completed rich blocks are immutable: once a closing fence has streamed in,
 * that block's HTML never changes no matter what is appended after it. The
 * snapshot therefore remembers `stableLength` — the char offset just past the
 * last completed block — and on a pure append only the unstable tail
 * (trailing text + any still-open fence) is rescanned. Completed block DOM
 * nodes keep stable ids, so keyed `{#each}` blocks don't remount them.
 *
 * Limitations: with no completed block yet (plain-text-only streams) there is
 * no stable prefix and the text is fully re-parsed — marked output for
 * already-streamed prose can change as new syntax arrives, so reusing stale
 * HTML would be incorrect. Any non-append edit (rewind/regeneration) also
 * falls back to a full scan.
 */
export interface StreamingSegmentsSnapshot {
  text: string;
  segments: StreamingSegment[];
  /** Char offset just past the last completed block (0 = no stable prefix). */
  stableLength: number;
  /** Exclusive char end offset of each segment's raw source span (internal). */
  ends: number[];
}

export function computeStreamingSegmentsIncremental(
  prev: StreamingSegmentsSnapshot | null | undefined,
  text: string,
): StreamingSegmentsSnapshot {
  if (
    prev &&
    prev.stableLength > 0 &&
    prev.stableLength <= text.length &&
    text.startsWith(prev.text)
  ) {
    const kept: StreamingSegment[] = [];
    const keptEnds: number[] = [];
    for (let i = 0; i < prev.segments.length; i++) {
      if (prev.ends[i] <= prev.stableLength) {
        kept.push(prev.segments[i]);
        keptEnds.push(prev.ends[i]);
      }
    }
    const tail = scanSegments(text.slice(prev.stableLength), kept.length);
    return {
      text,
      segments: [...kept, ...tail.segments],
      ends: [...keptEnds, ...tail.ends.map((e) => e + prev.stableLength)],
      stableLength:
        tail.stableLength > 0 ? prev.stableLength + tail.stableLength : prev.stableLength,
    };
  }
  const full = scanSegments(text, 0);
  return { text, segments: full.segments, ends: full.ends, stableLength: full.stableLength };
}

interface ScanResult {
  segments: StreamingSegment[];
  /** Exclusive char end offset of each segment's raw source span. */
  ends: number[];
  /** Char offset just past the last completed block (line-aligned). */
  stableLength: number;
}

function scanSegments(text: string, idBase: number): ScanResult {
  if (!text) return { segments: [], ends: [], stableLength: 0 };
  const lines = text.split('\n');
  // Char offset where each line starts, so segment raw spans can be recorded
  // as char ranges and completed blocks get a line-aligned stable boundary.
  const starts: number[] = new Array(lines.length);
  let pos = 0;
  for (let n = 0; n < lines.length; n++) {
    starts[n] = pos;
    pos += lines[n].length + 1;
  }
  const segments: StreamingSegment[] = [];
  const ends: number[] = [];
  let segId = idBase;
  let stableLength = 0;
  let i = 0;
  // Line index where the current textBuffer starts (for raw end offsets).
  let textStart = 0;
  let textBuffer: string[] = [];

  const flushText = (endLine: number) => {
    if (textBuffer.length) {
      const raw = textBuffer.join('\n');
      const html = renderChatMarkdown(raw, streamMarkdown);
      segments.push({ id: segId++, kind: 'text', html });
      ends.push(starts[textStart] + raw.length);
      textBuffer = [];
    }
    textStart = endLine;
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
          flushText(i);
          const content = contentLines.join('\n');
          const html = renderBlock(lang, content);
          if (html) {
            segments.push({ id: segId++, kind: 'block', html });
            const raw = lines.slice(i, j + 1).join('\n');
            ends.push(starts[i] + raw.length);
            // Line-aligned boundary just past the closing fence: everything
            // before it is immutable under future appends.
            stableLength = j + 1 < lines.length ? starts[j + 1] : text.length;
            textStart = j + 1;
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
  flushText(lines.length);
  return { segments, ends, stableLength };
}
