<script lang="ts">
  import { marked } from 'marked';
  import DOMPurify from 'dompurify';
  import PenLine from 'lucide-svelte/icons/pen-line';
  import Code2 from 'lucide-svelte/icons/code-2';
  import Columns2 from 'lucide-svelte/icons/columns-2';
  import SkillVisualEditor from './SkillVisualEditor.svelte';
  import SkillCodeEditor from './SkillCodeEditor.svelte';
  import type { SkillVisualFormat, SkillVisualRenderer } from './skill-visual-safety';
  import '$lib/styles/document.css';

  let {
    value,
    visualValue,
    format = 'markdown',
    renderer = 'markdown',
    mode = $bindable('visual'),
    label = 'Document editor',
    sourceLabel = 'Document source',
    onchange,
    onvisualchange,
    onstatus,
  }: {
    value: string;
    visualValue?: string;
    format?: SkillVisualFormat;
    renderer?: SkillVisualRenderer;
    mode?: 'visual' | 'source' | 'split';
    label?: string;
    sourceLabel?: string;
    onchange: (value: string) => void;
    onvisualchange?: (value: string) => void;
    onstatus?: (message: string) => void;
  } = $props();

  const modes = [
    { id: 'visual' as const, label: 'Write', icon: PenLine },
    { id: 'source' as const, label: 'Source', icon: Code2 },
    { id: 'split' as const, label: 'Split view', icon: Columns2 },
  ];
  const documentBody = $derived(visualValue ?? value);
  const preview = $derived(DOMPurify.sanitize(marked.parse(documentBody, { async: false }) as string));
  function htmlPreview(source: string): string {
    const csp = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'";
    return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}"><style>html{color-scheme:light dark}body{font:15px/1.8 system-ui;color:CanvasText;background:Canvas;padding:24px;margin:0}pre{white-space:pre-wrap}</style></head><body>${source}</body></html>`;
  }
</script>

<section class="document-editor" aria-label={label}>
  <div class="document-toolbar">
    <div class="editor-modes" role="group" aria-label="Editor mode">
      {#each modes as item (item.id)}
        <button type="button" class:active={mode === item.id} aria-pressed={mode === item.id} onclick={() => (mode = item.id)}>
          <item.icon size={14} /><span>{item.label}</span>
        </button>
      {/each}
    </div>
    <span class="document-format">{format === 'markdown' ? 'Markdown' : format === 'html' ? 'HTML' : 'Text'}</span>
  </div>
  <div class="document-body" class:split={mode === 'split'}>
    {#if mode === 'visual'}
      <SkillVisualEditor
        value={documentBody}
        {format}
        {renderer}
        onchange={onvisualchange ?? onchange}
        onrequestsource={() => (mode = 'source')}
        {onstatus}
        {label}
      />
    {:else}
      <div class="source-panel">
        {#if mode === 'split'}<div class="panel-caption">Source</div>{/if}
        <SkillCodeEditor {value} language={format} {renderer} {onchange} ariaLabel={sourceLabel} />
      </div>
    {/if}
    {#if mode === 'split' || (mode === 'visual' && renderer === 'html')}
      <div class="document-preview">
        <div class="panel-caption">Preview</div>
        {#if renderer === 'html'}
          <iframe title="Sandboxed document HTML preview" sandbox="" srcdoc={htmlPreview(documentBody)}></iframe>
        {:else if renderer === 'markdown'}
          <article class="kory-document">{@html preview}</article>
        {:else}
          <pre>{documentBody}</pre>
        {/if}
      </div>
    {/if}
  </div>
</section>

<style>
  .document-editor { min-width: 0; overflow: hidden; border: 1px solid var(--color-border); border-radius: var(--radius-lg); background: var(--color-surface-1); }
  .document-toolbar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; min-height: 48px; padding: 8px 12px; }
  .editor-modes { display: flex; gap: 3px; border-radius: 7px; background: var(--color-surface-2); padding: 3px; }
  .editor-modes button { display: flex; align-items: center; gap: 6px; min-height: 30px; border-radius: 6px; padding: 0 10px; color: var(--color-text-muted); font-size: 12px; font-weight: 500; }
  .editor-modes button.active { background: var(--color-surface-4); color: var(--color-text-primary); }
  .editor-modes button:hover { color: var(--color-text-primary); }
  .editor-modes button:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; }
  .document-format, .panel-caption { font-size: 11px; color: var(--color-text-muted); }
  .document-format { padding-right: 4px; }
  .document-body { min-width: 0; min-height: 400px; }
  .document-body.split { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .document-body :global(.skill-visual-editor), .document-body :global(.skill-code-editor) { border: 0; border-radius: 0; min-height: 400px; background: var(--color-surface-1); }
  .document-body :global(.format-toolbar) { border-bottom: 1px solid var(--color-border); background: var(--color-surface-2); }
  .document-body :global(.format-toolbar button:disabled) { border-color: transparent; background: transparent; opacity: 0.45; }
  .source-panel { min-width: 0; }
  .source-panel :global(.skill-code-editor) { height: 480px; }
  .panel-caption { border-bottom: 1px solid var(--color-border); padding: 10px 18px; font-weight: 500; background: var(--color-surface-1); }
  .document-preview { min-width: 0; border-left: 1px solid var(--color-border); }
  .document-preview article, .document-preview pre { max-height: 480px; overflow: auto; padding: 28px; }
  .document-preview pre { font: 14px/1.8 var(--font-mono); white-space: pre-wrap; }
  .document-preview iframe { width: 100%; min-height: 480px; border: 0; }
  @media (max-width: 950px) {
    .document-body.split { grid-template-columns: 1fr; }
    .document-preview { border-left: 0; border-top: 1px solid var(--color-border); }
  }
  @media (max-width: 500px) {
    .document-format { display: none; }
    .editor-modes button { padding: 0 8px; }
  }
</style>
