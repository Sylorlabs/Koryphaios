import { parseFragment, type DefaultTreeAdapterTypes, type ParserError } from 'parse5';

export type SkillVisualFormat = 'markdown' | 'text' | 'html' | 'custom';
export type SkillVisualRenderer = 'markdown' | 'plain' | 'html';

export interface VisualSourceSafety {
  editable: boolean;
  reason?: string;
}

const HTML_ALLOWED_ATTRIBUTES: Readonly<Record<string, ReadonlySet<string>>> = {
  a: new Set(['href', 'title']),
  img: new Set(['src', 'alt', 'title']),
  ol: new Set(['start']),
};

const HTML_ALLOWED_TAGS = new Set([
  'a',
  'b',
  'blockquote',
  'br',
  'code',
  'em',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'i',
  'img',
  'li',
  'ol',
  'p',
  'pre',
  'strong',
  'ul',
]);

/**
 * Resolve custom formats through their declared renderer. Native formats are
 * intentionally authoritative so a mismatched sidecar cannot make HTML live.
 */
export function visualModeFor(
  format: SkillVisualFormat,
  renderer: SkillVisualRenderer,
): SkillVisualRenderer {
  if (format === 'markdown') return 'markdown';
  if (format === 'html') return 'html';
  if (format === 'text') return 'plain';
  return renderer;
}

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

/**
 * ProseMirror's stock Markdown schema intentionally implements CommonMark,
 * not every GFM/MDX extension. Detect syntax that would otherwise be parsed as
 * ordinary text or normalized away and keep the original bytes locked.
 */
