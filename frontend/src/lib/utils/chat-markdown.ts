import { Marked, type Tokens } from 'marked';
import katex from 'katex';
import DOMPurify from 'dompurify';
import { expandHtmlSandboxes, htmlSandboxPlaceholder } from './html-sandbox';
import { renderKoryChart } from './chart-renderer';
import { renderKoryColors } from './color-renderer';

export function escapeMarkdownHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** The single KaTeX entry point for every render path. `output: 'htmlAndMathml'`
 *  keeps the MathML source that renderChatMarkdown's sanitizer must admit, and
 *  `throwOnError: false` renders malformed input instead of failing the row. */
export function renderKatex(text: string, displayMode: boolean): string {
  return katex.renderToString(text, {
    displayMode,
    throwOnError: false,
    trust: false,
    maxExpand: 200,
    maxSize: 20,
    output: 'htmlAndMathml',
  });
}

/** Isolated per consumer: mounting a feed entry must not mutate global marked. */
export function createChatMarkdown(richBlocks = true): Marked {
  const parser = new Marked({ gfm: true });
  const math = (text: string, displayMode: boolean) => renderKatex(text, displayMode);
  parser.use({
    extensions: [
      {
        name: 'chatDisplayMath',
        level: 'block',
        start: (src) => src.search(/(?:^|\n)(?:\$\$|\\\[)/),
        tokenizer(src) {
          // Stop at the first closing delimiter, even when another equation
          // or prose follows on the same line (common in pasted documents).
          // Requiring a line ending here backtracks across neighboring pairs.
          const match = /^(?:\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\])[ \t]*(?:\n|$)?/.exec(src);
          if (match)
            return { type: 'chatDisplayMath', raw: match[0], text: (match[1] ?? match[2]).trim() };
        },
        renderer: (token) => math(token.text as string, true) + '\n',
      },
      {
        name: 'chatInlineMath',
        level: 'inline',
        start: (src) => src.search(/\$|\\\(/),
        tokenizer(src) {
          const explicit = /^(?:\\\(([^\n]+?)\\\)|\$\$([^\n]+?)\$\$)/.exec(src);
          // No whitespace at the dollar boundaries; a closing dollar followed
          // by a digit is currency, not math ("$5 and $10"). Escapes and code
          // are consumed by marked before this tokenizer sees them.
          const dollar = /^\$(?![\s$])((?:\\.|[^\\$\n])+?)\$(?!\d)/.exec(src);
          if (explicit)
            return {
              type: 'chatInlineMath',
              raw: explicit[0],
              text: explicit[1] ?? explicit[2],
              display: !!explicit[2],
            };
          if (dollar && !/\s$/.test(dollar[1]))
            return { type: 'chatInlineMath', raw: dollar[0], text: dollar[1], display: false };
        },
        renderer: (token) => math(token.text as string, token.display === true),
      },
    ],
    renderer: {
      checkbox({ checked }) {
        return `<input type="checkbox" disabled class="kory-task-check"${checked ? ' checked' : ''} aria-label="${checked ? 'done' : 'to do'}">`;
      },
      table(token: Tokens.Table) {
        const header = this.tablerow({
          text: token.header.map((cell) => this.tablecell(cell)).join(''),
        });
        const body = token.rows
          .map((row) => this.tablerow({ text: row.map((cell) => this.tablecell(cell)).join('') }))
          .join('');
        return `<div class="kory-table-scroll"><table><thead>${header}</thead><tbody>${body}</tbody></table></div>`;
      },
      code({ text, lang }) {
        const language = lang?.trim().toLowerCase();
        if (language === 'math' || language === 'latex' || language === 'tex')
          return math(text, true);
        if (!richBlocks) return false;
        if (language === 'chart' || language === 'kory-chart')
          return renderKoryChart(text) || false;
        if (language === 'color' || language === 'kory-color')
          return renderKoryColors(text) || false;
        if (['html', 'kory-html', 'html-sandbox'].includes(language ?? ''))
          return htmlSandboxPlaceholder(text);
        return false;
      },
    },
  });
  return parser;
}

const defaultParser = createChatMarkdown();

/** Same sanitization boundary for drafts, user messages and every stream chunk. */
export function renderChatMarkdown(text: string, parser: Marked = defaultParser): string {
  try {
    return expandHtmlSandboxes(
      DOMPurify.sanitize(parser.parse(text, { async: false }) as string, {
        // KaTeX's MathML source is inert text, needed for accessible math and
        // copy/paste round-trips. Do not admit annotation-xml or active content.
        ADD_TAGS: ['semantics', 'annotation'],
        ADD_ATTR: ['encoding'],
      }),
    );
  } catch {
    return escapeMarkdownHtml(text);
  }
}
