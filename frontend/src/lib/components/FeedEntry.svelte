<script lang="ts">
  import {
    MessageSquare,
    Send,
    ChevronRight,
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
    X,
    Pencil,
    Globe,
    FileSearch,
    FileText,
    Search,
    FolderSearch,
    Folder,
    FilePlus,
    GitMerge,
    MoveRight,
    FileCode,
    Bot
  } from 'lucide-svelte';
  import { fly, fade } from 'svelte/transition';
  import { wsStore } from '$lib/stores/websocket.svelte';
  import { sessionStore } from '$lib/stores/sessions.svelte';
  import AnimatedStatusIcon from './AnimatedStatusIcon.svelte';
  import ThinkingBlock from './ThinkingBlock.svelte';
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
    start(src: string) { return src.indexOf('[['); },
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
  renderer.code = ({ text, lang }: { text: string, lang?: string }) => {
    const requestedLanguage = lang?.trim().toLowerCase();
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
  marked.setOptions({ renderer });

  let { 
    entry, 
    isSelected, 
    isExpanded, 
    isStreaming = false,
    onSelect, 
    onToggleGroup, 
    onDelete 
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
  let expandedTerminal = $state(false);
  let zoomedImage = $state<string | null>(null);
  let renderedNotes = $state<Record<string, Note | null>>({});
  const pendingNoteRenders = new Set<string>();

  // Archive id set by the backend for tool outputs — enables the three
  // visibility modes (hide-from-agent / hide-from-me / delete).
  let archiveId = $derived(
    ((entry.metadata as { toolResult?: { archiveId?: string } } | undefined)?.toolResult
      ?.archiveId) ?? null,
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
      await navigator.clipboard.writeText(entry.text);
      copied = true;
      setTimeout(() => { copied = false; }, 2000);
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
    const t = entry.text;
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
    if (entry.text !== debouncedText) {
      clearTimeout(timer);
      timer = setTimeout(() => {
        debouncedText = entry.text;
      }, 32); // 32ms debounce for smoother streaming
    }
    return () => clearTimeout(timer);
  });

  // While streaming, render plain text — markdown parse only after stream completes
  let noteRenderIds = $derived.by(() => {
    const ids: string[] = [];
    for (const match of debouncedText.matchAll(/\{\{render_note:([^}\s]+)\}\}/g)) ids.push(match[1]);
    return [...new Set(ids)];
  });

  $effect(() => {
    for (const id of noteRenderIds) {
      if (Object.hasOwn(renderedNotes, id) || pendingNoteRenders.has(id)) continue;
      pendingNoteRenders.add(id);
      void apiFetch(apiUrl(`/api/notes/${encodeURIComponent(id)}`))
        .then(async (response) => {
          const data = await response.json();
          renderedNotes = { ...renderedNotes, [id]: response.ok && data.ok ? data.data as Note : null };
        })
        .catch(() => { renderedNotes = { ...renderedNotes, [id]: null }; })
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
      const withoutRenderDirectives = debouncedText.replace(/\{\{render_note:[^}\s]+\}\}/g, '').trim();
      return DOMPurify.sanitize(marked.parse(withoutRenderDirectives, { async: false }) as string);
    } catch {
      return debouncedText;
    }
  });

  function getEntryColor(type: FeedEntryType): string {
    switch (type) {
      case 'user_message': return 'text-accent font-medium';
      case 'thought': return 'text-yellow-400';
      case 'content': return 'text-text-primary';
      case 'thinking': return 'text-blue-400/70';
      case 'tool_call': return 'text-accent';
      case 'tool_result': return 'text-green-400';
      case 'routing': return 'text-yellow-300';
      case 'error': return 'text-red-400';
      case 'system': return 'text-text-muted';
      case 'tool_group': return 'text-blue-400 font-medium italic';
      default: return 'text-text-secondary';
    }
  }

  type ToolCategory = 'bash' | 'read' | 'write' | 'web' | 'other';

  const READ_TOOLS = new Set(['read_file', 'grep', 'glob', 'ls']);
  const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'patch', 'diff', 'delete_file', 'move_file']);
  const WEB_TOOLS = new Set(['web_search', 'web_fetch']);
  const BASH_TOOLS = new Set(['bash', 'shell_manage']);

  function getToolNameFromMeta(meta?: Record<string, unknown>): string {
    const m = meta as { toolCall?: { name?: string }; toolResult?: { name?: string } } | undefined;
    return m?.toolCall?.name ?? m?.toolResult?.name ?? '';
  }

  function getToolCategory(meta?: Record<string, unknown>): ToolCategory {
    const name = getToolNameFromMeta(meta);
    if (BASH_TOOLS.has(name)) return 'bash';
    if (READ_TOOLS.has(name)) return 'read';
    if (WRITE_TOOLS.has(name)) return 'write';
    if (WEB_TOOLS.has(name)) return 'web';
    return 'other';
  }

  interface ToolDisplay { label: string; resultLabel: string; colorClass: string; }

  function getToolDisplay(category: ToolCategory): ToolDisplay {
    switch (category) {
      case 'read':  return { label: 'Reading File',      resultLabel: 'File Contents',    colorClass: 'text-cyan-400' };
      case 'write': return { label: 'Editing File',      resultLabel: 'File Written',     colorClass: 'text-amber-400' };
      case 'web':   return { label: 'Searching Web',     resultLabel: 'Web Results',      colorClass: 'text-sky-400' };
      case 'bash':  return { label: 'Executing Command', resultLabel: 'Terminal Output',  colorClass: 'text-emerald-400' };
      default:      return { label: 'Running Tool',      resultLabel: 'Tool Output',      colorClass: 'text-emerald-400' };
    }
  }

  function getToolShortLabel(meta?: Record<string, unknown>): string {
    const m = meta as { toolCall?: { name?: string; input?: Record<string, unknown> } } | undefined;
    const name = m?.toolCall?.name ?? '';
    const input = (m?.toolCall?.input ?? {}) as Record<string, unknown>;
    const rawPath = (input.path ?? input.file_path ?? input.filepath ?? '') as string;
    const base = rawPath ? rawPath.split('/').pop() ?? rawPath : '';
    switch (name) {
      case 'read_file': return base || rawPath;
      case 'write_file':
      case 'edit_file':
      case 'delete_file': return base || rawPath;
      case 'move_file': {
        const src = ((input.source ?? input.src ?? '') as string).split('/').pop() ?? '';
        const dst = ((input.dest ?? input.destination ?? '') as string).split('/').pop() ?? '';
        return src && dst ? `${src} → ${dst}` : name;
      }
      case 'grep': {
        const pat = (input.pattern ?? input.regex ?? '') as string;
        return base ? `"${pat}" in ${base}` : `"${pat}"`;
      }
      case 'glob': return (input.pattern ?? '') as string;
      case 'ls': return base || '.';
      case 'patch':
      case 'diff': return base || name;
      default: return name;
    }
  }

  function getToolVerb(meta?: Record<string, unknown>): string {
    const m = meta as { toolCall?: { name?: string } } | undefined;
    switch (m?.toolCall?.name) {
      case 'read_file': return 'read';
      case 'write_file': return 'write';
      case 'edit_file': return 'edit';
      case 'delete_file': return 'delete';
      case 'move_file': return 'move';
      case 'grep': return 'grep';
      case 'glob': return 'glob';
      case 'ls': return 'ls';
      case 'patch': return 'patch';
      case 'diff': return 'diff';
      default: return 'tool';
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function getToolIcon(meta?: Record<string, unknown>): any {
    const m = meta as { toolCall?: { name?: string } } | undefined;
    switch (m?.toolCall?.name) {
      case 'read_file':   return FileText;
      case 'grep':        return Search;
      case 'glob':        return FolderSearch;
      case 'ls':          return Folder;
      case 'write_file':  return FilePlus;
      case 'edit_file':   return Pencil;
      case 'patch':       return GitMerge;
      case 'diff':        return FileCode;
      case 'delete_file': return Trash2;
      case 'move_file':   return MoveRight;
      default:            return FileSearch;
    }
  }

  function getBashCommand(meta?: Record<string, unknown>): string {
    const m = meta as { toolCall?: { input?: Record<string, unknown> } } | undefined;
    return (m?.toolCall?.input?.command as string) ?? '';
  }

  function getToolIconColor(meta?: Record<string, unknown>): string {
    const m = meta as { toolCall?: { name?: string } } | undefined;
    switch (m?.toolCall?.name) {
      case 'delete_file': return 'text-red-400/50';
      case 'write_file':
      case 'edit_file':
      case 'patch':
      case 'diff':
      case 'move_file':   return 'text-amber-400/50';
      default:            return 'text-cyan-400/50';
    }
  }

  function getStatusForType(type: FeedEntryType, meta?: Record<string, unknown>): import('@koryphaios/shared').AgentStatus {
    switch (type) {
      case 'user_message': return 'idle';
      case 'thought': return meta?.phase === 'analyzing' ? 'analyzing' : 'thinking';
      case 'content': return 'streaming';
      case 'thinking': return 'thinking';
      case 'tool_call': {
        const cat = getToolCategory(meta);
        if (cat === 'read') return 'reading';
        if (cat === 'write') return 'writing';
        if (cat === 'web') return 'searching';
        return 'tool_calling';
      }
      case 'tool_result': return 'done';
      case 'routing': return 'verifying';
      case 'error': return 'error';
      case 'system': return 'idle';
      case 'tool_group': return 'reading';
      default: return 'idle';
    }
  }
</script>

<div 
  class="flex flex-col group" 
  in:fly={{ y: 20, duration: (Date.now() - entry.timestamp < 5000) ? 300 : 0 }}
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
           {isSelected ? 'bg-[var(--color-accent)]/10 ring-1 ring-[var(--color-accent)]/30' : 'hover:bg-surface-2/30'}"
    onclick={(e) => entry.type === 'tool_group' ? onToggleGroup() : onSelect(e)}
    onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') entry.type === 'tool_group' ? onToggleGroup() : onSelect(e as unknown as MouseEvent); }}
    role="row"
    tabindex="0"
  >
    <span class="text-xs text-text-muted shrink-0 w-16 leading-6 tabular-nums">
      {new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
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
    {:else}
      <div
        class="shrink-0 flex items-center justify-center w-5 h-6"
      >
        <AnimatedStatusIcon status={getStatusForType(entry.type, entry.metadata)} size={14} isManager={entry.agentId === 'kory-manager'} />
      </div>
    {/if}

    <div class="flex-1 min-w-0 {entry.type === 'content' ? 'markdown-content' : ''}">
      {#if entry.agentHidden}
        <span class="inline-flex items-center gap-1 mr-2 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider bg-amber-400/10 text-amber-400" title="This is stubbed out of the agent's context (recoverable via fetch_context)">
          <Bot size={9} /> hidden from agent
        </span>
      {/if}
      <!-- The agent name only appears when the agent is actually saying
           something — tool calls, results, and reasoning stay unlabeled to
           keep the feed compact. -->
      {#if entry.type === 'user_message' || entry.type === 'content' || entry.type === 'thought' || entry.type === 'error'}
        <span class="text-xs font-semibold tracking-wide {entry.glowClass === 'glow-kory' ? 'text-yellow-400' : entry.type === 'user_message' ? 'text-accent' : 'text-text-secondary'}">
          {entry.agentName}
        </span>
      {/if}
      {#if entry.type === 'thinking'}
          <ThinkingBlock 
            text={entry.text} 
            durationMs={entry.durationMs} 
            agentName={entry.agentName} 
            estimatedTokens={(entry.metadata as { thinkingTokens?: number } | undefined)?.thinkingTokens}
          />
      {:else if entry.type === 'tool_call' || entry.type === 'tool_result'}
          {@const toolCat = getToolCategory(entry.metadata)}
          {@const toolDisplay = getToolDisplay(toolCat)}
          {@const isSimple = toolCat === 'read' || toolCat === 'write'}
          {#if isSimple}
            {#if entry.type === 'tool_call'}
              {@const ToolIcon = getToolIcon(entry.metadata)}
              <div class="mt-0.5 flex items-center gap-1.5 text-[11px]">
                <ToolIcon size={11} class="{getToolIconColor(entry.metadata)} shrink-0" />
                <span class="opacity-40 font-medium text-text-secondary">{getToolVerb(entry.metadata)}</span>
                <span class="text-text-muted opacity-50 truncate max-w-xs">{getToolShortLabel(entry.metadata)}</span>
              </div>
            {/if}
          {:else}
          <div class="mt-1 flex flex-col gap-2">
            <div
              class="rounded-lg border border-[var(--color-border)] overflow-hidden bg-[var(--color-surface-2)] transition-all"
              style={expandedTerminal ? 'max-height: 1000px;' : 'max-height: 120px;'}
            >
              <div class="flex items-center justify-between px-3 py-1.5 bg-[var(--color-surface-3)] border-b border-[var(--color-border)]">
                <div class="flex items-center gap-2 min-w-0 flex-1 overflow-hidden">
                  <div class="flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest {toolDisplay.colorClass} shrink-0">
                    {#if toolCat === 'web'}
                      <Globe size={12} />
                    {:else}
                      <Terminal size={12} />
                    {/if}
                    <span>{entry.type === 'tool_call' ? toolDisplay.label : toolDisplay.resultLabel}</span>
                  </div>
                  {#if toolCat === 'bash'}
                    {@const cmd = getBashCommand(entry.metadata)}
                    {#if cmd}
                      <span class="font-mono text-[11px] truncate opacity-60" style="color: var(--color-text-secondary);">$ {cmd}</span>
                    {/if}
                  {/if}
                </div>
                <button
                  type="button"
                  class="p-1 hover:bg-[var(--color-surface-4)] rounded transition-colors text-[var(--color-text-muted)]"
                  onclick={(e) => { e.stopPropagation(); expandedTerminal = !expandedTerminal; }}
                >
                  {#if expandedTerminal}
                    <Minimize2 size={12} />
                  {:else}
                    <Maximize2 size={12} />
                  {/if}
                </button>
              </div>
              <div class="p-3 font-mono text-[12px] leading-relaxed break-words whitespace-pre-wrap {getEntryColor(entry.type)} overflow-y-auto" style={expandedTerminal ? 'max-height: 800px;' : 'max-height: 80px;'}>
                {entry.text}
              </div>
            </div>
          </div>
          {/if}
      {:else if entry.type === 'user_message' || entry.type === 'content' || entry.type === 'thought'}
          <div class="{getEntryColor(entry.type)} break-words mt-1 markdown-content">
            {#if isStreaming && entry.type === 'content'}
              <span class="whitespace-pre-wrap">{#each streamChunks as c (c.id)}<span class="stream-chunk">{c.text}</span>{/each}</span>
            {:else if isStreaming}
              {entry.text}
            {:else}
              {@html parsedHtml}
            {/if}
          </div>

          {#if !isStreaming && noteRenderIds.length > 0}
            <div class="mt-3 space-y-3">
              {#each noteRenderIds as noteId (noteId)}
                {@const note = renderedNotes[noteId]}
                <section class="overflow-hidden rounded-xl border" style="border-color: var(--color-border); background: var(--color-surface-1);">
                  {#if note === undefined}
                    <div class="px-4 py-3 text-xs" style="color: var(--color-text-muted);">Loading rendered note…</div>
                  {:else if note === null}
                    <div class="px-4 py-3 text-xs text-red-400">Unable to render this note.</div>
                  {:else}
                    <div class="flex items-center gap-2 border-b px-4 py-2" style="border-color: var(--color-border);">
                      <FileText size={12} style="color: var(--color-accent);" />
                      <span class="text-xs font-semibold" style="color: var(--color-text-primary);">{note.title}</span>
                      {#if note.sourcePath}<span class="ml-auto truncate font-mono text-[10px]" style="color: var(--color-text-muted);">{note.sourcePath}</span>{/if}
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
                      <div class="markdown-content max-h-[520px] overflow-auto px-5 py-4" style="color: var(--color-text-primary);">
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
                    onclick={(e) => { e.stopPropagation(); zoomedImage = attachment.data; }}
                  >
                    <img src={`data:image/png;base64,${attachment.data}`} alt={attachment.name} class="w-full h-full object-cover" />
                  </button>
                {/if}
              {/each}
            </div>
          {/if}

          {#if entry.type === 'content' && !isStreaming && entry.text}
            <div class="mt-2 flex items-center gap-2" in:fade>
              <button
                type="button"
                class="flex items-center gap-1.5 px-2 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider transition-all
                       {copied ? 'bg-emerald-500/10 text-emerald-400' : 'bg-[var(--color-surface-3)] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-border)]'}"
                onclick={(e) => { e.stopPropagation(); copyToClipboard(); }}
              >
                {#if copied}
                  <Check size={10} />
                  Copied
                {:else}
                  <Copy size={10} />
                  Copy Response
                {/if}
              </button>

              {#if entry.ghostHash}
                <button
                  type="button"
                  class="flex items-center gap-1.5 px-2 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider transition-all bg-[var(--color-surface-3)] text-[var(--color-text-muted)] hover:text-amber-400 hover:bg-amber-400/10"
                  onclick={(e) => { e.stopPropagation(); wsStore.rewind(entry.ghostHash!); }}
                  title="Rollback everything to this point"
                >
                  <Undo size={10} />
                  Rewind to Here
                </button>
              {/if}
            </div>
          {/if}
      {:else}
          <div class="{getEntryColor(entry.type)} break-words mt-1">
            {entry.text}
          </div>
      {/if}
    </div>

    <div class="shrink-0 flex items-center gap-0.5 opacity-0 group-hover:opacity-60 hover:!opacity-100 transition-opacity">
      {#if archiveId}
        <button
          class="p-1.5 rounded flex items-center justify-center hover:bg-[var(--color-surface-3)] {entry.agentHidden ? 'text-amber-400' : ''}"
          style={entry.agentHidden ? '' : 'color: var(--color-text-muted);'}
          onclick={(e) => setAgentHidden(e, !entry.agentHidden)}
          title={entry.agentHidden ? 'Hidden from agent — click to restore to its context' : 'Hide from agent (frees its context; you still see it)'}
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
        onclick={(e) => { e.stopPropagation(); if (archiveId) void setAgentHidden(e, true); onDelete(e); }}
        title="Delete (removes from view and from agent context)"
      >
        <Trash2 size={14} />
      </button>
    </div>
  </div>

  {/if}

  {#if entry.type === 'tool_group' && isExpanded}
    <div class="ml-20 border-l-2 border-[var(--color-border)] pl-4 py-2 space-y-2 my-1" transition:fly={{ y: -10, duration: 200 }}>
      {#each entry.entries || [] as subEntry (subEntry.id)}
        <div class="flex items-start gap-2 text-[12px] opacity-80 hover:opacity-100 transition-opacity">
          <span class="text-[var(--color-text-muted)] w-12 shrink-0">
            {new Date(subEntry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
          </span>
          <div class="flex-1 min-w-0 font-mono">
            <span class={getEntryColor(subEntry.type)}>{subEntry.text}</span>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

{#if zoomedImage}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div 
    class="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm cursor-zoom-out"
    transition:fade={{ duration: 150 }}
    onclick={(e) => { e.stopPropagation(); zoomedImage = null; }}
  >
    <button 
      class="absolute top-4 right-4 p-2 text-white/70 hover:text-white bg-black/50 hover:bg-black/80 rounded-full transition-colors"
      onclick={(e) => { e.stopPropagation(); zoomedImage = null; }}
    >
      <X size={24} />
    </button>
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="max-w-full max-h-full" onclick={(e) => e.stopPropagation()}>
      <img
        src={`data:image/png;base64,${zoomedImage}`}
        alt="Zoomed attachment"
        class="max-w-full max-h-full object-contain rounded shadow-2xl"
      />
    </div>
  </div>
{/if}

<style>
  /* Streaming text: each arriving chunk starts translucent and settles to
     full opacity — the newest words read as "landing" smoothly. */
  .stream-chunk {
    animation: chunk-settle 0.6s ease-out forwards;
  }

  @keyframes chunk-settle {
    from { opacity: 0.25; }
    to { opacity: 1; }
  }

  @media (prefers-reduced-motion: reduce) {
    .stream-chunk { animation: none; opacity: 1; }
  }
</style>
