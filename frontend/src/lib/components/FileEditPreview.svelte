<script lang="ts">
  import { wsStore } from '$lib/stores/websocket.svelte';
  import { Loader, Check } from 'lucide-svelte';
  import { tick } from 'svelte';
  import FileIcon from './icons/FileIcon.svelte';
  import hljs from 'highlight.js/lib/common';
  import 'highlight.js/styles/atom-one-dark.css';
  import DiffMatchPatch from 'diff-match-patch';

  const dmp = new DiffMatchPatch();

  let codeContainers: Record<string, HTMLElement> = {};
  let collapsed = $state<Set<string>>(new Set());

  let edits = $derived([...wsStore.activeFileEdits.values()]);

  // Auto-scroll each still-streaming code container to the bottom as content grows.
  $effect(() => {
    void edits.map((e) => e.content.length + (e.done ? 1 : 0));
    tick().then(() => {
      for (const e of edits) {
        const el = codeContainers[e.path];
        if (el && !e.done) el.scrollTop = el.scrollHeight;
      }
    });
  });

  function getFileName(path: string): string {
    return path.split('/').pop() ?? path;
  }
  function getRelativePath(path: string): string {
    const parts = path.split('/');
    return parts.length > 3 ? '.../' + parts.slice(-3).join('/') : path;
  }
  function toggleCollapse(path: string) {
    const next = new Set(collapsed);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    collapsed = next;
  }

  const EXT_LANG: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript',
    svelte: 'xml', html: 'xml', xml: 'xml', vue: 'xml',
    css: 'css', scss: 'scss', less: 'less',
    json: 'json', md: 'markdown', py: 'python', rs: 'rust', go: 'go', rb: 'ruby',
    java: 'java', c: 'c', h: 'c', cpp: 'cpp', cs: 'csharp', php: 'php', sh: 'bash', bash: 'bash',
    yml: 'yaml', yaml: 'yaml', sql: 'sql', toml: 'ini',
  };
  function langFor(path: string): string | null {
    const ext = path.split('.').pop()?.toLowerCase() ?? '';
    return EXT_LANG[ext] ?? null;
  }
  function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function highlight(code: string, path: string): string {
    try {
      const lang = langFor(path);
      if (lang && hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang }).value;
      return hljs.highlightAuto(code).value;
    } catch {
      return escapeHtml(code);
    }
  }
  // Live red/green diff for edits (old text being replaced → new text).
  function diffHtml(oldContent: string, newContent: string): string {
    const diffs = dmp.diff_main(oldContent, newContent);
    dmp.diff_cleanupSemantic(diffs);
    return diffs
      .map(([op, text]: [number, string]) => {
        const esc = escapeHtml(text);
        if (op === 1) return `<span class="df-ins">${esc}</span>`;
        if (op === -1) return `<span class="df-del">${esc}</span>`;
        return esc;
      })
      .join('');
  }
  function bodyHtml(edit: { operation: string; content: string; oldContent?: string; path: string }): string {
    if (edit.operation === 'edit' && edit.oldContent !== undefined) {
      return diffHtml(edit.oldContent, edit.content);
    }
    return highlight(edit.content, edit.path);
  }
  function lineCount(content: string): number {
    return content.split('\n').length;
  }
  // Cursor-style +N −M line stats.
  function diffStats(edit: { operation: string; content: string; oldContent?: string }): {
    added: number;
    removed: number;
  } {
    if (edit.operation !== 'edit' || edit.oldContent === undefined) {
      return { added: lineCount(edit.content), removed: 0 };
    }
    const diffs = dmp.diff_main(edit.oldContent, edit.content);
    dmp.diff_cleanupSemantic(diffs);
    let added = 0;
    let removed = 0;
    for (const [op, text] of diffs as Array<[number, string]>) {
      if (!text) continue;
      const lines = text.split('\n').filter((l) => l.trim().length > 0).length || 1;
      if (op === 1) added += lines;
      else if (op === -1) removed += lines;
    }
    return { added, removed };
  }
</script>

