<script lang="ts">
  import ImageOff from 'lucide-svelte/icons/image-off';
  import ScanSearch from 'lucide-svelte/icons/scan-search';
  import X from 'lucide-svelte/icons/x';
  import SettingsSwitch from './SettingsSwitch.svelte';

  interface Props {
    modelLabel: string;
    imageCount: number;
    mode: 'model-switch' | 'send';
    oncontinue: (remember: boolean) => void;
    onchoosemodel: () => void;
    oncancel: () => void;
  }

  let { modelLabel, imageCount, mode, oncontinue, onchoosemodel, oncancel }: Props = $props();
  let remember = $state(false);
  let dialogRef = $state<HTMLDivElement>();

  $effect(() => {
    dialogRef?.querySelector<HTMLButtonElement>('[data-primary]')?.focus();
  });

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      oncancel();
      return;
    }
    if (event.key !== 'Tab' || !dialogRef) return;
    const focusable = [...dialogRef.querySelectorAll<HTMLElement>('button:not([disabled])')];
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  }
</script>

<div
  class="fixed inset-0 z-[130] flex items-center justify-center bg-black/70 p-4 backdrop-blur-md"
  role="presentation"
  onmousedown={(event) => {
    if (event.target === event.currentTarget) oncancel();
  }}
>
  <div
    bind:this={dialogRef}
    class="w-full max-w-lg overflow-hidden rounded-2xl border border-[var(--color-border-bright)] bg-[var(--color-surface-1)] shadow-2xl"
    role="alertdialog"
    aria-modal="true"
    aria-labelledby="image-input-fallback-title"
    aria-describedby="image-input-fallback-description"
    tabindex="-1"
    onkeydown={handleKeydown}
  >
    <header
      class="flex items-start gap-3 border-b border-[var(--color-border)] bg-[var(--color-surface-2)] px-5 py-4"
    >
      <span
        class="mt-0.5 rounded-xl border border-amber-400/30 bg-amber-400/10 p-2 text-amber-300"
        aria-hidden="true"
      >
        <ImageOff size={20} />
      </span>
      <div class="min-w-0 flex-1">
        <h2 id="image-input-fallback-title" class="text-base font-semibold text-[var(--color-text-primary)]">
          This model can't receive the image
        </h2>
        <p id="image-input-fallback-description" class="mt-1 text-sm leading-relaxed text-[var(--color-text-secondary)]">
          <span class="font-medium text-[var(--color-text-primary)]">{modelLabel}</span>
          has no verified image transport in Koryphaios. {imageCount === 1
            ? 'One image is in this conversation.'
            : `${imageCount} images are in this conversation.`}
        </p>
      </div>
      <button
        type="button"
        class="rounded-lg p-2 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-3)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
        aria-label="Cancel image input choice"
        onclick={oncancel}
      >
        <X size={18} />
      </button>
    </header>

    <div class="space-y-4 p-5">
      <div class="grid gap-2">
        <button
          data-primary
          type="button"
          class="flex w-full items-center gap-3 rounded-xl border border-[var(--color-accent)] bg-[var(--color-accent)]/10 px-4 py-3 text-left text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-accent)]/16 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
          onclick={onchoosemodel}
        >
          <ScanSearch size={19} class="shrink-0 text-[var(--color-accent)]" />
          <span>
            <span class="block text-sm font-semibold">Choose a vision model</span>
            <span class="mt-0.5 block text-xs text-[var(--color-text-muted)]"
              >Keep the draft and images, then pick a model that reports image support.</span
            >
          </span>
        </button>
        <button
          type="button"
          class="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-3 text-left transition-colors hover:bg-[var(--color-surface-3)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
          onclick={() => oncontinue(remember)}
        >
          <span class="block text-sm font-semibold text-[var(--color-text-primary)]">
            Continue without {imageCount === 1 ? 'the image' : 'images'}
          </span>
          <span class="mt-0.5 block text-xs text-[var(--color-text-muted)]">
            {mode === 'send'
              ? 'Send this turn as text only. Images stay visible in the transcript.'
              : 'Use this model, but omit images from its provider context.'}
          </span>
        </button>
      </div>

      <SettingsSwitch
        checked={remember}
        label="Don't ask again"
        description="For models without verified vision, automatically continue without image input. You can undo this from the notice after sending."
        compact
        onchange={() => {
          remember = !remember;
        }}
      />
    </div>

    <footer class="border-t border-[var(--color-border)] bg-[var(--color-surface-0)] px-5 py-3">
      <button
        type="button"
        class="w-full rounded-lg px-3 py-2 text-xs font-medium text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
        onclick={oncancel}
      >
        Cancel and keep editing
      </button>
    </footer>
  </div>
</div>
