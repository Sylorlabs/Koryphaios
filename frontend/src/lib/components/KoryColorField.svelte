<script module lang="ts">
  let nextInputId = 0;
</script>

<script lang="ts">
  import Check from 'lucide-svelte/icons/check';
  import ChevronDown from 'lucide-svelte/icons/chevron-down';
  import { onMount, tick } from 'svelte';

  interface Props {
    value: string;
    label: string;
    onchange: (value: string) => unknown | Promise<unknown>;
    disabled?: boolean;
  }

  let { value, label, onchange, disabled = false }: Props = $props();
  const inputId = `kory-color-value-${++nextInputId}`;
  let open = $state(false);
  let draft = $state('');
  let root = $state<HTMLDivElement>();
  let trigger = $state<HTMLButtonElement>();
  let dialog = $state<HTMLDivElement>();

  const presets = [
    '#D5B261',
    '#7AA2F7',
    '#81A1C1',
    '#A78BFA',
    '#FF79C6',
    '#34D399',
    '#F59E0B',
    '#F87171',
  ];

  $effect(() => {
    if (!open) draft = value;
  });

  function normalizeHex(candidate: string): string | null {
    const trimmed = candidate.trim();
    const match = /^#?([0-9a-f]{6})$/i.exec(trimmed);
    return match ? `#${match[1].toUpperCase()}` : null;
  }

  function closePicker(returnFocus = true) {
    open = false;
    draft = value;
    if (returnFocus) void tick().then(() => trigger?.focus());
  }

  function openPicker() {
    if (disabled) return;
    if (open) {
      closePicker();
      return;
    }
    draft = value;
    open = true;
    void tick().then(() => dialog?.focus());
  }

  function choose(candidate: string) {
    const normalized = normalizeHex(candidate);
    if (!normalized) {
      draft = value;
      return;
    }
    draft = normalized;
    open = false;
    void onchange(normalized);
    void tick().then(() => trigger?.focus());
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closePicker();
    }
  }

  onMount(() => {
    const close = (event: PointerEvent) => {
      if (!root?.contains(event.target as Node)) {
        closePicker(false);
      }
    };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  });
</script>

<div class="relative" bind:this={root}>
  <button
    bind:this={trigger}
    type="button"
    {disabled}
    aria-label={label}
    aria-haspopup="dialog"
    aria-expanded={open}
    onkeydown={handleKeydown}
    onclick={openPicker}
    class="flex h-10 min-w-32 items-center gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2.5 text-xs text-[var(--color-text-primary)] outline-none transition-colors hover:border-[var(--color-accent)]/50 focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/55 disabled:cursor-not-allowed disabled:opacity-50"
  >
    <span
      class="h-6 w-6 shrink-0 rounded-lg border border-[var(--color-border-bright)] shadow-inner"
      style="background: {value};"
      aria-hidden="true"
    ></span>
    <span class="min-w-0 flex-1 font-mono">{value.toUpperCase()}</span>
    <ChevronDown
      size={13}
      class="shrink-0 text-[var(--color-text-muted)] transition-transform {open
        ? 'rotate-180'
        : ''}"
    />
  </button>

  {#if open}
    <div
      bind:this={dialog}
      role="dialog"
      tabindex="-1"
      aria-label={`${label} picker`}
      onkeydown={handleKeydown}
      class="absolute right-0 z-[130] mt-2 w-64 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-1)] p-3 shadow-2xl shadow-black/35"
    >
      <div class="grid grid-cols-8 gap-1.5" aria-label="Suggested colors">
        {#each presets as preset (preset)}
          <button
            type="button"
            aria-label={`Use ${preset}`}
            aria-pressed={preset.toLowerCase() === value.toLowerCase()}
            onclick={() => choose(preset)}
            class="flex h-7 w-7 items-center justify-center rounded-lg border border-[var(--color-border-bright)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/70"
            style="background: {preset};"
          >
            {#if preset.toLowerCase() === value.toLowerCase()}<Check
                size={13}
                class="text-white drop-shadow"
              />{/if}
          </button>
        {/each}
      </div>
      <label for={inputId} class="mt-3 block text-[10px] font-medium text-[var(--color-text-muted)]"
        >Custom hex color</label
      >
      <div class="mt-1.5 flex gap-2">
        <input
          id={inputId}
          type="text"
          maxlength="7"
          spellcheck="false"
          bind:value={draft}
          onkeydown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              choose(draft);
            }
          }}
          class="h-10 min-w-0 flex-1 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-0)] px-3 font-mono text-xs uppercase text-[var(--color-text-primary)] outline-none focus-visible:border-[var(--color-accent)] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/40"
        />
        <button
          type="button"
          onclick={() => choose(draft)}
          disabled={!normalizeHex(draft)}
          class="h-10 rounded-xl bg-[var(--color-accent)] px-3 text-xs font-semibold text-[var(--color-surface-0)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/70 disabled:cursor-not-allowed disabled:opacity-40"
          >Apply</button
        >
      </div>
    </div>
  {/if}
</div>