export function analyzeMarkdownVisualSafety(source: string): VisualSourceSafety {
  if (source.includes('\0')) {
    return { editable: false, reason: 'The document contains a NUL byte.' };
  }
  if (source.startsWith('\uFEFF')) {
    return { editable: false, reason: 'The document begins with a byte-order mark.' };
  }

  const visible = maskMarkdownCode(source);
  const advancedConstructs: Array<[RegExp, string]> = [
    [/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, 'YAML frontmatter'],
    [/^\+\+\+[ \t]*\r?\n[\s\S]*?\r?\n\+\+\+[ \t]*(?:\r?\n|$)/, 'TOML frontmatter'],
    [/<!--|<!\[CDATA\[|<!doctype|<\?xml|<\/?[A-Za-z][^>\n]*(?:>|$)/i, 'raw HTML'],
    [/^\s{0,3}[-+*]\s+\[[ xX]\]\s+/m, 'task-list markers'],
    [/^\s{0,3}>\s*\[![A-Za-z][\w-]*\]/m, 'GFM alert markup'],
    [/^\S[^\r\n]*\r?\n\s*:\s+\S/m, 'definition-list markup'],
    [/(^|[^\\])~~(?=\S)[\s\S]*?\S~~/, 'strikethrough markup'],
    [/^\s*\[\^[^\]]+\]:|\[\^[^\]]+\]/m, 'footnotes'],
    [/^\s*\[[^\]]+\]:\s*\S+/m, 'reference-style link definitions'],
    [/\[[^\]]+\]\s*\[[^\]]*\]/, 'reference-style links'],
    [/^\s*\|?.+\|.+\r?\n\s*\|?\s*:?-{3,}:?\s*\|/m, 'GFM tables'],
    [/^\s*:{3,}\w*\s*$/m, 'directive containers'],
    [/^\s*!!!\s+\w+/m, 'admonition blocks'],
    [/\[\[[^\]]+\]\]/, 'wiki links'],
    [/^\s*\$\$\s*$|(?<!\\)\$(?!\s)[^\n$]+(?<!\s)\$/m, 'math markup'],
    [/^\s*(?:import|export)\s+.+\s+from\s+['"][^'"]+['"]/m, 'MDX module syntax'],
    [/\{(?:#[A-Za-z]|\.[A-Za-z])[^}]*\}\s*$/m, 'attribute-list markup'],
  ];

  for (const [pattern, label] of advancedConstructs) {
    if (pattern.test(visible)) {
      return {
        editable: false,
        reason: `${label} is not represented by the Visual editor schema.`,
      };
    }
  }

  const fenceLines = source.split(/(?<=\n)/);
  let openFence: { marker: '`' | '~'; length: number } | null = null;
  for (const line of fenceLines) {
    const match = /^ {0,3}(`{3,}|~{3,})/.exec(line.replace(/\r?\n$/, ''));
    if (!match) continue;
    const marker = match[1][0] as '`' | '~';
    if (!openFence) {
      openFence = { marker, length: match[1].length };
    } else if (
      marker === openFence.marker &&
      match[1].length >= openFence.length &&
      /^[ \t]*$/.test(line.replace(/\r?\n$/, '').slice(match[0].length))
    ) {
      openFence = null;
    }
  }
  if (openFence) {
    return {
      editable: false,
      reason: 'An unclosed code fence is not safe to normalize in Visual mode.',
    };
  }

  return { editable: true };
}

function unsafeUrl(value: string): boolean {
  const compact = value.replace(/[\u0000-\u0020]+/g, '').toLowerCase();
  return /^(?:javascript|vbscript|file):/.test(compact);
}

/**
 * Stored HTML is parsed only inside an inert template. This check rejects any
 * element or attribute the ProseMirror schema would discard, as well as active
 * URL protocols. Rejected source is shown as escaped text and is never mounted.
 */
export function analyzeHtmlVisualSafety(
  source: string,
  ownerDocument: Document = document,
): VisualSourceSafety {
  if (source.includes('\0')) {
    return { editable: false, reason: 'The document contains a NUL byte.' };
  }
  if (/<!doctype|<!--|<\?xml/i.test(source)) {
    return {
      editable: false,
      reason: 'Document declarations and comments require Source mode.',
    };
  }

  const parseErrors: ParserError[] = [];
  const parsed = parseFragment(source, {
    sourceCodeLocationInfo: true,
    onParseError: (error) => parseErrors.push(error),
  });
  if (parseErrors.length > 0) {
    return {
      editable: false,
      reason: 'Malformed or ambiguous HTML requires Source mode.',
    };
  }

  const locatedMarkupStarts = new Set<number>();
  const recordMarkup = (node: DefaultTreeAdapterTypes.ChildNode) => {
    if ('tagName' in node) {
      const location = node.sourceCodeLocation;
      if (location?.startTag) locatedMarkupStarts.add(location.startTag.startOffset);
      if (location?.endTag) locatedMarkupStarts.add(location.endTag.startOffset);
    }
    if ('childNodes' in node) {
      for (const child of node.childNodes) recordMarkup(child);
    }
  };
  for (const child of parsed.childNodes) recordMarkup(child);

  const lexicalTag = /<\/?[A-Za-z][^>\n]*(?:>|$)/g;
  let tagMatch = lexicalTag.exec(source);
  while (tagMatch) {
    if (!locatedMarkupStarts.has(tagMatch.index)) {
      return {
        editable: false,
        reason: 'HTML source contains a tag the parser would discard or repair.',
      };
    }
    if (tagMatch[0].length === 0) lexicalTag.lastIndex += 1;
    tagMatch = lexicalTag.exec(source);
  }

  const template = ownerDocument.createElement('template');
  template.innerHTML = source;
  const walker = ownerDocument.createTreeWalker(template.content, 1);
  let node = walker.nextNode() as Element | null;

  while (node) {
    const tag = node.localName.toLowerCase();
    if (!HTML_ALLOWED_TAGS.has(tag)) {
      return {
        editable: false,
        reason: `<${tag}> is not represented by the Visual editor schema.`,
      };
    }

    const allowed = HTML_ALLOWED_ATTRIBUTES[tag] ?? new Set<string>();
    for (const attribute of Array.from(node.attributes)) {
      const name = attribute.name.toLowerCase();
      if (!allowed.has(name)) {
        return {
          editable: false,
          reason: `${name} on <${tag}> is not represented by the Visual editor schema.`,
        };
      }
      if ((name === 'href' || name === 'src') && unsafeUrl(attribute.value)) {
        return {
          editable: false,
          reason: `${name} on <${tag}> uses an active URL protocol.`,
        };
      }
      if (name === 'src' && !/^(?:data:image\/[a-z0-9.+-]+[;,]|blob:)/i.test(attribute.value)) {
        return {
          editable: false,
          reason: 'External HTML image sources require Source mode and remain network-blocked.',
        };
      }
    }
    node = walker.nextNode() as Element | null;
  }

  return { editable: true };
}
