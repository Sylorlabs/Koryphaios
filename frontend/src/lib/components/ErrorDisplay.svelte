<script lang="ts">
  let { message }: { message: string } = $props();
</script>

<section class="error-display">
  <span>Failed</span>
  <pre>{message}</pre>
</section>

<style>
  .error-display {
    border: 1px solid color-mix(in srgb, var(--color-error) 40%, var(--color-border));
    background: color-mix(in srgb, var(--color-error) 8%, transparent);
    border-radius: 3px;
    overflow: hidden;
  }

  span {
    display: block;
    padding: 8px 12px;
    border-bottom: 1px solid var(--color-border);
    color: var(--color-error);
    font-size: 11px;
    font-weight: 600;
  }

  pre {
    margin: 0;
    padding: 10px 12px;
    font-family: var(--font-mono);
    font-size: 12px;
    white-space: pre-wrap;
  }
</style>
