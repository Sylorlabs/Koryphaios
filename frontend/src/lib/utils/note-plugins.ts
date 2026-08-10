// Notes plugin API (v1).
//
// A real, minimal plugin system for the notes preview pipeline. A plugin can:
//   • transform the raw markdown before it is parsed  (markdownTransform)
//   • transform the rendered HTML before it is shown  (htmlPostProcess)
//   • register slash commands surfaced in the notes UI  (commands)
//
// Only bundled, reviewed plugin objects are registered. Source-string loading
// is intentionally absent: evaluating note text as renderer code would cross
// the native app's trust boundary without a real plugin sandbox.

export interface NoteCommand {
  id: string;
  name: string;
  /** Return text to insert at the cursor, or void to handle it yourself. */
  run: (ctx: { selection: string }) => string | void;
}

export interface NotePlugin {
  id: string;
  name: string;
  /** Runs on the raw markdown source, before parsing. */
  markdownTransform?: (src: string) => string;
  /** Runs on the parsed HTML, before sanitization. */
  htmlPostProcess?: (html: string) => string;
  commands?: NoteCommand[];
}

export interface PluginRegistry {
  register(plugin: NotePlugin): void;
  unregister(id: string): void;
  list(): NotePlugin[];
  readonly commands: NoteCommand[];
  transformMarkdown(src: string): string;
  postProcessHtml(html: string): string;
}

export function createPluginRegistry(initial: NotePlugin[] = []): PluginRegistry {
  const plugins = new Map<string, NotePlugin>();

  const register = (plugin: NotePlugin) => {
    if (!plugin || !plugin.id) throw new Error('Plugin must have an id');
    plugins.set(plugin.id, plugin);
  };

  for (const p of initial) register(p);

  return {
    register,
    unregister: (id: string) => void plugins.delete(id),
    list: () => Array.from(plugins.values()),
    get commands() {
      return Array.from(plugins.values()).flatMap((p) => p.commands ?? []);
    },
    transformMarkdown(src: string): string {
      let out = src;
      for (const p of plugins.values()) {
        if (!p.markdownTransform) continue;
        try {
          out = p.markdownTransform(out);
        } catch (err) {
          console.warn(`[note-plugin ${p.id}] markdownTransform failed:`, err);
        }
      }
      return out;
    },
    postProcessHtml(html: string): string {
      let out = html;
      for (const p of plugins.values()) {
        if (!p.htmlPostProcess) continue;
        try {
          out = p.htmlPostProcess(out);
        } catch (err) {
          console.warn(`[note-plugin ${p.id}] htmlPostProcess failed:`, err);
        }
      }
      return out;
    },
  };
}

// ── Built-in plugins ────────────────────────────────────────────────────────

/** Obsidian-style ==highlight== → <mark>. */
export const highlightPlugin: NotePlugin = {
  id: 'builtin.highlight',
  name: 'Highlights',
  markdownTransform: (src) =>
    src.replace(/(^|[^=])==(?!=)([^\n=]+?)==(?!=)/g, (_m, pre, txt) => `${pre}<mark>${txt}</mark>`),
};

/** Strip %%Obsidian comments%% (single and multi-line) from the preview. */
export const commentPlugin: NotePlugin = {
  id: 'builtin.comments',
  name: 'Comments',
  markdownTransform: (src) => src.replace(/%%[\s\S]*?%%/g, ''),
};

/** Open external links in a new tab safely. */
export const externalLinkPlugin: NotePlugin = {
  id: 'builtin.external-links',
  name: 'External links',
  htmlPostProcess: (html) =>
    html.replace(/<a\s+([^>]*href="https?:\/\/[^"]*"[^>]*)>/gi, (m, attrs) =>
      /target=/.test(attrs) ? m : `<a ${attrs} target="_blank" rel="noreferrer">`,
    ),
};

/** Obsidian-style callouts: > [!note] Title / body → styled block. */
export const calloutPlugin: NotePlugin = {
  id: 'builtin.callouts',
  name: 'Callouts',
  markdownTransform: (src) => {
    const lines = src.split('\n');
    const out: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const head = /^>\s*\[!(\w+)\]([+-]?)\s*(.*)$/.exec(lines[i]);
      if (!head) {
        out.push(lines[i]);
        continue;
      }
      const type = head[1].toLowerCase();
      const title = head[3].trim() || type.charAt(0).toUpperCase() + type.slice(1);
      const body: string[] = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const bm = /^>\s?(.*)$/.exec(lines[j]);
        if (!bm) break;
        body.push(bm[1]);
      }
      i = j - 1;
      const bodyHtml = body
        .map((b) => b.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'))
        .join('<br>');
      out.push(
        `<div class="callout callout-${type}"><div class="callout-title">${title
          .replace(/&/g, '&amp;')
          .replace(
            /</g,
            '&lt;',
          )}</div>${bodyHtml ? `<div class="callout-body">${bodyHtml}</div>` : ''}</div>`,
      );
    }
    return out.join('\n');
  },
};

export const BUILTIN_NOTE_PLUGINS: NotePlugin[] = [
  highlightPlugin,
  commentPlugin,
  calloutPlugin,
  externalLinkPlugin,
];

/** App-wide singleton with built-ins pre-registered. */
export const notePlugins: PluginRegistry = createPluginRegistry(BUILTIN_NOTE_PLUGINS);
