<script lang="ts">
  import X from 'lucide-svelte/icons/x';
  import Plus from 'lucide-svelte/icons/plus';

  /** Editable list of glob patterns shown as removable chips. */
  interface Props {
    label: string;
    patterns: string[];
    placeholder?: string;
    emptyText: string;
    tone?: 'allow' | 'block';
    onchange: (patterns: string[]) => void | Promise<unknown>;
  }

  let { label, patterns, placeholder = 'e.g. git*', emptyText, tone = 'allow', onchange }: Props =
    $props();

  let draft = $state('');

  function add() {
    const value = draft.trim();
    if (!value) return;
    draft = '';
    if (patterns.includes(value)) return;
    void onchange([...patterns, value]);
  }

  function remove(pattern: string) {
    void onchange(patterns.filter((item) => item !== pattern));
  }
</script>

<div class="pattern-editor">
  <div class="pattern-chips" aria-label={label}>
    {#each patterns as pattern (pattern)}
      <span class="pattern-chip" data-tone={tone}>
        <code>{pattern}</code>
        <button type="button" aria-label={`Remove ${pattern}`} onclick={() => remove(pattern)}
          ><X size={11} /></button
        >
      </span>
    {:else}
      <span class="pattern-empty">{emptyText}</span>
    {/each}
  </div>
  <form
    class="pattern-add"
    onsubmit={(event) => {
      event.preventDefault();
      add();
    }}
  >
    <input type="text" bind:value={draft} {placeholder} aria-label={`Add to ${label}`} />
    <button type="submit" disabled={!draft.trim()} aria-label={`Add pattern to ${label}`}
      ><Plus size={12} /> Add</button
    >
  </form>
</div>

<style>
  .pattern-editor {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .pattern-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
  }
  .pattern-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    border-radius: 0.45rem;
    padding: 0.2rem 0.3rem 0.2rem 0.5rem;
    font-size: 11px;
    background: var(--color-success-bg);
    color: var(--color-success);
  }
  .pattern-chip[data-tone='block'] {
    background: var(--color-error-bg);
    color: var(--color-error);
  }
  .pattern-chip button {
    display: flex;
    border-radius: 0.3rem;
    padding: 0.1rem;
    opacity: 0.75;
  }
  .pattern-chip button:hover,
  .pattern-chip button:focus-visible {
    opacity: 1;
    outline: none;
    background: color-mix(in srgb, currentColor 18%, transparent);
  }
  .pattern-empty {
    font-size: 11px;
    color: var(--color-text-muted);
  }
  .pattern-add {
    display: flex;
    gap: 0.4rem;
  }
  .pattern-add input {
    min-width: 0;
    flex: 1;
    max-width: 16rem;
    border: 1px solid var(--color-border);
    border-radius: 0.5rem;
    background: var(--color-surface-2);
    padding: 0.3rem 0.55rem;
    font-size: 12px;
    color: var(--color-text-primary);
  }
  .pattern-add input:focus {
    outline: none;
    border-color: color-mix(in srgb, var(--color-accent) 60%, transparent);
  }
  .pattern-add button {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    border: 1px solid var(--color-border);
    border-radius: 0.5rem;
    padding: 0.3rem 0.6rem;
    font-size: 11.5px;
    color: var(--color-text-secondary);
  }
  .pattern-add button:hover:not(:disabled) {
    background: var(--color-surface-2);
    color: var(--color-text-primary);
  }
  .pattern-add button:disabled {
    opacity: 0.5;
  }
</style>