{#if edits.length > 0}
  <div class="flex flex-col gap-2 p-3">
    {#each edits as edit (edit.path)}
      {@const stats = diffStats(edit)}
      <div
        class="rounded-lg border overflow-hidden transition-all"
        style="border-color: {edit.done ? 'var(--color-border)' : 'rgba(245,158,11,0.4)'}; background: var(--color-surface-0);"
      >
        <!-- File header -->
        <button
          class="w-full flex items-center gap-2 px-3 py-2 text-left transition-colors hover:brightness-110 {edit.done ? '' : 'writing-header'}"
          style="background: var(--color-surface-2);"
          onclick={() => toggleCollapse(edit.path)}
        >
          <FileIcon path={edit.path} size={14} />
          <span class="text-xs font-mono truncate" style="color: var(--color-text-primary);">
            {getFileName(edit.path)}
          </span>
          <span class="text-[10px] font-mono truncate" style="color: var(--color-text-muted);">
            {getRelativePath(edit.path)}
          </span>
          {#if !edit.done}
            <span class="text-[10px] shrink-0 writing-label" style="color: var(--color-accent);">
              {edit.operation === 'create' ? 'Writing' : 'Editing'}<span class="dots"><span>.</span><span>.</span><span>.</span></span>
            </span>
          {/if}
          <span class="text-[10px] tabular-nums shrink-0 ml-auto font-mono">
            <span class="text-emerald-400">+{stats.added}</span>
            {#if stats.removed > 0}
              <span class="text-red-400">−{stats.removed}</span>
            {/if}
          </span>
          <span
            class="text-[10px] px-1.5 py-0.5 rounded shrink-0 {edit.operation === 'create' ? 'text-emerald-400' : 'text-amber-400'}"
            style="background: var(--color-surface-3);"
          >
            {edit.operation === 'create' ? 'NEW' : 'EDIT'}
          </span>
          <!-- Cursor-style status: spinning circle while writing, ✓ when done -->
          {#if edit.done}
            <Check size={15} class="text-emerald-400 shrink-0" />
          {:else}
            <Loader size={15} class="text-[var(--color-accent)] shrink-0 animate-spin" />
          {/if}
        </button>

        <!-- Code content -->
        {#if !collapsed.has(edit.path)}
          <div class="relative flex overflow-hidden" style="max-height: 420px;">
            <pre
              class="text-right pr-2 pl-3 py-2 text-[11px] leading-[1.5] select-none shrink-0 font-mono"
              style="color: var(--color-text-muted); background: var(--color-surface-1); border-right: 1px solid var(--color-border);"
            >{Array.from({ length: lineCount(edit.content) }, (_, i) => i + 1).join('\n')}</pre>

            <pre
              bind:this={codeContainers[edit.path]}
              class="hljs flex-1 overflow-auto py-2 px-3 text-[11px] leading-[1.5] font-mono"
              style="background: transparent;"
            ><code>{@html bodyHtml(edit)}</code>{#if !edit.done}<span class="caret"></span>{/if}</pre>

            {#if !edit.done}
              <!-- Glow over the active writing zone (content is pinned to the bottom while streaming) -->
              <div class="write-glow" aria-hidden="true"></div>
            {/if}
          </div>
        {/if}
      </div>
    {/each}
  </div>
{/if}

<style>
  .caret {
    display: inline-block;
    width: 7px;
    height: 13px;
    margin-left: 1px;
    vertical-align: text-bottom;
    background: var(--color-accent);
    animation: kory-blink 1s steps(2, start) infinite;
  }
  @keyframes kory-blink {
    50% {
      opacity: 0;
    }
  }
  /* Live diff colors for edits */
  :global(.df-ins) {
    background: rgba(34, 197, 94, 0.22);
    color: #86efac;
  }
  :global(.df-del) {
    background: rgba(239, 68, 68, 0.18);
    color: #fca5a5;
    text-decoration: line-through;
    text-decoration-color: rgba(239, 68, 68, 0.5);
  }
  /* Shimmer sweep across the header while the agent is writing */
  .writing-header {
    position: relative;
    overflow: hidden;
  }
  .writing-header::after {
    content: '';
    position: absolute;
    inset: 0;
    background: linear-gradient(
      105deg,
      transparent 35%,
      color-mix(in srgb, var(--color-accent) 12%, transparent) 50%,
      transparent 65%
    );
    background-size: 250% 100%;
    animation: kory-shimmer 1.8s ease-in-out infinite;
    pointer-events: none;
  }
  @keyframes kory-shimmer {
    0% {
      background-position: 120% 0;
    }
    100% {
      background-position: -120% 0;
    }
  }
  /* Animated ellipsis on the Writing/Editing label */
  .dots span {
    animation: kory-dot 1.2s infinite;
    opacity: 0;
  }
  .dots span:nth-child(2) {
    animation-delay: 0.2s;
  }
  .dots span:nth-child(3) {
    animation-delay: 0.4s;
  }
  @keyframes kory-dot {
    0%,
    60%,
    100% {
      opacity: 0;
    }
    30% {
      opacity: 1;
    }
  }
  /* Soft pulsing glow pinned over the newest streamed lines */
  .write-glow {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 56px;
    background: linear-gradient(
      to top,
      color-mix(in srgb, var(--color-accent) 9%, transparent),
      transparent
    );
    animation: kory-glow 1.6s ease-in-out infinite;
    pointer-events: none;
  }
  @keyframes kory-glow {
    0%,
    100% {
      opacity: 0.55;
    }
    50% {
      opacity: 1;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .caret,
    .writing-header::after,
    .dots span,
    .write-glow {
      animation: none;
    }
  }
</style>
