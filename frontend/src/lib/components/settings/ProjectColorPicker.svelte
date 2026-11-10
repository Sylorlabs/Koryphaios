<script lang="ts">
  import { normalizeProjectIconCustomColor } from '@koryphaios/shared';

  interface Props {
    value: string;
    disabled?: boolean;
    onchange: (value: string) => unknown;
    onclear: () => unknown;
  }

  let { value, disabled = false, onchange, onclear }: Props = $props();

  const fallbackColor = '#D5B261';
  let hexInput = $state('');
  let editing = $state(false);
  let invalid = $state(false);

  $effect(() => {
    if (!editing) hexInput = value || fallbackColor;
  });

  function commit(next: string): void {
    const normalized = normalizeProjectIconCustomColor(next);
    if (!normalized) {
      invalid = true;
      return;
    }
    invalid = false;
    hexInput = normalized;
    void onchange(normalized);
  }

  function clear(): void {
    invalid = false;
    editing = false;
    void onclear();
  }
</script>

<div class="space-y-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-1)] p-3">
  <div class="flex items-start justify-between gap-3">
    <div>
      <p class="text-xs font-semibold text-[var(--color-text-primary)]">Custom color</p>
      <p class="mt-1 text-[11px] leading-relaxed text-[var(--color-text-muted)]">
        Use any hex color for the icon accent. It stays project-scoped and is validated before it is
        saved.
      </p>
    </div>
    {#if value}
      <button
        type="button"
        class="shrink-0 rounded-lg border border-[var(--color-border)] px-2.5 py-1.5 text-[11px] font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-3)] hover:text-[var(--color-text-primary)] disabled:opacity-50"
        {disabled}
        onclick={clear}
      >
        Use palette
      </button>
    {/if}
  </div>

  <div class="flex items-center gap-3">
    <label
      class="relative flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] shadow-inner focus-within:ring-2 focus-within:ring-[var(--color-accent)]/60"
      style={`background: ${value || fallbackColor};`}
    >
      <span class="sr-only">Choose custom color</span>
      <input
        type="color"
        aria-label="Custom color"
        value={value || fallbackColor}
        disabled={disabled}
        class="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
        oninput={(event) => commit((event.currentTarget as HTMLInputElement).value)}
      />
    </label>
    <div class="min-w-0 flex-1">
      <label
        for="project-custom-color"
        class="mb-1.5 block text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--color-text-muted)]"
      >
        Hex value
      </label>
      <input
        id="project-custom-color"
        type="text"
        aria-label="Custom hex color"
        value={hexInput}
        maxlength="7"
        spellcheck="false"
        disabled={disabled}
        class="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 font-mono text-xs uppercase text-[var(--color-text-primary)] outline-none transition-colors focus:border-[var(--color-accent)] disabled:opacity-50"
        onfocus={() => (editing = true)}
        oninput={(event) => {
          hexInput = (event.currentTarget as HTMLInputElement).value;
          invalid = false;
        }}
        onblur={() => {
          editing = false;
          commit(hexInput);
          if (invalid) hexInput = value || fallbackColor;
        }}
        onkeydown={(event) => {
          if (event.key === 'Enter') (event.currentTarget as HTMLInputElement).blur();
        }}
      />
    </div>
  </div>

  {#if invalid}
    <p role="alert" class="text-[11px] text-[var(--color-error)]">Enter a valid hex color, such as #D5B261.</p>
  {/if}
</div>
