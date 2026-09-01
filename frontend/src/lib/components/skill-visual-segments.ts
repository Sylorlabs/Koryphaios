import { parseFragment, type DefaultTreeAdapterTypes } from 'parse5';
import { defaultMarkdownParser } from 'prosemirror-markdown';
import {
  analyzeHtmlVisualSafety,
  analyzeMarkdownVisualSafety,
  type VisualSourceSafety,
} from './skill-visual-safety';

export interface VisualSourceSegment {
  kind: 'editable' | 'locked';
  source: string;
  start: number;
  end: number;
  reason?: string;
}

interface SourceRange {
  start: number;
  end: number;
  reasons: string[];
}

const MARKDOWN_INLINE_ADVANCED: ReadonlyArray<[RegExp, string]> = [
  [/^\s{0,3}[-+*]\s+\[[ xX]\]\s+/gm, 'Task-list markers require exact source.'],
  [/(^|[^\\])~~(?=\S)[\s\S]*?\S~~/g, 'Strikethrough markup requires exact source.'],
  [/^\s*\[\^[^\]]+\]:|\[\^[^\]]+\]/gm, 'Footnotes require exact source.'],
  [/^\s*\[[^\]]+\]:\s*\S+/gm, 'Reference-style link definitions require exact source.'],
  [/\[[^\]]+\]\s*\[[^\]]*\]/g, 'Reference-style links require exact source.'],
  [/^\s*\|?.+\|.+\r?\n\s*\|?\s*:?-{3,}:?\s*\|/gm, 'GFM tables require exact source.'],
  [/^\s*!!!\s+\w+/gm, 'Admonition blocks require exact source.'],
  [/\[\[[^\]]+\]\]/g, 'Wiki links require exact source.'],
  [/(?<!\\)\$(?!\s)[^\n$]+(?<!\s)\$/g, 'Math markup requires exact source.'],
  [
    /^\s*(?:import|export)\s+.+\s+from\s+['"][^'"]+['"]/gm,
    'MDX module syntax requires exact source.',
  ],
  [/\{(?:#[A-Za-z]|\.[A-Za-z])[^}]*\}\s*$/gm, 'Attribute-list markup requires exact source.'],
];

function maskMarkdownCode(source: string): string {
  const lines = source.split(/(?<=\n)/);
  let fence: '`' | '~' | null = null;
  let fenceLength = 0;

  return lines
    .map((line) => {
      const withoutNewline = line.replace(/\r?\n$/, '');
      const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(withoutNewline);
      if (fenceMatch) {
        const marker = fenceMatch[1][0] as '`' | '~';
        if (!fence) {
          fence = marker;
          fenceLength = fenceMatch[1].length;
        } else if (
          marker === fence &&
          fenceMatch[1].length >= fenceLength &&
          /^[ \t]*$/.test(withoutNewline.slice(fenceMatch[0].length))
        ) {
          fence = null;
          fenceLength = 0;
        }
        return line.replace(/[^\r\n]/g, ' ');
      }
      if (fence) return line.replace(/[^\r\n]/g, ' ');
      return line.replace(/(`+)([^`]|`(?!\1))*?\1/g, (match) => match.replace(/[^\r\n]/g, ' '));
    })
    .join('');
}

function lineStarts(source: string): number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

function markdownBlockRanges(source: string): SourceRange[] {
  const starts = lineStarts(source);
  const ranges: SourceRange[] = [];
  const tokens = defaultMarkdownParser.tokenizer.parse(source, {});

  for (const token of tokens) {
    if (token.level !== 0 || !token.map) continue;
    const start = starts[token.map[0]] ?? source.length;
    const end = starts[token.map[1]] ?? source.length;
    if (end <= start) continue;
    const previous = ranges.at(-1);
    if (previous && start < previous.end) {
      previous.end = Math.max(previous.end, end);
    } else {
      ranges.push({ start, end, reasons: [] });
    }
  }

  return ranges;
}

function addMatches(ranges: SourceRange[], source: string, pattern: RegExp, reason: string) {
  pattern.lastIndex = 0;
  let match = pattern.exec(source);
  while (match) {
    ranges.push({
      start: match.index,
      end: Math.max(match.index + match[0].length, match.index + 1),
      reasons: [reason],
    });
    if (match[0].length === 0) pattern.lastIndex += 1;
    match = pattern.exec(source);
  }
}

function addDelimitedMarkdownRanges(
  ranges: SourceRange[],
  visible: string,
  delimiter: RegExp,
  reason: string,
) {
  delimiter.lastIndex = 0;
  const matches: Array<{ start: number; end: number }> = [];
  let match = delimiter.exec(visible);
  while (match) {
    matches.push({ start: match.index, end: match.index + match[0].length });
    if (match[0].length === 0) delimiter.lastIndex += 1;
    match = delimiter.exec(visible);
  }

  for (let index = 0; index < matches.length; index += 2) {
    const opening = matches[index];
    const closing = matches[index + 1];
    ranges.push({
      start: opening.start,
      end: closing?.end ?? visible.length,
      reasons: [reason],
    });
  }
}

function htmlMarkupRanges(source: string, visible: string): SourceRange[] {
  const fragment = parseFragment(source, { sourceCodeLocationInfo: true });
  const ranges: SourceRange[] = [];

  const visit = (node: DefaultTreeAdapterTypes.ChildNode, insideLocatedMarkup: boolean) => {
    const location = node.sourceCodeLocation;
    const isMarkup = node.nodeName !== '#text';
    const startsInVisibleSource = !!location && /\S/.test(visible[location.startOffset] ?? '');

    if (isMarkup && location && startsInVisibleSource && !insideLocatedMarkup) {
      ranges.push({
        start: location.startOffset,
        end: location.endOffset,
        reasons: ['Raw HTML requires exact source.'],
      });
      return;
    }

    if ('childNodes' in node) {
      for (const child of node.childNodes) visit(child, insideLocatedMarkup || isMarkup);
    }
  };

  for (const child of fragment.childNodes) visit(child, false);
  return ranges;
}

function expandToMarkdownBlocks(
  source: string,
  candidate: SourceRange,
  blocks: SourceRange[],
): SourceRange {
  const overlapping = blocks.filter(
    (block) => block.start < candidate.end && block.end > candidate.start,
  );
  if (overlapping.length > 0) {
    return {
      start: Math.min(candidate.start, ...overlapping.map((block) => block.start)),
      end: Math.max(candidate.end, ...overlapping.map((block) => block.end)),
      reasons: candidate.reasons,
    };
  }

  const start = source.lastIndexOf('\n', Math.max(0, candidate.start - 1)) + 1;
  const newline = source.indexOf('\n', candidate.end);
  return {
    start,
    end: newline === -1 ? source.length : newline + 1,
    reasons: candidate.reasons,
  };
}

function mergeRanges(source: string, candidates: SourceRange[]): SourceRange[] {
  const expanded = candidates
    .filter((range) => range.end > range.start)
    .map((range) => {
      let { start, end } = range;
      while (start > 0 && /\s/.test(source[start - 1])) start -= 1;
      while (end < source.length && /\s/.test(source[end])) end += 1;
      return { start, end, reasons: range.reasons };
    })
    .sort((left, right) => left.start - right.start || left.end - right.end);

  const merged: SourceRange[] = [];
  for (const range of expanded) {
    const previous = merged.at(-1);
    if (!previous || range.start > previous.end) {
      merged.push({ ...range, reasons: [...range.reasons] });
      continue;
    }
    previous.end = Math.max(previous.end, range.end);
    for (const reason of range.reasons) {
      if (!previous.reasons.includes(reason)) previous.reasons.push(reason);
    }
  }
  return merged;
}

function segmentsFromLockedRanges(
  source: string,
  candidates: SourceRange[],
  fallback: VisualSourceSafety,
): VisualSourceSegment[] {
  const locked = mergeRanges(source, candidates);
  if (locked.length === 0) {
    return fallback.editable
      ? [{ kind: 'editable', source, start: 0, end: source.length }]
      : [
          {
            kind: 'locked',
            source,
            start: 0,
            end: source.length,
            reason: fallback.reason ?? 'This source requires exact editing.',
          },
        ];
  }

  const segments: VisualSourceSegment[] = [];
  let cursor = 0;
  for (const range of locked) {
    if (range.start > cursor) {
      segments.push({
        kind: 'editable',
        source: source.slice(cursor, range.start),
        start: cursor,
        end: range.start,
      });
    }
    segments.push({
      kind: 'locked',
      source: source.slice(range.start, range.end),
      start: range.start,
      end: range.end,
      reason: range.reasons.join(' '),
    });
    cursor = range.end;
  }
  if (cursor < source.length) {
    segments.push({
      kind: 'editable',
      source: source.slice(cursor),
      start: cursor,
      end: source.length,
    });
  }
  return segments;
}

export function segmentMarkdownVisualSource(source: string): VisualSourceSegment[] {
  const overall = analyzeMarkdownVisualSafety(source);
  if (overall.editable) {
    return [{ kind: 'editable', source, start: 0, end: source.length }];
  }
  if (source.includes('\0')) {
    return [
      {
        kind: 'locked',
        source,
        start: 0,
        end: source.length,
        reason: overall.reason,
      },
    ];
  }

  const visible = maskMarkdownCode(source);
  const blocks = markdownBlockRanges(source);
  const candidates: SourceRange[] = [];

  const frontmatter = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(visible);
  if (frontmatter) {
    candidates.push({
      start: frontmatter.index,
      end: frontmatter.index + frontmatter[0].length,
      reasons: ['YAML frontmatter requires exact source.'],
    });
  }

  addDelimitedMarkdownRanges(
    candidates,
    visible,
    /^\s*:{3,}\w*\s*$/gm,
    'Directive containers require exact source.',
  );
  addDelimitedMarkdownRanges(
    candidates,
    visible,
    /^\s*\$\$\s*$/gm,
    'Math blocks require exact source.',
  );

  for (const [pattern, reason] of MARKDOWN_INLINE_ADVANCED) {
    addMatches(candidates, visible, pattern, reason);
  }
  candidates.push(...htmlMarkupRanges(source, visible));

  for (const block of blocks) {
    const safety = analyzeMarkdownVisualSafety(source.slice(block.start, block.end));
    if (!safety.editable) {
      candidates.push({
        ...block,
        reasons: [safety.reason ?? 'This Markdown block requires exact source.'],
      });
    }
  }

  const expanded = candidates.map((range) => expandToMarkdownBlocks(source, range, blocks));
  const segments = segmentsFromLockedRanges(source, expanded, overall);

  // A candidate detector may intentionally be conservative, but an editable
  // segment must never retain syntax the stock schema would rewrite.
  return segments.map((segment) => {
    if (segment.kind === 'locked') return segment;
    const safety = analyzeMarkdownVisualSafety(segment.source);
    if (safety.editable) return segment;
    return {
      ...segment,
      kind: 'locked' as const,
      reason: safety.reason ?? 'This Markdown block requires exact source.',
    };
  });
}

export function segmentHtmlVisualSource(
  source: string,
  ownerDocument: Document = document,
): VisualSourceSegment[] {
  const overall = analyzeHtmlVisualSafety(source, ownerDocument);
  if (overall.editable) {
    return [{ kind: 'editable', source, start: 0, end: source.length }];
  }
  if (source.includes('\0')) {
    return [
      {
        kind: 'locked',
        source,
        start: 0,
        end: source.length,
        reason: overall.reason,
      },
    ];
  }

  const fragment = parseFragment(source, { sourceCodeLocationInfo: true });
  const candidates: SourceRange[] = [];
  let cursor = 0;

  for (const child of fragment.childNodes) {
    const location = child.sourceCodeLocation;
    if (!location || location.startOffset < cursor || location.endOffset > source.length) {
      return [
        {
          kind: 'locked',
          source,
          start: 0,
          end: source.length,
          reason: 'The HTML parser could not locate every source byte safely.',
        },
      ];
    }

    if (location.startOffset > cursor) {
      const gap = source.slice(cursor, location.startOffset);
      const safety = analyzeHtmlVisualSafety(gap, ownerDocument);
      if (!safety.editable) {
        candidates.push({
          start: cursor,
          end: location.startOffset,
          reasons: [safety.reason ?? 'This HTML source requires exact editing.'],
        });
      }
    }

    const childSource = source.slice(location.startOffset, location.endOffset);
    const safety = analyzeHtmlVisualSafety(childSource, ownerDocument);
    if (!safety.editable) {
      candidates.push({
        start: location.startOffset,
        end: location.endOffset,
        reasons: [safety.reason ?? 'This HTML block requires exact source.'],
      });
    }
    cursor = location.endOffset;
  }

  if (cursor < source.length) {
    const safety = analyzeHtmlVisualSafety(source.slice(cursor), ownerDocument);
    if (!safety.editable) {
      candidates.push({
        start: cursor,
        end: source.length,
        reasons: [safety.reason ?? 'This HTML source requires exact editing.'],
      });
    }
  }

  return segmentsFromLockedRanges(source, candidates, overall);
}
