<script lang="ts">
  import Terminal from 'lucide-svelte/icons/terminal';
  import Copy from 'lucide-svelte/icons/copy';
  import Check from 'lucide-svelte/icons/check';
  import ChevronUp from 'lucide-svelte/icons/chevron-up';
  import { slide } from 'svelte/transition';
  import { copyText } from '$lib/utils/clipboard';
  import { requestExpandAnchor } from '$lib/utils/expand-anchor';

  let {
    open = $bindable(false),
    title = 'Tool output',
    content = '',
    command = '',
    failed = false,
  } = $props<{
    open?: boolean;
    title?: string;
    content?: string;
    command?: string;
    failed?: boolean;
  }>();

  let copied = $state(false);

  async function copyOutput() {
    await copyText(content);
    copied = true;
    setTimeout(() => (copied = false), 1200);
  }
</script>

{#if open}
  <section class="tool-panel" class:failed transition:slide={{ duration: 160 }} aria-label={title}>
    <header>
      <Terminal size={13} />
      <span>{title}</span>
      <div class="actions">
        {#if content}
          <button type="button" onclick={copyOutput} aria-label={copied ? 'Copied output' : 'Copy output'} title="Copy output">
            {#if copied}<Check size={13} />{:else}<Copy size={13} />{/if}
          </button>
        {/if}
        <button
          type="button"
          class="collapse-indicator"
          aria-label="Collapse tool output"
          title="Collapse"
          onclick={(event) => {
            requestExpandAnchor(event.currentTarget);
            open = false;
          }}
        >
          <ChevronUp size={14} />
        </button>
      </div>
    </header>
    {#if command}
      <!-- Scrollable commands must be reachable with the keyboard. -->
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <div class="command" role="region" aria-label="Command" tabindex="0">$ {command}</div>
    {/if}
    {#if content}
      <!-- Scrollable output must be reachable with the keyboard. -->
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <pre tabindex="0" aria-label={title}>{content}</pre>
    {/if}
  </section>
{/if}

<style>
  .tool-panel {
    overflow: hidden;
    border-left: 1px solid var(--color-border);
    color: var(--color-text-secondary);
  }

  .tool-panel.failed {
    border-color: color-mix(in srgb, var(--color-error) 45%, var(--color-border));
  }

  header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    font-size: var(--text-sm);
    font-weight: 500;
  }

  .actions {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 4px;
  }

  button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    height: 28px;
    width: 28px;
    border-radius: var(--radius-sm);
    color: var(--color-text-muted);
  }

  button:hover {
    background: var(--color-surface-3);
  }

  button:focus-visible,
  pre:focus-visible,
  .command:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: -2px;
  }

  .command,
  pre {
    margin: 0;
    padding: 10px 12px;
    font-family: var(--font-mono);
    font-size: 12px;
    line-height: 1.55;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    max-height: 20rem;
    overflow: auto;
    scrollbar-width: thin;
  }

  .command {
    color: var(--color-text-primary);
  }

  pre {
    color: var(--color-text-secondary);
  }
</style>
