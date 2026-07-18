<script lang="ts">
  import {
    MessageSquare,
    Send,
    ChevronRight,
    ChevronLeft,
    ChevronDown,
    Trash2,
    EyeOff,
    Eye,
    Copy,
    Check,
    Terminal,
    Maximize2,
    Minimize2,
    Undo,
    RotateCcw,
    X,
    Globe,
    FileText,
    Folder,
    FilePlus,
    Bot,
    Palette,
    Server,
    ShieldCheck,
    FlaskConical,
    Layers,
    AlertTriangle,
  } from 'lucide-svelte';
  import { fly, fade } from 'svelte/transition';
  import { wsStore } from '$lib/stores/websocket.svelte';
  import { sessionStore } from '$lib/stores/sessions.svelte';
  import { projectStore } from '$lib/stores/project.svelte';
  import { authStore } from '$lib/stores/auth.svelte';
  import AnimatedStatusIcon from './AnimatedStatusIcon.svelte';
  import ThinkingBlock from './ThinkingBlock.svelte';
  import { agentSettingsStore } from '$lib/stores/agent-settings.svelte';
  import { marked } from 'marked';
  import DOMPurify from 'dompurify';
  import hljs from 'highlight.js/lib/core';
  import bash from 'highlight.js/lib/languages/bash';
  import cpp from 'highlight.js/lib/languages/cpp';
  import css from 'highlight.js/lib/languages/css';
  import diff from 'highlight.js/lib/languages/diff';
  import go from 'highlight.js/lib/languages/go';
  import java from 'highlight.js/lib/languages/java';
  import javascript from 'highlight.js/lib/languages/javascript';
  import json from 'highlight.js/lib/languages/json';
  import markdown from 'highlight.js/lib/languages/markdown';
  import python from 'highlight.js/lib/languages/python';
  import rust from 'highlight.js/lib/languages/rust';
  import scss from 'highlight.js/lib/languages/scss';
  import sql from 'highlight.js/lib/languages/sql';
  import typescript from 'highlight.js/lib/languages/typescript';
  import xml from 'highlight.js/lib/languages/xml';
  import yaml from 'highlight.js/lib/languages/yaml';
  import 'highlight.js/styles/atom-one-dark.css';
  import type { FeedEntryLocal, FeedEntryType } from '$lib/types';
  import type { Note } from '@koryphaios/shared';
  import { apiFetch } from '$lib/api.svelte';
  import { apiUrl } from '$lib/utils/api-url';
  import { renderKoryChart } from '$lib/utils/chart-renderer';

  hljs.registerLanguage('bash', bash);
  hljs.registerLanguage('cpp', cpp);
  hljs.registerLanguage('css', css);
  hljs.registerLanguage('diff', diff);
  hljs.registerLanguage('go', go);
  hljs.registerLanguage('java', java);
  hljs.registerLanguage('javascript', javascript);
  hljs.registerLanguage('json', json);
  hljs.registerLanguage('markdown', markdown);
  hljs.registerLanguage('python', python);
  hljs.registerLanguage('rust', rust);
  hljs.registerLanguage('scss', scss);
  hljs.registerLanguage('sql', sql);
  hljs.registerLanguage('typescript', typescript);
  hljs.registerLanguage('xml', xml);
  hljs.registerLanguage('yaml', yaml);

  const languageAliases: Record<string, string> = {
    c: 'cpp',
    h: 'cpp',
    hpp: 'cpp',
    html: 'xml',
    js: 'javascript',
    jsx: 'javascript',
    md: 'markdown',
    py: 'python',
    rs: 'rust',
    sh: 'bash',
    ts: 'typescript',
    tsx: 'typescript',
    yml: 'yaml',
  };

  // ── Wikilink extension: [[Note Title]] → clickable link ─────────────────
  const wikilinkExtension = {
    name: 'wikilink',
    level: 'inline' as const,
    start(src: string) {
      return src.indexOf('[[');
    },
    tokenizer(src: string) {
      const match = /^\[\[([^\]|#]+?)(?:\|([^\]]+?))?\]\]/.exec(src);
      if (match) {
        return {
          type: 'wikilink',
          raw: match[0],
          title: match[1].trim(),
          display: match[2]?.trim() ?? match[1].trim(),
        };
      }
    },
    renderer(token: { title: string; display: string }) {
      const safe = token.title.replace(/'/g, "\\'");
      return `<a class="wikilink" data-note-title="${token.title}" href="#" onclick="event.preventDefault();window.openNoteByTitle('${safe}')">${token.display}</a>`;
    },
  };

  marked.use({ extensions: [wikilinkExtension] });

  // Global handler: dispatches 'open-note' event so the Notes panel can intercept
  if (typeof window !== 'undefined') {
    (window as unknown as Record<string, unknown>).openNoteByTitle = (title: string) => {
      window.dispatchEvent(new CustomEvent('open-note', { detail: { title } }));
    };
  }

  // Shared renderer configuration
  const renderer = new marked.Renderer();
  const renderTable = renderer.table.bind(renderer);
  renderer.table = (token) => `<div class="kory-table-scroll">${renderTable(token)}</div>`;
  renderer.code = ({ text, lang }: { text: string; lang?: string }) => {
    const requestedLanguage = lang?.trim().toLowerCase();
    if (requestedLanguage === 'chart' || requestedLanguage === 'kory-chart') {
      const chart = renderKoryChart(text);
      if (chart) return chart;
    }
    const language = requestedLanguage
      ? hljs.getLanguage(requestedLanguage)
        ? requestedLanguage
        : languageAliases[requestedLanguage]
      : undefined;
    const highlighted = language
      ? hljs.highlight(text, { language }).value
      : hljs.highlightAuto(text).value;
    return `<pre><code class="hljs language-${language ?? 'plaintext'}">${highlighted}</code></pre>`;
  };
  /** For view_image tool results: the viewed image's absolute path, or null. */
  function viewImagePath(meta?: Record<string, unknown>): string | null {
    const tr = meta?.toolResult as
      | { name?: string; output?: string; isError?: boolean }
      | undefined;
    if (!tr || tr.name !== 'view_image' || tr.isError) return null;
    try {
      const parsed = JSON.parse(tr.output ?? '') as { path?: string };
      return parsed.path ?? null;
    } catch {
      return null;
    }
  }

  /** Local/relative image paths route through the authed backend renderer. */
  function rawImageUrl(path: string): string {
    const auth = authStore.token ? `&auth=${encodeURIComponent(authStore.token)}` : '';
    return apiUrl(`/api/workspace/raw?path=${encodeURIComponent(path)}${auth}`);
  }
  renderer.image = ({ href, text }: { href?: string | null; text?: string | null }) => {
    let src = href ?? '';
    if (src && !/^(https?:|data:|blob:)/i.test(src)) {
      const base = (projectStore.currentPath ?? '').replace(/[/\\]+$/, '');
      const abs = src.startsWith('/') ? src : base ? `${base}/${src.replace(/^\.\//, '')}` : src;
      src = rawImageUrl(abs);
    }
    const alt = (text ?? '').replace(/"/g, '&quot;');
    return `<img src="${src}" alt="${alt}" loading="lazy" style="max-width:100%;max-height:420px;border-radius:12px;margin:8px 0;display:block;" />`;
  };
  marked.setOptions({ renderer });

  let {
    entry,
    isSelected,
    isExpanded,
    isStreaming = false,
    onSelect,
    onToggleGroup,
    onDelete,
  } = $props<{
    entry: FeedEntryLocal;
    isSelected: boolean;
    isExpanded: boolean;
    isStreaming?: boolean;
    onSelect: (e: MouseEvent) => void;
    onToggleGroup: () => void;
    onDelete: (e: MouseEvent) => void;
  }>();

  let copied = $state(false);
  let regenerating = $state(false);
  let selectedVariant = $state(-1);
  let expandedTerminal = $state(false);
  let zoomedImage = $state<string | null>(null);
  // Zoom for backend-served images (view_image results) — a URL, not base64.
  let zoomedRawImage = $state<string | null>(null);
  let renderedNotes = $state<Record<string, Note | null>>({});
  const pendingNoteRenders = new Set<string>();
  let responseVariants = $derived(
    (entry.metadata?.responseVariants as
      | Array<{ id: string; content: string; model?: string; index: number }>
      | undefined) ?? [],
  );
  let currentText = $derived(
    selectedVariant >= 0 && responseVariants[selectedVariant]
      ? responseVariants[selectedVariant].content
      : entry.text,
  );

  $effect(() => {
    if (entry.type === 'content' && selectedVariant < 0 && responseVariants.length > 0) {
      selectedVariant = responseVariants.length - 1;
    }
  });

  async function regenerateResponse() {
    const sessionId = entry.metadata?.sessionId as string | undefined;
    const messageId = entry.metadata?.messageId as string | undefined;
    if (!sessionId || !messageId || regenerating) return;
    regenerating = true;
    const startedAt = Date.now();
    try {
      const response = await apiFetch(apiUrl('/api/messages/regenerate'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, messageId, model: entry.metadata?.model }),
      });
      const result = (await response.json()) as {
        ok?: boolean;
        error?: string;
        data?: { groupId: string; index: number };
      };
      if (!response.ok || !result.ok || !result.data)
        throw new Error(result.error || 'Regeneration failed');
      for (let attempt = 0; attempt < 180; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const messages = await sessionStore.fetchMessages(sessionId);
        const completed = messages.some(
          (message) =>
            message.variantGroupId === result.data!.groupId &&
            message.variantIndex === result.data!.index,
        );
        const returnedEmpty = messages.some(
          (message) =>
            message.role === 'system' &&
            message.createdAt >= startedAt &&
            message.content ===
              'The model returned an empty response. Please resend or rephrase your request.',
        );
        if (completed || returnedEmpty) {
          await wsStore.loadSessionMessages(sessionId, messages);
          return;
        }
      }
      throw new Error('Regeneration timed out');
    } catch (error) {
      console.error('Failed to regenerate response:', error);
    } finally {
      regenerating = false;
    }
  }

  // Archive id set by the backend for tool outputs — enables the three
  // visibility modes (hide-from-agent / hide-from-me / delete).
  let archiveId = $derived(
    (entry.metadata as { toolResult?: { archiveId?: string } } | undefined)?.toolResult
      ?.archiveId ?? null,
  );

  async function setAgentHidden(e: MouseEvent, hidden: boolean) {
    e.stopPropagation();
    if (!archiveId) return;
    const sid = sessionStore.activeSessionId;
    if (!sid) return;
    try {
      await apiFetch(apiUrl(`/api/sessions/${sid}/context/${archiveId}/visibility`), {
        method: 'POST',
        body: JSON.stringify({ hiddenFromAgent: hidden }),
      });
      wsStore.setEntryVisibility(entry.id, { agentHidden: hidden });
    } catch (err) {
      console.error('Failed to update agent context visibility:', err);
    }
  }

  function toggleUserHidden(e: MouseEvent) {
    e.stopPropagation();
    wsStore.setEntryVisibility(entry.id, { userHidden: !entry.userHidden });
  }

  async function copyToClipboard() {
    try {
      await navigator.clipboard.writeText(currentText);
      copied = true;
      setTimeout(() => {
        copied = false;
      }, 2000);
    } catch (err) {
      console.error('Failed to copy text: ', err);
    }
  }

  // ── Streaming text: render arriving tokens as chunks that fade from
  // translucent to full opacity — text "settles" as it lands. ──
  let streamChunks = $state<Array<{ id: number; text: string }>>([]);
  let chunkCounter = 0;
  let lastStreamText = '';

  $effect(() => {
    if (!(isStreaming && entry.type === 'content')) {
      if (streamChunks.length) {
        streamChunks = [];
        lastStreamText = '';
      }
      return;
    }
    const t = currentText;
    if (t === lastStreamText) return;
    if (t.startsWith(lastStreamText)) {
      const delta = t.slice(lastStreamText.length);
      if (delta) streamChunks = [...streamChunks, { id: chunkCounter++, text: delta }];
    } else {
      streamChunks = [{ id: chunkCounter++, text: t }];
    }
    lastStreamText = t;
  });

  // Debounced markdown parsing for performance
  let debouncedText = $state('');
  let timer: ReturnType<typeof setTimeout>;

  $effect(() => {
    // If the text is short or not streaming (no cursor/status check available here easily, so we just check length diff),
    // we can update immediately. But for safety during streaming, we debounce.
    // If the text has changed:
    if (currentText !== debouncedText) {
      clearTimeout(timer);
      timer = setTimeout(() => {
        debouncedText = currentText;
      }, 32); // 32ms debounce for smoother streaming
    }
    return () => clearTimeout(timer);
  });

  // While streaming, render plain text — markdown parse only after stream completes
  let noteRenderIds = $derived.by(() => {
    const ids: string[] = [];
    for (const match of debouncedText.matchAll(/\{\{render_note:([^}\s]+)\}\}/g))
      ids.push(match[1]);
    return [...new Set(ids)];
  });

  $effect(() => {
    for (const id of noteRenderIds) {
      if (Object.hasOwn(renderedNotes, id) || pendingNoteRenders.has(id)) continue;
      pendingNoteRenders.add(id);
      void apiFetch(apiUrl(`/api/notes/${encodeURIComponent(id)}`))
        .then(async (response) => {
          const data = await response.json();
          renderedNotes = {
            ...renderedNotes,
            [id]: response.ok && data.ok ? (data.data as Note) : null,
          };
        })
        .catch(() => {
          renderedNotes = { ...renderedNotes, [id]: null };
        })
        .finally(() => pendingNoteRenders.delete(id));
    }
  });

  function sandboxedHtml(content: string): string {
    const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:; media-src data: blob:; form-action 'none'; base-uri 'none'">`;
    return /<head[\s>]/i.test(content)
      ? content.replace(/<head([^>]*)>/i, `<head$1>${csp}`)
      : `${csp}${content}`;
  }

  function renderedMarkdown(content: string): string {
    return DOMPurify.sanitize(marked.parse(content, { async: false }) as string);
  }

  let parsedHtml = $derived.by(() => {
    if (!debouncedText) return '';
    if (isStreaming) return '';
    try {
      const withoutRenderDirectives = debouncedText
        .replace(/\{\{render_note:[^}\s]+\}\}/g, '')
        .trim();
      return DOMPurify.sanitize(marked.parse(withoutRenderDirectives, { async: false }) as string);
    } catch {
      return debouncedText;
    }
  });

  function getEntryColor(type: FeedEntryType): string {
    switch (type) {
      case 'user_message':
        return 'text-accent font-medium';
      case 'thought':
        return 'text-yellow-400';
      case 'content':
        return 'text-text-primary';
      case 'thinking':
        return 'text-blue-400/70';
      case 'tool_call':
        return 'text-accent';
      case 'tool_result':
        return isToolError(entry.metadata) ? 'text-red-300' : 'text-green-400';
      case 'routing':
        return 'text-yellow-300';
      case 'error':
        return 'text-red-400';
      case 'system':
        return 'text-text-muted';
      case 'tool_group':
        return 'text-blue-400 font-medium italic';
      case 'agent_group':
        return 'text-purple-400 font-medium';
      default:
        return 'text-text-secondary';
    }
  }

  function isToolError(meta?: Record<string, unknown>): boolean {
    return Boolean(
      (meta as { toolResult?: { isError?: boolean } } | undefined)?.toolResult?.isError,
    );
  }

  type ToolCategory = 'bash' | 'read' | 'write' | 'web' | 'search' | 'other';

  // Analyzing/reading → eyeball. Editing/writing → pencil. Names cover both
  // Koryphaios tools and CLI-harness tool names (grok/claude-code/antigravity).
  const READ_TOOLS = new Set(['read_file', 'read', 'view_file', 'view_image', 'read_note']);
  // Search/find tools → always an inline magnifier, never the terminal box.
  const SEARCH_TOOLS = new Set([
    'grep',
    'grep_search',
    'glob',
    'glob_search',
    'ls',
    'list_directory',
    'find',
    'search_notes',
    'recall_notes',
    'get_note_backlinks',
    'codebase_search',
  ]);
  const WRITE_TOOLS = new Set([
    'write_file',
    'write',
    'write_to_file',
    'edit_file',
    'edit',
    'str_replace',
    'batch_edit',
    'multi_replace_file_content',
    'replace_file_content',
    'patch',
    'apply_patch',
    'diff',
    'delete_file',
    'move_file',
    'create_note',
    'update_note',
  ]);
  const WEB_TOOLS = new Set(['web_search', 'web_fetch']);
  const BASH_TOOLS = new Set([
    'bash',
    'shell',
    'shell_manage',
    'run_terminal_command',
    'run_command',
    'terminal',
  ]);

  function getToolNameFromMeta(meta?: Record<string, unknown>): string {
    const m = meta as { toolCall?: { name?: string }; toolResult?: { name?: string } } | undefined;
    return (m?.toolCall?.name ?? m?.toolResult?.name ?? '').toLowerCase();
  }

  function getToolCategory(meta?: Record<string, unknown>): ToolCategory {
    const name = getToolNameFromMeta(meta);
    if (WEB_TOOLS.has(name)) return 'web';
    if (SEARCH_TOOLS.has(name) || /grep|glob|search|find|list_dir/i.test(name)) return 'search';
    if (BASH_TOOLS.has(name)) return 'bash';
    if (READ_TOOLS.has(name)) return 'read';
    if (WRITE_TOOLS.has(name)) return 'write';
    return 'other';
  }

  interface ToolDisplay {
    label: string;
    resultLabel: string;
    colorClass: string;
  }

  function getToolDisplay(category: ToolCategory): ToolDisplay {
    switch (category) {
      case 'read':
        return { label: 'Reading File', resultLabel: 'File Contents', colorClass: 'text-cyan-400' };
      case 'write':
        return { label: 'Editing File', resultLabel: 'File Written', colorClass: 'text-amber-400' };
      case 'web':
        return { label: 'Searching Web', resultLabel: 'Web Results', colorClass: 'text-sky-400' };
      case 'bash':
        return {
          label: 'Executing Command',
          resultLabel: 'Terminal Output',
          colorClass: 'text-emerald-400',
        };
      default:
        return {
          label: 'Running Tool',
          resultLabel: 'Tool Output',
          colorClass: 'text-emerald-400',
        };
    }
  }

  function getToolShortLabel(meta?: Record<string, unknown>): string {
    const m = meta as
      | {
          toolCall?: { name?: string; input?: Record<string, unknown> };
          toolResult?: { name?: string };
        }
      | undefined;
    const name = (m?.toolCall?.name ?? m?.toolResult?.name ?? '').toLowerCase();
    const input = (m?.toolCall?.input ?? {}) as Record<string, unknown>;
    const rawPath = (input.path ??
      input.file_path ??
      input.filepath ??
      input.target_file ??
      '') as string;
    const base = rawPath ? (rawPath.split('/').pop() ?? rawPath) : '';
    switch (name) {
      case 'read_file':
        return base || rawPath;
      case 'write_file':
      case 'edit_file':
      case 'delete_file':
        return base || rawPath;
      case 'move_file': {
        const src = ((input.source ?? input.src ?? '') as string).split('/').pop() ?? '';
        const dst = ((input.dest ?? input.destination ?? '') as string).split('/').pop() ?? '';
        return src && dst ? `${src} → ${dst}` : name;
      }
      case 'read':
      case 'view_file':
      case 'write':
      case 'edit':
      case 'str_replace':
        return base || rawPath;
      case 'grep':
      case 'grep_search': {
        const pat = (input.pattern ?? input.regex ?? input.query ?? '') as string;
        return base ? `"${pat}" in ${base}` : `"${pat}"`;
      }
      case 'glob':
        return (input.pattern ?? '') as string;
      case 'batch_edit': {
        const files = (input.files ?? []) as Array<{ path?: string }>;
        return files.length === 1
          ? ((files[0]?.path ?? '').split('/').pop() ?? '')
          : `${files.length} files`;
      }
      case 'ls':
        return base || '.';
      case 'patch':
      case 'diff':
        return base || name;
      default:
        return name;
    }
  }

  function getToolVerb(meta?: Record<string, unknown>): string {
    const m = meta as { toolCall?: { name?: string }; toolResult?: { name?: string } } | undefined;
    const name = (m?.toolCall?.name ?? m?.toolResult?.name ?? '').toLowerCase();
    switch (name) {
      case 'read_file':
      case 'read':
      case 'view_file':
        return 'read';
      case 'view_image':
        return 'viewed';
      case 'write_file':
      case 'write':
      case 'write_to_file':
        return 'write';
      case 'edit_file':
      case 'edit':
      case 'str_replace':
        return 'edit';
      case 'batch_edit':
      case 'multi_replace_file_content':
        return 'batch edit';
      case 'delete_file':
        return 'delete';
      case 'move_file':
        return 'move';
      case 'grep':
      case 'grep_search':
        return 'grep';
      case 'glob':
      case 'glob_search':
        return 'glob';
      case 'ls':
      case 'list_directory':
        return 'list';
      case 'find':
        return 'find';
      case 'search_notes':
      case 'recall_notes':
        return 'search notes';
      case 'patch':
      case 'apply_patch':
        return 'patch';
      case 'diff':
        return 'diff';
    }
    if (/grep/i.test(name)) return 'grep';
    if (/glob|find/i.test(name)) return 'find';
    if (/search/i.test(name)) return 'search';
    return name || 'tool';
  }

  const DOMAIN_STYLES: Record<string, { color: string; label: string }> = {
    frontend: { color: 'text-sky-400', label: 'Frontend' },
    ui: { color: 'text-sky-400', label: 'UI' },
    backend: { color: 'text-emerald-400', label: 'Backend' },
    review: { color: 'text-amber-400', label: 'Review' },
    critic: { color: 'text-amber-400', label: 'Critic' },
    test: { color: 'text-fuchsia-400', label: 'Test' },
    general: { color: 'text-purple-400', label: 'Agent' },
  };
  function agentDomain(meta?: Record<string, unknown>): string {
    return (meta?.domain as string) ?? 'general';
  }
  function domainStyle(meta?: Record<string, unknown>) {
    return DOMAIN_STYLES[agentDomain(meta)] ?? DOMAIN_STYLES.general;
  }
  const DOMAIN_ICONS: Record<string, typeof Bot> = {
    frontend: Palette,
    ui: Palette,
    backend: Server,
    review: ShieldCheck,
    critic: ShieldCheck,
    test: FlaskConical,
    general: Bot,
  };
  function domainIcon(meta?: Record<string, unknown>): typeof Bot {
    return DOMAIN_ICONS[agentDomain(meta)] ?? Bot;
  }

  function getWebQuery(meta?: Record<string, unknown>): string {
    const m = meta as { toolCall?: { input?: Record<string, unknown> } } | undefined;
    const i = m?.toolCall?.input ?? {};
    return (i.query ?? i.q ?? i.search ?? i.url ?? '') as string;
  }

  function getBashCommand(meta?: Record<string, unknown>): string {
    const m = meta as { toolCall?: { input?: Record<string, unknown> } } | undefined;
    const input = m?.toolCall?.input;
    const command =
      input?.command ??
      input?.cmd ??
      input?.commandLine ??
      input?.command_line ??
      input?.script ??
      input?.shell_command;
    return typeof command === 'string' ? command : '';
  }

  function getToolCallDetail(meta?: Record<string, unknown>): string {
    const m = meta as { toolCall?: { name?: string; input?: Record<string, unknown> } } | undefined;
    const input = m?.toolCall?.input;
    if (!input || Object.keys(input).length === 0) return currentText;
    const command = getBashCommand(meta);
    if (command) return `$ ${command}`;
    try {
      return JSON.stringify(input, null, 2);
    } catch {
      return currentText;
    }
  }

  function getStatusForType(
    type: FeedEntryType,
    meta?: Record<string, unknown>,
  ): import('@koryphaios/shared').AgentStatus {
    switch (type) {
      case 'user_message':
        return 'idle';
      case 'thought': {
        // Kory status lines ("Analyzing…", "Routing…") are NOT model
        // reasoning — the icon must match the actual activity, never the
        // thinking bulb. The bulb is reserved for type 'thinking'.
        const phase = meta?.phase as string | undefined;
        if (phase === 'routing') return 'verifying';
        if (phase === 'synthesizing') return 'streaming';
        return 'analyzing';
      }
      case 'content':
        return 'streaming';
      case 'thinking':
        return 'thinking';
      case 'tool_call': {
        const cat = getToolCategory(meta);
        if (cat === 'read') return 'reading';
        if (cat === 'write') return 'writing';
        if (cat === 'web') return 'searching';
        if (cat === 'search') return 'verifying';
        if (cat === 'bash') return 'tool_calling';
        return 'analyzing';
      }
      case 'tool_result':
        return isToolError(meta) ? 'error' : 'done';
      case 'routing':
        return 'verifying';
      case 'error':
        return 'error';
      case 'system':
        return 'idle';
      case 'tool_group':
        return 'reading';
      case 'agent_group':
        return 'tool_calling';
      default:
        return 'idle';
    }
  }
</script>

<div
  class="flex flex-col group"
  in:fly={{ y: 20, duration: Date.now() - entry.timestamp < 5000 ? 300 : 0 }}
  style="content-visibility: auto; contain-intrinsic-size: 80px;"
>
  {#if entry.userHidden}
    <button
      type="button"
      class="flex items-center gap-2 py-1 px-[var(--space-md)] -mx-[var(--space-md)] rounded text-[11px] opacity-40 hover:opacity-80 transition-opacity text-left"
      style="color: var(--color-text-muted);"
      onclick={toggleUserHidden}
      title="Hidden from your view — click to show (agent still has it unless also hidden from agent)"
    >
      <EyeOff size={11} />
      <span class="truncate">Hidden — {entry.type.replace('_', ' ')} (click to show)</span>
    </button>
  {:else}
    <div
      class="flex items-start gap-[var(--space-md)] py-[var(--space-sm)] text-sm leading-relaxed rounded px-[var(--space-md)] -mx-[var(--space-md)] transition-all cursor-default
           {isSelected
        ? 'bg-[var(--color-accent)]/10 ring-1 ring-[var(--color-accent)]/30'
        : 'hover:bg-surface-2/30'}"
      onclick={(e) =>
        entry.type === 'tool_group' || entry.type === 'agent_group' ? onToggleGroup() : onSelect(e)}
      onkeydown={(e) => {
        if (e.key === 'Enter' || e.key === ' ')
          entry.type === 'tool_group' || entry.type === 'agent_group'
            ? onToggleGroup()
            : onSelect(e as unknown as MouseEvent);
      }}
      role="row"
      tabindex="0"
    >
      <span class="text-xs text-text-muted shrink-0 w-16 leading-6 tabular-nums">
        {new Date(entry.timestamp).toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        })}
      </span>

      {#if entry.type === 'user_message'}
        <div class="shrink-0 flex items-center justify-center w-5 h-6">
          <Send size={14} class="text-accent" />
        </div>
      {:else if entry.type === 'tool_group'}
        <div class="shrink-0 flex items-center justify-center w-5 h-6">
          {#if isExpanded}
            <ChevronDown size={14} class="text-blue-400" />
          {:else}
            <ChevronRight size={14} class="text-blue-400" />
          {/if}
        </div>
      {:else if entry.type === 'agent_group'}
        {@const ds = domainStyle(entry.metadata)}
        {@const DIcon = domainIcon(entry.metadata)}
        <div class="shrink-0 flex items-center gap-1 h-6">
          {#if isExpanded}
            <ChevronDown size={14} class={ds.color} />
          {:else}
            <ChevronRight size={14} class={ds.color} />
          {/if}
          <DIcon size={13} class={ds.color} />
        </div>
      {:else}
        <div class="shrink-0 flex items-center justify-center w-5 h-6">
          <AnimatedStatusIcon
            status={getStatusForType(entry.type, entry.metadata)}
            size={14}
            isManager={entry.agentId === 'kory-manager'}
          />
        </div>
      {/if}

      <div class="flex-1 min-w-0 {entry.type === 'content' ? 'markdown-content' : ''}">
        {#if entry.metadata?.sourceProvider === 'antigravity' && (entry.type === 'tool_call' || entry.type === 'tool_result')}
          <span
            class="mb-1 inline-flex rounded-full border border-sky-400/20 bg-sky-400/5 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-sky-400"
            >Antigravity · real CLI logs</span
          >
        {/if}
        {#if entry.agentHidden}
          <span
            class="inline-flex items-center gap-1 mr-2 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider bg-amber-400/10 text-amber-400"
            title="This is stubbed out of the agent's context (recoverable via fetch_context)"
          >
            <Bot size={9} /> hidden from agent
          </span>
        {/if}
        <!-- The agent name only appears when the agent is actually saying
           something — tool calls, results, and reasoning stay unlabeled to
           keep the feed compact. -->
        {#if (entry.type === 'user_message' || entry.type === 'content' || entry.type === 'thought' || entry.type === 'error') && entry.agentName}
          <span
            class="text-xs font-semibold tracking-wide {entry.glowClass === 'glow-kory'
              ? 'text-yellow-400'
              : entry.type === 'user_message'
                ? 'text-accent'
                : 'text-text-secondary'}"
          >
            {entry.agentName}
          </span>
        {/if}
        {#if entry.type === 'thinking'}
          <ThinkingBlock
            text={currentText}
            durationMs={entry.durationMs}
            thinkingStartedAt={entry.thinkingStartedAt}
            agentName={entry.agentName}
            defaultExpanded={agentSettingsStore.settings.reasoningExpandedByDefault ?? true}
            finalized={entry.thinkingFinalized ?? false}
          />
        {:else if entry.type === 'tool_result' && viewImagePath(entry.metadata)}
          {@const imgPath = viewImagePath(entry.metadata)!}
          <div class="mt-1 flex flex-col gap-1">
            <div class="flex items-center gap-1.5 text-[11px]">
              <span class="opacity-40 font-medium text-text-secondary">Viewed image</span>
              <span class="text-text-muted opacity-50 truncate max-w-xs" title={imgPath}
                >{imgPath.split('/').pop()}</span
              >
            </div>
            <button
              type="button"
              class="self-start rounded-xl overflow-hidden border transition-transform hover:scale-[1.02]"
              style="border-color: var(--color-border); max-width: min(420px, 100%); cursor: zoom-in;"
              onclick={(e) => {
                e.stopPropagation();
                zoomedRawImage = imgPath;
              }}
            >
              <img
                src={rawImageUrl(imgPath)}
                alt={imgPath}
                loading="lazy"
                class="block w-full h-auto"
              />
            </button>
          </div>
        {:else if entry.type === 'tool_call' || entry.type === 'tool_result'}
          {@const toolCat = getToolCategory(entry.metadata)}
          {@const toolDisplay = getToolDisplay(toolCat)}
          {@const toolFailed = entry.type === 'tool_result' && isToolError(entry.metadata)}
          {@const isSimple = toolCat === 'read' || toolCat === 'write'}
          {#if toolFailed}
            <section
              class="mt-1 overflow-hidden rounded-lg border"
              style="border-color: var(--color-error); background: color-mix(in srgb, var(--color-error) 8%, var(--color-surface-2));"
            >
              <div
                class="flex items-center gap-2 border-b px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest text-red-400"
                style="border-color: color-mix(in srgb, var(--color-error) 35%, transparent);"
              >
                <AlertTriangle size={12} />
                <span>{getToolNameFromMeta(entry.metadata) || 'Tool'} failed</span>
                {#if entry.metadata?.sourceProvider}<span
                    class="ml-auto font-mono font-normal normal-case opacity-60"
                    >{entry.metadata.sourceProvider}</span
                  >{/if}
              </div>
              <pre
                class="max-h-80 overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-[12px] leading-relaxed text-red-200">{currentText ||
                  'The tool failed without returning diagnostic output.'}</pre>
            </section>
          {:else if toolCat === 'search'}
            {@const label = getToolShortLabel(entry.metadata)}
            <div class="mt-0.5 flex items-center gap-1.5 text-[11px]">
              <span class="opacity-40 font-medium text-text-secondary"
                >{getToolVerb(entry.metadata)}</span
              >
              {#if label}<span class="text-text-muted opacity-60 truncate max-w-md font-mono"
                  >{label}</span
                >{/if}
            </div>
          {:else if toolCat === 'web'}
            {@const q = getWebQuery(entry.metadata)}
            {@const searching = entry.type === 'tool_call'}
            <div
              class="mt-1 flex items-center gap-2.5 rounded-xl border px-3 py-2"
              style="border-color: rgba(56,189,248,0.28); background: rgba(56,189,248,0.06);"
            >
              <Globe size={15} class="shrink-0 text-sky-400 {searching ? 'globe-spin' : ''}" />
              <div class="min-w-0 flex-1">
                <div class="text-[10px] font-bold uppercase tracking-widest text-sky-400/80">
                  {searching ? 'Searching the web' : 'Web results'}
                </div>
                {#if q}
                  <div class="truncate text-[12px] text-[var(--color-text-secondary)]">{q}</div>
                {/if}
              </div>
            </div>
          {:else if isSimple}
            {#if entry.type === 'tool_call'}
              <div class="mt-0.5 flex items-center gap-1.5 text-[11px]">
                <span class="opacity-40 font-medium text-text-secondary"
                  >{getToolVerb(entry.metadata)}</span
                >
                <span class="text-text-muted opacity-50 truncate max-w-xs"
                  >{getToolShortLabel(entry.metadata)}</span
                >
              </div>
            {/if}
          {:else}
            <div class="mt-1 flex flex-col gap-2">
              <div
                class="rounded-lg border overflow-hidden transition-all"
                style="border-color: {toolFailed
                  ? 'var(--color-error)'
                  : 'var(--color-border)'}; background: {toolFailed
                  ? 'color-mix(in srgb, var(--color-error) 8%, var(--color-surface-2))'
                  : 'var(--color-surface-2)'}; {expandedTerminal
                  ? 'max-height: 1000px;'
                  : 'max-height: 120px;'}"
              >
                <div
                  class="flex items-center justify-between px-3 py-1.5 bg-[var(--color-surface-3)] border-b border-[var(--color-border)]"
                >
                  <div class="flex items-center gap-2 min-w-0 flex-1 overflow-hidden">
                    <div
                      class="flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest {toolFailed
                        ? 'text-red-400'
                        : toolDisplay.colorClass} shrink-0"
                    >
                      {#if toolFailed}<AlertTriangle
                          size={12}
                        />{:else if toolCat === 'bash'}<Terminal size={12} />{/if}
                      <span
                        >{toolFailed
                          ? `${getToolNameFromMeta(entry.metadata) || 'Tool'} failed`
                          : entry.type === 'tool_call'
                            ? toolDisplay.label
                            : toolDisplay.resultLabel}</span
                      >
                    </div>
                    {#if toolCat === 'bash'}
                      {@const cmd = getBashCommand(entry.metadata)}
                      {#if cmd}
                        <span
                          class="font-mono text-[11px] truncate opacity-60"
                          style="color: var(--color-text-secondary);">$ {cmd}</span
                        >
                      {/if}
                    {/if}
                  </div>
                  <button
                    type="button"
                    class="p-1 hover:bg-[var(--color-surface-4)] rounded transition-colors text-[var(--color-text-muted)]"
                    onclick={(e) => {
                      e.stopPropagation();
                      expandedTerminal = !expandedTerminal;
                    }}
                  >
                    {#if expandedTerminal}
                      <Minimize2 size={12} />
                    {:else}
                      <Maximize2 size={12} />
                    {/if}
                  </button>
                </div>
                <div
                  class="p-3 {toolCat === 'bash'
                    ? 'font-mono'
                    : ''} text-[12px] leading-relaxed break-words whitespace-pre-wrap {getEntryColor(
                    entry.type,
                  )} overflow-y-auto"
                  style={expandedTerminal ? 'max-height: 800px;' : 'max-height: 80px;'}
                >
                  {entry.type === 'tool_call' ? getToolCallDetail(entry.metadata) : currentText}
                </div>
              </div>
            </div>
          {/if}
        {:else if entry.type === 'user_message' || entry.type === 'content' || entry.type === 'thought'}
          <div class="{getEntryColor(entry.type)} break-words mt-1 markdown-content">
            {#if isStreaming && entry.type === 'content'}
              <span class="whitespace-pre-wrap"
                >{#each streamChunks as c (c.id)}<span class="stream-chunk">{c.text}</span
                  >{/each}</span
              >
            {:else if isStreaming}
              {currentText}
            {:else}
              {@html parsedHtml}
            {/if}
          </div>

          {#if !isStreaming && noteRenderIds.length > 0}
            <div class="mt-3 space-y-3">
              {#each noteRenderIds as noteId (noteId)}
                {@const note = renderedNotes[noteId]}
                <section
                  class="overflow-hidden rounded-xl border"
                  style="border-color: var(--color-border); background: var(--color-surface-1);"
                >
                  {#if note === undefined}
                    <div class="px-4 py-3 text-xs" style="color: var(--color-text-muted);">
                      Loading rendered note…
                    </div>
                  {:else if note === null}
                    <div class="px-4 py-3 text-xs text-red-400">Unable to render this note.</div>
                  {:else}
                    <div
                      class="flex items-center gap-2 border-b px-4 py-2"
                      style="border-color: var(--color-border);"
                    >
                      <FileText size={12} style="color: var(--color-accent);" />
                      <span class="text-xs font-semibold" style="color: var(--color-text-primary);"
                        >{note.title}</span
                      >
                      {#if note.sourcePath}<span
                          class="ml-auto truncate font-mono text-[10px]"
                          style="color: var(--color-text-muted);">{note.sourcePath}</span
                        >{/if}
                    </div>
                    {#if note.format === 'html'}
                      <iframe
                        class="h-[480px] w-full border-0 bg-white"
                        title={`Rendered ${note.title}`}
                        sandbox=""
                        referrerpolicy="no-referrer"
                        srcdoc={sandboxedHtml(note.content)}
                      ></iframe>
                    {:else}
                      <div
                        class="markdown-content max-h-[520px] overflow-auto px-5 py-4"
                        style="color: var(--color-text-primary);"
                      >
                        {@html renderedMarkdown(note.content)}
                      </div>
                    {/if}
                  {/if}
                </section>
              {/each}
            </div>
          {/if}

          {#if entry.metadata?.attachments && Array.isArray(entry.metadata.attachments) && entry.metadata.attachments.length > 0}
            <div class="mt-3 flex flex-wrap gap-2">
              {#each entry.metadata.attachments as attachment}
                {#if attachment.type === 'image'}
                  <button
                    type="button"
                    class="relative rounded-lg overflow-hidden border transition-transform hover:scale-105 active:scale-95"
                    style="border-color: var(--color-border); width: 80px; height: 80px; cursor: zoom-in;"
                    onclick={(e) => {
                      e.stopPropagation();
                      zoomedImage = attachment.data;
                    }}
                  >
                    <img
                      src={`data:image/png;base64,${attachment.data}`}
                      alt={attachment.name}
                      class="w-full h-full object-cover"
                    />
                  </button>
                {/if}
              {/each}
            </div>
          {/if}

          {#if entry.type === 'content' && !isStreaming && currentText}
            <div class="mt-2 flex items-center gap-2" in:fade>
              <button
                type="button"
                class="flex items-center gap-1.5 px-2 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider transition-all
                       {copied
                  ? 'bg-emerald-500/10 text-emerald-400'
                  : 'bg-[var(--color-surface-3)] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-border)]'}"
                onclick={(e) => {
                  e.stopPropagation();
                  copyToClipboard();
                }}
              >
                {#if copied}
                  <Check size={10} />
                  Copied
                {:else}
                  <Copy size={10} />
                  Copy Response
                {/if}
              </button>

              {#if entry.metadata?.messageId}
                <button
                  type="button"
                  class="flex items-center gap-1.5 rounded-md bg-[var(--color-surface-3)] px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-muted)] transition-all hover:bg-[var(--color-border)] hover:text-[var(--color-text-primary)] disabled:opacity-40"
                  onclick={(e) => {
                    e.stopPropagation();
                    void regenerateResponse();
                  }}
                  disabled={regenerating}
                  title="Generate another response while preserving this one"
                >
                  <RotateCcw size={10} class={regenerating ? 'animate-spin' : ''} />
                  {regenerating ? 'Regenerating' : 'Regenerate'}
                </button>
              {/if}

              {#if responseVariants.length > 1}
                <div
                  class="flex items-center rounded-md bg-[var(--color-surface-3)] text-[var(--color-text-muted)]"
                >
                  <button
                    type="button"
                    class="p-1 hover:text-[var(--color-text-primary)] disabled:opacity-30"
                    disabled={selectedVariant <= 0}
                    onclick={(e) => {
                      e.stopPropagation();
                      selectedVariant = Math.max(0, selectedVariant - 1);
                    }}
                    aria-label="Previous response"
                  >
                    <ChevronLeft size={12} />
                  </button>
                  <span class="min-w-8 text-center font-mono text-[10px]"
                    >{selectedVariant + 1}/{responseVariants.length}</span
                  >
                  <button
                    type="button"
                    class="p-1 hover:text-[var(--color-text-primary)] disabled:opacity-30"
                    disabled={selectedVariant >= responseVariants.length - 1}
                    onclick={(e) => {
                      e.stopPropagation();
                      selectedVariant = Math.min(responseVariants.length - 1, selectedVariant + 1);
                    }}
                    aria-label="Next response"
                  >
                    <ChevronRight size={12} />
                  </button>
                </div>
              {/if}

              {#if entry.ghostHash}
                <button
                  type="button"
                  class="flex items-center gap-1.5 px-2 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider transition-all bg-[var(--color-surface-3)] text-[var(--color-text-muted)] hover:text-amber-400 hover:bg-amber-400/10"
                  onclick={(e) => {
                    e.stopPropagation();
                    wsStore.rewind(entry.ghostHash!);
                  }}
                  title="Rollback everything to this point"
                >
                  <Undo size={10} />
                  Rewind to Here
                </button>
              {/if}
            </div>
          {/if}
        {:else if entry.type === 'error'}
          <section
            class="mt-1 overflow-hidden rounded-lg border"
            style="border-color: var(--color-error); background: color-mix(in srgb, var(--color-error) 8%, transparent);"
          >
            <div
              class="flex items-center gap-2 border-b px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest text-red-400"
              style="border-color: color-mix(in srgb, var(--color-error) 35%, transparent);"
            >
              <AlertTriangle size={12} />
              <span>{entry.agentName ? `${entry.agentName} failed` : 'System error'}</span>
              <span class="ml-auto font-mono font-normal normal-case opacity-60"
                >{entry.metadata?.source ?? 'runtime'}</span
              >
            </div>
            <pre
              class="max-h-80 overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-[12px] leading-relaxed text-red-200">{currentText ||
                'No error details were provided.'}</pre>
          </section>
        {:else}
          <div class="{getEntryColor(entry.type)} break-words mt-1">
            {currentText}
          </div>
        {/if}
      </div>

      <div
        class="shrink-0 flex items-center gap-0.5 opacity-0 group-hover:opacity-60 hover:!opacity-100 transition-opacity"
      >
        {#if archiveId}
          <button
            class="p-1.5 rounded flex items-center justify-center hover:bg-[var(--color-surface-3)] {entry.agentHidden
              ? 'text-amber-400'
              : ''}"
            style={entry.agentHidden ? '' : 'color: var(--color-text-muted);'}
            onclick={(e) => setAgentHidden(e, !entry.agentHidden)}
            title={entry.agentHidden
              ? 'Hidden from agent — click to restore to its context'
              : 'Hide from agent (frees its context; you still see it)'}
          >
            <Bot size={14} />
          </button>
        {/if}
        <button
          class="p-1.5 rounded flex items-center justify-center hover:bg-[var(--color-surface-3)]"
          style="color: var(--color-text-muted);"
          onclick={toggleUserHidden}
          title="Hide from my view (agent keeps it)"
        >
          <EyeOff size={14} />
        </button>
        <button
          class="p-1.5 rounded flex items-center justify-center hover:bg-[var(--color-surface-3)]"
          style="color: var(--color-text-muted);"
          onclick={(e) => {
            e.stopPropagation();
            if (archiveId) void setAgentHidden(e, true);
            onDelete(e);
          }}
          title="Delete (removes from view and from agent context)"
        >
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  {/if}

  {#if entry.type === 'agent_group' && isExpanded}
    <!-- Sub-agent activity: clearly grouped by domain, expanded by default -->
    {@const bds = domainStyle(entry.metadata)}
    <div
      class="ml-20 border-l-2 pl-4 py-2 space-y-2 my-1 {bds.color}"
      style="border-color: currentColor;"
      transition:fly={{ y: -10, duration: 200 }}
    >
      <div class="text-[10px] uppercase tracking-widest font-bold {bds.color}">
        {bds.label} sub-agent · {entry.agentName}
      </div>
      {#each entry.entries || [] as subEntry (subEntry.id)}
        <div
          class="flex items-start gap-2 text-[12px] opacity-85 hover:opacity-100 transition-opacity"
        >
          <span class="text-[var(--color-text-muted)] w-12 shrink-0">
            {new Date(subEntry.timestamp).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
            })}
          </span>
          <div class="flex-1 min-w-0">
            <span class={getEntryColor(subEntry.type)}>{subEntry.text}</span>
          </div>
        </div>
      {/each}
    </div>
  {/if}

  {#if entry.type === 'tool_group' && isExpanded}
    <div
      class="ml-20 border-l-2 border-[var(--color-border)] pl-4 py-2 space-y-2 my-1"
      transition:fly={{ y: -10, duration: 200 }}
    >
      {#each entry.entries || [] as subEntry (subEntry.id)}
        <div
          class="flex items-start gap-2 text-[12px] opacity-80 hover:opacity-100 transition-opacity"
        >
          <span class="text-[var(--color-text-muted)] w-12 shrink-0">
            {new Date(subEntry.timestamp).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
            })}
          </span>
          <div class="flex-1 min-w-0 font-mono">
            <span class={getEntryColor(subEntry.type)}>{subEntry.text}</span>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

{#if zoomedImage || zoomedRawImage}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm cursor-zoom-out"
    transition:fade={{ duration: 150 }}
    onclick={(e) => {
      e.stopPropagation();
      zoomedImage = null;
      zoomedRawImage = null;
    }}
  >
    <button
      class="absolute top-4 right-4 p-2 text-white/70 hover:text-white bg-black/50 hover:bg-black/80 rounded-full transition-colors"
      onclick={(e) => {
        e.stopPropagation();
        zoomedImage = null;
        zoomedRawImage = null;
      }}
    >
      <X size={24} />
    </button>
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="max-w-full max-h-full" onclick={(e) => e.stopPropagation()}>
      <img
        src={zoomedRawImage ? rawImageUrl(zoomedRawImage) : `data:image/png;base64,${zoomedImage}`}
        alt="Zoomed attachment"
        class="max-w-full max-h-full object-contain rounded shadow-2xl"
      />
    </div>
  </div>
{/if}

<style>
  /* Web search: globe spins while searching, then settles. */
  :global(.globe-spin) {
    animation: globe-rotate 1.4s linear infinite;
  }
  @keyframes globe-rotate {
    from {
      transform: rotate(0);
    }
    to {
      transform: rotate(360deg);
    }
  }

  :global(.markdown-content table) {
    width: 100%;
    min-width: 520px;
    border-collapse: separate;
    border-spacing: 0;
    margin: 1rem 0;
    border: 1px solid var(--color-border);
    border-radius: 12px;
    background: var(--color-surface-1);
  }
  :global(.markdown-content .kory-table-scroll) {
    width: 100%;
    overflow-x: auto;
  }
  :global(.markdown-content thead) {
    background: var(--color-surface-3);
  }
  :global(.markdown-content th) {
    color: var(--color-text-primary);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  :global(.markdown-content th),
  :global(.markdown-content td) {
    padding: 10px 13px;
    text-align: left;
    vertical-align: top;
    border-right: 1px solid var(--color-border);
    border-bottom: 1px solid var(--color-border);
  }
  :global(.markdown-content tr > :last-child) {
    border-right: 0;
  }
  :global(.markdown-content tbody tr:last-child td) {
    border-bottom: 0;
  }
  :global(.markdown-content tbody tr:nth-child(even)) {
    background: color-mix(in srgb, var(--color-surface-2) 55%, transparent);
  }
  :global(.markdown-content tbody tr:hover) {
    background: color-mix(in srgb, var(--color-accent) 8%, var(--color-surface-1));
  }
  :global(.markdown-content .kory-chart) {
    margin: 1rem 0;
    padding: 16px;
    overflow-x: auto;
    border: 1px solid var(--color-border);
    border-radius: 14px;
    background: linear-gradient(145deg, var(--color-surface-2), var(--color-surface-1));
  }
  :global(.markdown-content .kory-chart figcaption) {
    margin-bottom: 10px;
    color: var(--color-text-primary);
    font-weight: 700;
  }
  :global(.markdown-content .kory-chart svg) {
    display: block;
    width: 100%;
    min-width: 520px;
    max-height: 360px;
  }
  :global(.markdown-content .chart-grid) {
    stroke: var(--color-border);
    stroke-width: 1;
    opacity: 0.6;
  }
  :global(.markdown-content .chart-axis) {
    stroke: var(--color-text-muted);
    stroke-width: 1;
  }
  :global(.markdown-content .chart-axis-label) {
    fill: var(--color-text-muted);
    font-size: 11px;
    font-family: 'JetBrains Mono', monospace;
  }
  :global(.markdown-content .chart-bar),
  :global(.markdown-content .chart-slice) {
    transition: opacity 120ms ease;
  }
  :global(.markdown-content .chart-bar:hover),
  :global(.markdown-content .chart-slice:hover) {
    opacity: 0.72;
  }
  :global(.markdown-content .chart-donut-hole) {
    fill: var(--color-surface-2);
  }
  :global(.markdown-content .kory-chart-legend) {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 16px;
    margin-top: 10px;
    color: var(--color-text-secondary);
    font-size: 11px;
  }
  :global(.markdown-content .kory-chart-legend span) {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  :global(.markdown-content .kory-chart-legend i) {
    width: 9px;
    height: 9px;
    border-radius: 3px;
  }
  :global(.markdown-content .kory-chart-pie) {
    display: grid;
    grid-template-columns: minmax(320px, 1fr) minmax(160px, auto);
    align-items: center;
  }
  :global(.markdown-content .kory-chart-pie-legend) {
    flex-direction: column;
    margin: 0;
  }

  /* Streaming text: each arriving chunk starts translucent and settles to
     full opacity — the newest words read as "landing" smoothly. */
  .stream-chunk {
    animation: chunk-settle 0.6s ease-out forwards;
  }

  @keyframes chunk-settle {
    from {
      opacity: 0.25;
    }
    to {
      opacity: 1;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .stream-chunk {
      animation: none;
      opacity: 1;
    }
  }

  @media (max-width: 760px) {
    :global(.markdown-content .kory-chart-pie) {
      display: block;
    }
    :global(.markdown-content .kory-chart-pie-legend) {
      flex-direction: row;
      margin-top: 8px;
    }
  }
</style>
