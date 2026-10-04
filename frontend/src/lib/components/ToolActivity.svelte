<script lang="ts">
  import ChevronRight from 'lucide-svelte/icons/chevron-right';
  import ChevronUp from 'lucide-svelte/icons/chevron-up';
  import Copy from 'lucide-svelte/icons/copy';
  import Check from 'lucide-svelte/icons/check';
  import ToolActivity from './ToolActivity.svelte';
  import type { FeedEntryLocal } from '$lib/types';
  import { toolPresentation } from '$lib/utils/tool-presentation';
  import { copyText } from '$lib/utils/clipboard';
  import { requestExpandAnchor } from '$lib/utils/expand-anchor';

  let { entry, open = $bindable(false) } = $props<{ entry: FeedEntryLocal; open?: boolean }>();
  const id = $props.id();
  let trigger = $state<HTMLButtonElement>();
  let copied = $state(false);
  const tool = $derived(toolPresentation(entry));
  const grouped = $derived(entry.type === 'tool_group');
  const steps = $derived(entry.entries ?? []);
  const body = $derived(tool.changes || tool.content || tool.output);
  const preview = $derived(body.length > 4_000 ? `${body.slice(0, 4_000)}\n\n…output clipped` : body);
  const label = $derived(tool.failed ? `Failed to ${tool.action.toLowerCase().replace(/ed$/, '')}` : tool.action);

  function toggle(event: MouseEvent) {
    event.stopPropagation();
    requestExpandAnchor(event.currentTarget);
    open = !open;
  }

  async function copyOutput() {
    await copyText(body || tool.command);
    copied = true;
    setTimeout(() => (copied = false), 1600);
  }
</script>

