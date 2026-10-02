import { parseFragment, type DefaultTreeAdapterMap } from 'parse5';

type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];
const attr = (node: Element, name: string) => node.attrs.find((a) => a.name === name)?.value ?? '';
const isElement = (node: Node): node is Element => 'tagName' in node;
const text = (node: Node): string =>
  'value' in node ? node.value : 'childNodes' in node ? node.childNodes.map(text).join('') : '';
const escapeText = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replace(/([\\`*_[\]$#>~|!+.-])/g, '\\$1')
    .replaceAll('<', '&lt;');
const ignored = new Set([
  'script',
  'style',
  'iframe',
  'object',
  'embed',
  'template',
  'button',
  'input',
  'svg',
]);

/**
 * Clipboard HTML is parsed as data, never mounted in a DOM or fetched. Recover
 * TeX annotations before discarding KaTeX's duplicate visual/accessibility trees.
 * Returns null when ordinary native text paste is the safer/lossless choice.
 */
export function richPasteToMarkdown(html: string): string | null {
  if (!html || html.length > 1_000_000) return null;
  try {
    const root = parseFragment(html);
    let structured = false;
    const findTex = (node: Element, depth = 0): string => {
      if (depth > 100) throw new Error('Clipboard nesting limit');
      if (node.tagName === 'annotation' && /(?:x-tex|latex)/i.test(attr(node, 'encoding')))
        return text(node);
      for (const child of node.childNodes) {
        if (isElement(child)) {
          const result = findTex(child, depth + 1);
          if (result) return result;
        }
      }
      return '';
    };
    const children = (node: Element, depth: number): string =>
      node.childNodes.map((child) => visit(child, depth + 1)).join('');
    const visit = (node: Node, depth = 0): string => {
      if (depth > 100) throw new Error('Clipboard nesting limit');
      if ('value' in node) return escapeText(node.value.replace(/\s+/g, ' '));
      if (!isElement(node)) return '';
      const tag = node.tagName;
      if (ignored.has(tag)) return '';
      const classes = attr(node, 'class').split(/\s+/);
      if (
        tag === 'math' ||
        classes.includes('katex') ||
        classes.includes('katex-display') ||
        attr(node, 'data-latex')
      ) {
        const tex = attr(node, 'data-latex') || findTex(node);
        if (tex) {
          structured = true;
          const display = classes.includes('katex-display') || attr(node, 'display') === 'block';
          return display ? `\n\n$$\n${tex.trim()}\n$$\n\n` : `\\(${tex.trim()}\\)`;
        }
        // Do not pretend rendered glyphs without source TeX are recoverable.
        throw new Error('Equation has no recoverable TeX');
      }
      if (tag === 'pre') {
        structured = true;
        const source = text(node);
        const fence = '`'.repeat(
          Math.max(3, ...Array.from(source.matchAll(/`+/g), (m) => m[0].length + 1)),
        );
        const code = node.childNodes.find((child) => isElement(child) && child.tagName === 'code');
        const language =
          code && isElement(code)
            ? (/(?:^|\s)language-([\w-]+)/.exec(attr(code, 'class'))?.[1] ?? '')
            : '';
        return `\n\n${fence}${language}\n${source.replace(/\n$/, '')}\n${fence}\n\n`;
      }
      if (tag === 'table') {
        structured = true;
        const rows: string[][] = [];
        const collect = (parent: Element) => {
          for (const child of parent.childNodes) {
            if (!isElement(child)) continue;
            if (child.tagName === 'tr') {
              rows.push(
                child.childNodes
                  .filter(isElement)
                  .filter((cell) => ['td', 'th'].includes(cell.tagName))
                  .map((cell) => {
                    if (
                      Number(attr(cell, 'colspan') || 1) !== 1 ||
                      Number(attr(cell, 'rowspan') || 1) !== 1
                    )
                      throw new Error('Merged table cells');
                    return children(cell, depth).trim().replace(/\n+/g, '<br>');
                  }),
              );
            } else if (['thead', 'tbody', 'tfoot'].includes(child.tagName)) collect(child);
          }
        };
        collect(node);
        if (!rows.length || !rows[0].length) return '';
        const width = Math.max(...rows.map((row) => row.length));
        const line = (row: string[]) =>
          `| ${Array.from({ length: width }, (_, i) => row[i] ?? '').join(' | ')} |`;
        return `\n\n${line(rows[0])}\n${line(Array(width).fill('---'))}\n${rows.slice(1).map(line).join('\n')}\n\n`;
      }
      if (tag === 'ul' || tag === 'ol') {
        structured = true;
        let index = Number(attr(node, 'start')) || 1;
        return (
          '\n\n' +
          node.childNodes
            .filter(isElement)
            .filter((child) => child.tagName === 'li')
            .map((li) => {
              const prefix = tag === 'ol' ? `${index++}. ` : '- ';
              return (
                prefix +
                children(li, depth)
                  .trim()
                  .replace(/\n/g, '\n' + ' '.repeat(prefix.length))
              );
            })
            .join('\n') +
          '\n\n'
        );
      }
      if (tag === 'br') return '\n';
      if (tag === 'img') return escapeText(attr(node, 'alt'));
      const content = children(node, depth);
      if (/^h[1-6]$/.test(tag)) {
        structured = true;
        return `\n\n${'#'.repeat(Number(tag[1]))} ${content.trim()}\n\n`;
      }
      if (['strong', 'b', 'em', 'i', 'del', 's'].includes(tag)) {
        structured = true;
        const marker = ['strong', 'b'].includes(tag)
          ? '**'
          : ['del', 's'].includes(tag)
            ? '~~'
            : '*';
        return `${marker}${content.trim()}${marker}`;
      }
      if (tag === 'code') {
        structured = true;
        const source = text(node);
        const fence = '`'.repeat(
          Math.max(1, ...Array.from(source.matchAll(/`+/g), (m) => m[0].length + 1)),
        );
        return `${fence} ${source} ${fence}`;
      }
      if (tag === 'a') {
        const href = attr(node, 'href');
        if (/^(https?:\/\/|mailto:)/i.test(href) && !/[\s<>]/.test(href)) {
          structured = true;
          return `[${content}](<${href.replaceAll('"', '%22')}>)`;
        }
      }
      if (tag === 'blockquote') {
        structured = true;
        return '\n\n' + content.trim().replace(/^/gm, '> ') + '\n\n';
      }
      if (['p', 'div', 'section', 'article', 'figure'].includes(tag))
        return `\n\n${content.trim()}\n\n`;
      return content;
    };
    const result = root.childNodes
      .map((node) => visit(node))
      .join('')
      .trim();
    return structured && result ? result : null;
  } catch {
    return null;
  }
}

/** Prefer converted rich content only when the clipboard actually has structure. */
export function clipboardMarkdown(data: Pick<DataTransfer, 'getData'>): string | null {
  return richPasteToMarkdown(data.getData('text/html'));
}
