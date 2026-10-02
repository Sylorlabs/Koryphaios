<script lang="ts">
  import Terminal from 'lucide-svelte/icons/terminal';
  import Copy from 'lucide-svelte/icons/copy';
  import Check from 'lucide-svelte/icons/check';
  import ChevronUp from 'lucide-svelte/icons/chevron-up';
  import { slide } from 'svelte/transition';

  let {
    open = false,
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
    await navigator.clipboard.writeText(content);
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
          <button type="button" onclick={copyOutput} title="Copy output">
            {#if copied}<Check size={13} />{:else}<Copy size={13} />{/if}
          </button>
        {/if}
        <button
          type="button"
          class="collapse-indicator"
          aria-label="Collapse tool output"
          title="Collapse"
          onclick={() => (open = false)}
        >
          <ChevronUp size={14} />
        </button>
      </div>
    </header>
    {#if command}
      <div class="command">$ {command}</div>
    {/if}
    {#if content}
      <pre>{content}</pre>
    {/if}
  </section>
{/if}

<style>
  .tool-panel {
    overflow: hidden;
    border: 1px solid var(--color-border);
    border-radius: 3px;
    background: var(--color-surface-1);
  }

  .tool-panel.failed {
    border-color: color-mix(in srgb, var(--color-error) 45%, var(--color-border));
  }

  header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--color-border);
    background: var(--color-surface-2);
    font-size: 11px;
    font-weight: 600;
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
    height: 24px;
    width: 24px;
    border-radius: 3px;
  }

  button:hover {
    background: var(--color-surface-3);
  }

  .collapse-indicator {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    height: 24px;
    width: 24px;
    border-radius: 3px;
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
  }

  .command {
    border-bottom: 1px solid var(--color-border);
    background: var(--color-surface-0);
  }

  pre {
    color: var(--color-text-secondary);
  }
</style>