<div class="tool-activity" class:failed={tool.failed}>
  <button
    bind:this={trigger}
    type="button"
    class="tool-summary"
    aria-expanded={open}
    aria-controls={open ? id : undefined}
    onclick={toggle}
    title={grouped ? 'View explored files and searches' : `View details · ${tool.paths.join(', ') || tool.command || tool.target}`}
  >
    {#if grouped}
      <span class="action">Explored</span>
      <span class="target">{steps.length} {steps.length === 1 ? 'operation' : 'operations'}</span>
    {:else}
      <span class="action">{tool.failed ? 'Failed' : label}</span>
      <span class="target" class:mono={tool.kind === 'file' || tool.kind === 'command'}>{tool.target}</span>
    {/if}
    <ChevronRight size={12} class={`disclosure ${open ? 'expanded' : ''}`} />
  </button>

  {#if open}
    <section id={id} class="tool-detail" role="region" aria-label="Tool details">
      <header>
        <span class="detail-title">{grouped ? 'Files & searches' : tool.failed ? 'Error' : tool.changes ? 'Changes' : tool.command ? 'Command' : tool.content ? 'Contents' : tool.complete ? 'Output' : 'Input'}</span>
        <div class="detail-actions">
          {#if body || tool.command}
            <button type="button" onclick={copyOutput} aria-label="Copy output" title="Copy output">
              {#if copied}<Check size={13} />{:else}<Copy size={13} />{/if}
            </button>
          {/if}
          <button type="button" aria-label="Collapse details" title="Collapse details" onclick={(event) => {
            event.stopPropagation();
            requestExpandAnchor(event.currentTarget);
            open = false;
            trigger?.focus();
          }}><ChevronUp size={14} /></button>
        </div>
      </header>
      {#if grouped}
        <div class="group-steps">
          {#each steps as step (step.id)}
            <ToolActivity entry={step} />
          {/each}
        </div>
      {:else}
        {#if tool.paths.length}
          <div class="file-paths">{#each tool.paths as path}<span>{path}</span>{/each}</div>
        {/if}
        {#if tool.command}
          <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
          <div class="command" role="region" aria-label="Command" tabindex="0"><span aria-hidden="true">$ </span>{tool.command}</div>
        {/if}
        {#if body}
          <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
          <pre class="tool-output-pre max-h-80 overflow-auto" class:diff={!!tool.changes} tabindex="0" aria-label={tool.changes ? 'File changes' : 'Tool output'}>{#if tool.changes}{#each preview.split('\n') as line}<span class="diff-line" class:added={line.startsWith('+') && !line.startsWith('+++')} class:removed={line.startsWith('-') && !line.startsWith('---')}>{line}{'\n'}</span>{/each}{:else}{preview}{/if}</pre>
        {:else if !tool.command && !tool.complete && tool.fields.length}
          <dl class="input-fields">
            {#each tool.fields as [key, value]}
              <div><dt>{key.replace(/_/g, ' ')}</dt><dd>{typeof value === 'string' ? value : JSON.stringify(value, null, 2)}</dd></div>
            {/each}
          </dl>
        {:else if !tool.command}
          <p class="empty">{tool.complete ? 'No output was reported.' : 'No input was recorded.'}</p>
        {/if}
        {#if tool.changes && tool.output}
          <details class="raw-output"><summary>Tool response</summary><pre>{tool.output}</pre></details>
        {/if}
      {/if}
    </section>
  {/if}
</div>

<style>
  .tool-activity { min-width: 0; }
  .tool-summary { display: flex; align-items: center; gap: 6px; max-width: 100%; min-height: 28px; padding: 2px 0; text-align: left; font-size: 13px; line-height: 1.6; }
  .action { flex-shrink: 0; color: var(--color-text-muted); }
  .target { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-text-secondary); text-decoration: underline; text-decoration-color: color-mix(in srgb, var(--color-text-secondary) 25%, transparent); text-underline-offset: 3px; }
  .mono { font-family: var(--font-mono); font-size: 12px; }
  .tool-summary:hover .target, .tool-summary:focus-visible .target { color: var(--color-accent); text-decoration-color: currentColor; }
  .failed .action { color: var(--color-error); }
  :global(.disclosure) { flex-shrink: 0; color: var(--color-text-muted); transition: transform 120ms ease; }
  :global(.disclosure.expanded) { transform: rotate(90deg); }
  .tool-detail { margin: 6px 0 12px; padding: 10px 14px 14px; border-radius: var(--radius-md); background: color-mix(in srgb, var(--color-surface-2) 65%, transparent); }
  header { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; }
  .detail-title { font-size: 12px; font-weight: 500; color: var(--color-text-secondary); }
  .failed .detail-title { color: var(--color-error); }
  .detail-actions { display: flex; margin-left: auto; gap: 2px; }
  .detail-actions button { display: grid; place-items: center; width: 26px; height: 26px; border-radius: var(--radius-sm); color: var(--color-text-muted); }
  .detail-actions button:hover { color: var(--color-text-primary); background: var(--color-surface-3); }
  button:focus-visible, [tabindex]:focus-visible, summary:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; border-radius: var(--radius-sm); }
  .file-paths { display: flex; flex-direction: column; gap: 4px; margin-bottom: 10px; font: 11px/1.6 var(--font-mono); color: var(--color-text-muted); overflow-wrap: anywhere; }
  .command, pre { margin: 0; padding: 0; font: 12px/1.65 var(--font-mono); white-space: pre-wrap; overflow-wrap: anywhere; color: var(--color-text-secondary); scrollbar-width: thin; }
  .command { max-height: 10rem; overflow: auto; color: var(--color-text-primary); }
  .command span { color: var(--color-text-muted); }
  .command + pre { margin-top: 12px; }
  pre { max-height: 20rem; overflow: auto; }
  .diff-line { display: block; min-height: 1.65em; padding: 0 6px; }
  .diff { white-space: normal; }
  .diff-line { white-space: pre-wrap; }
  .added { color: var(--color-success); background: color-mix(in srgb, var(--color-success) 7%, transparent); }
  .removed { color: var(--color-error); background: color-mix(in srgb, var(--color-error) 7%, transparent); }
  .input-fields { margin: 0; max-height: 20rem; overflow: auto; }
  .input-fields > div + div { margin-top: 12px; }
  dt { font-size: 11px; color: var(--color-text-muted); }
  dd { margin: 2px 0 0; font: 12px/1.6 var(--font-mono); color: var(--color-text-secondary); white-space: pre-wrap; overflow-wrap: anywhere; }
  .empty { margin: 0; font-size: 12px; color: var(--color-text-muted); }
  .group-steps { display: flex; flex-direction: column; gap: 2px; }
  .raw-output { margin-top: 12px; color: var(--color-text-muted); font-size: 11px; }
  .raw-output summary { cursor: pointer; width: fit-content; }
  .raw-output pre { margin-top: 8px; }
  @media (prefers-reduced-motion: reduce) { :global(.disclosure) { transition: none; } }
</style>
