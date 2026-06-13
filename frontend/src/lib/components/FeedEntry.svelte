<script lang="ts">
  import { 
    MessageSquare, 
    Send,
    ChevronRight,
    ChevronDown,
    Trash2,
    Copy,
    Check,
    Terminal,
    Maximize2,
    Minimize2,
    Undo,
    X
  } from 'lucide-svelte';
  import { fly, fade } from 'svelte/transition';
  import { wsStore } from '$lib/stores/websocket.svelte';
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

  async function copyToClipboard() {
    try {
      await navigator.clipboard.writeText(entry.text);
      copied = true;
      setTimeout(() => { copied = false; }, 2000);
    } catch (err) {
      console.error('Failed to copy text: ', err);
    }
  }

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

  // Derived parsed HTML from the DEBOUNCED text
  let parsedHtml = $derived.by(() => {
    if (!debouncedText) return '';
    try {
      return DOMPurify.sanitize(marked.parse(debouncedText, { async: false }) as string);
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

  function getStatusForType(type: FeedEntryType, meta?: Record<string, unknown>): import('@koryphaios/shared').AgentStatus {
    switch (type) {
      case 'user_message': return 'idle';
      case 'thought': return meta?.phase === 'analyzing' ? 'analyzing' : 'thinking';
      case 'content': return 'streaming';
      case 'thinking': return 'thinking';
      case 'tool_call': return 'tool_calling';
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
  <div
    class="flex items-start gap-[var(--space-md)] py-[var(--space-sm)] text-sm leading-relaxed rounded px-[var(--space-md)] -mx-[var(--space-md)] transition-all cursor-default
           {isSelected ? 'bg-[var(--color-accent)]/10 ring-1 ring-[var(--color-accent)]/30' : 'hover:bg-surface-2/30'}"
    onclick={(e) => entry.type === 'tool_group' ? onToggleGroup() : onSelect(e)}
    onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') entry.type === 'tool_group' ? onToggleGroup() : onSelect(e as unknown as MouseEvent); }}
    role="row"
    tabindex="0"
  >
    <span class="text-xs text-text-muted shrink-0 w-16 leading-6 tabular-nums pt-0.5">
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
        class="shrink-0 flex items-center justify-center w-5 h-6 pt-1"
      >
        <AnimatedStatusIcon status={getStatusForType(entry.type, entry.metadata)} size={14} isManager={entry.agentId === 'kory-manager'} />
      </div>
    {/if}

    <div class="flex-1 min-w-0 {entry.type === 'content' ? 'markdown-content' : ''}">
      <span class="text-xs font-semibold tracking-wide {entry.glowClass === 'glow-kory' ? 'text-yellow-400' : entry.type === 'user_message' ? 'text-accent' : 'text-text-secondary'}">
        {entry.agentName}
      </span>
      {#if entry.type === 'thinking'}
          <ThinkingBlock 
            text={entry.text} 
            durationMs={entry.durationMs} 
            agentName={entry.agentName} 
          />
      {:else if entry.type === 'tool_call' || entry.type === 'tool_result'}
          <div class="mt-1 flex flex-col gap-2">
            <div 
              class="rounded-lg border border-[var(--color-border)] overflow-hidden bg-[var(--color-surface-2)] transition-all"
              style={expandedTerminal ? 'max-height: 1000px;' : 'max-height: 120px;'}
            >
              <div class="flex items-center justify-between px-3 py-1.5 bg-[var(--color-surface-3)] border-b border-[var(--color-border)]">
                <div class="flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-[var(--color-text-muted)]">
                  <Terminal size={12} />
                  <span>{entry.type === 'tool_call' ? 'Executing Command' : 'Terminal Output'}</span>
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
      {:else if entry.type === 'user_message' || entry.type === 'content' || entry.type === 'thought'}
          <div class="{getEntryColor(entry.type)} break-words mt-1 markdown-content">
            {@html parsedHtml}
          </div>

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
      {#if isStreaming}
        <span class="inline-block w-2 h-4 bg-accent ml-0.5 animate-pulse" aria-hidden="true"></span>
      {/if}
    </div>

    <button
      class="shrink-0 p-1.5 rounded opacity-0 group-hover:opacity-60 hover:!opacity-100 transition-opacity flex items-center justify-center"
      style="color: var(--color-text-muted);"
      onclick={(e) => { e.stopPropagation(); onDelete(e); }}
      title="Delete message"
    >
      <Trash2 size={14} />
    </button>
  </div>

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
    <img 
      src={`data:image/png;base64,${zoomedImage}`} 
      alt="Zoomed attachment" 
      class="max-w-full max-h-full object-contain rounded shadow-2xl" 
      onclick={(e) => e.stopPropagation()}
    />
  </div>
{/if}
