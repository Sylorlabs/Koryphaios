<script lang="ts">
  let {
    command,
    output = '',
    failed = false,
  } = $props<{
    command: string;
    output?: string;
    failed?: boolean;
  }>();
</script>

<div class="command-result" class:failed>
  <div class="command">$ {command}</div>
  {#if output}
    <pre>{output}</pre>
  {/if}
</div>

<style>
  .command-result {
    border: 1px solid var(--color-border);
    border-radius: 3px;
    overflow: hidden;
  }

  .failed {
    border-color: color-mix(in srgb, var(--color-error) 40%, var(--color-border));
  }

  .command,
  pre {
    margin: 0;
    padding: 10px 12px;
    font-family: var(--font-mono);
    font-size: 12px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .command {
    background: var(--color-surface-0);
    border-bottom: 1px solid var(--color-border);
  }
</style>
