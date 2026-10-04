<script lang="ts">
  import { onDestroy } from 'svelte';
  import ImageOff from 'lucide-svelte/icons/image-off';
  import ScanSearch from 'lucide-svelte/icons/scan-search';
  import ShieldCheck from 'lucide-svelte/icons/shield-check';
  import X from 'lucide-svelte/icons/x';
  import SettingsSwitch from './SettingsSwitch.svelte';

  interface Props {
    modelLabel: string;
    imageCount: number;
    modelSupportsVision?: boolean;
    mode: 'model-switch' | 'send';
    onallow: (remember: boolean) => void;
    oncontinue: (remember: boolean) => void;
    onchoosemodel: () => void;
    oncancel: () => void;
  }

  let {
    modelLabel,
    imageCount,
    modelSupportsVision = false,
    mode,
    onallow,
    oncontinue,
    onchoosemodel,
    oncancel,
  }: Props = $props();
  let remember = $state(false);
  let dialogRef = $state<HTMLDivElement>();
  const previouslyFocused =
    typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null);

  onDestroy(() => {
    if (previouslyFocused?.isConnected) previouslyFocused.focus();
  });

  const imageLabel = $derived(imageCount === 1 ? 'image' : 'images');
  const actionDescription = $derived(
    mode === 'send'
      ? 'Send this message with images. You’re confirming image support for this model.'
      : 'Select this model and keep the images. You’re confirming its image support.',
  );

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
  class="fixed inset-0 z-[130] flex items-center justify-center bg-black/65 p-4 backdrop-blur-sm"
  role="presentation"
  onmousedown={(event) => {
    if (event.target === event.currentTarget) oncancel();
  }}
>
  <div
    bind:this={dialogRef}
    class="max-h-[calc(100dvh-2rem)] w-full max-w-xl overflow-y-auto rounded-xl border border-[var(--color-border-bright)] bg-[var(--color-surface-0)] shadow-2xl"
    role="alertdialog"
    aria-modal="true"
    aria-labelledby="image-input-fallback-title"
    aria-describedby="image-input-fallback-description"
    tabindex="-1"
    onkeydown={handleKeydown}
  >
    <header class="flex items-start gap-4 px-6 py-5">
      <div class="mt-0.5 shrink-0 text-[var(--color-warning)]" aria-hidden="true">
        <ImageOff size={22} strokeWidth={1.8} />
      </div>
      <div class="min-w-0 flex-1">
        <p
          class="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--color-text-muted)]"
        >
          Image input
        </p>
        <h2
          id="image-input-fallback-title"
          class="mt-1 text-lg font-semibold text-[var(--color-text-primary)]"
        >
          Confirm image support
        </h2>
        <p
          id="image-input-fallback-description"
          class="mt-2 text-sm leading-relaxed text-[var(--color-text-secondary)]"
        >
          <span class="font-medium text-[var(--color-text-primary)]">{modelLabel}</span>
          {modelSupportsVision
            ? 'supports vision, but image delivery through this provider is unconfirmed.'
            : 'hasn’t reported image support. Its capability information may be incomplete.'}
          There {imageCount === 1 ? 'is' : 'are'}
          {imageCount}
          {imageLabel} in this conversation.
        </p>
      </div>
      <button
        type="button"
        class="shrink-0 p-1 text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
        aria-label="Cancel image input choice"
        onclick={oncancel}
      >
        <X size={18} />
      </button>
    </header>

    <div class="border-y border-[var(--color-border)]">
      <button
        data-primary
        type="button"
        class="group flex w-full items-start gap-4 px-6 py-4 text-left transition-colors hover:bg-[var(--color-surface-2)] focus-visible:bg-[var(--color-surface-2)] focus-visible:outline-none"
        onclick={() => onallow(remember)}
      >
        <ShieldCheck
          size={20}
          class="mt-0.5 shrink-0 text-[var(--color-accent)]"
          strokeWidth={1.8}
        />
        <span class="min-w-0 flex-1">
          <span class="block text-sm font-semibold text-[var(--color-text-primary)]">
            This model supports images
          </span>
          <span class="mt-1 block text-xs leading-relaxed text-[var(--color-text-muted)]">
            {actionDescription}
          </span>
        </span>
        <span
          class="mt-0.5 text-xs font-medium text-[var(--color-accent)] opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
        >
          Use images
        </span>
      </button>

      <button
        type="button"
        class="group flex w-full items-start gap-4 border-t border-[var(--color-border)] px-6 py-4 text-left transition-colors hover:bg-[var(--color-surface-2)] focus-visible:bg-[var(--color-surface-2)] focus-visible:outline-none"
        onclick={onchoosemodel}
      >
        <ScanSearch
          size={20}
          class="mt-0.5 shrink-0 text-[var(--color-text-secondary)]"
          strokeWidth={1.8}
        />
        <span class="min-w-0 flex-1">
          <span class="block text-sm font-semibold text-[var(--color-text-primary)]"
            >Choose a vision model</span
          >
          <span class="mt-1 block text-xs leading-relaxed text-[var(--color-text-muted)]">
            Keep the draft and images, then choose a model with verified image transport.
          </span>
        </span>
        <span
          class="mt-0.5 text-xs font-medium text-[var(--color-text-secondary)] opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
        >
          Change model
        </span>
      </button>

      <button
        type="button"
        class="group flex w-full items-start gap-4 border-t border-[var(--color-border)] px-6 py-4 text-left transition-colors hover:bg-[var(--color-surface-2)] focus-visible:bg-[var(--color-surface-2)] focus-visible:outline-none"
        onclick={() => oncontinue(remember)}
      >
        <ImageOff
          size={20}
          class="mt-0.5 shrink-0 text-[var(--color-text-secondary)]"
          strokeWidth={1.8}
        />
        <span class="min-w-0 flex-1">
          <span class="block text-sm font-semibold text-[var(--color-text-primary)]">
            Continue without {imageCount === 1 ? 'the image' : 'images'}
          </span>
          <span class="mt-1 block text-xs leading-relaxed text-[var(--color-text-muted)]">
            {mode === 'send' ? 'Send text only.' : 'Use this model with text only.'}
            {imageCount === 1 ? 'The image stays' : 'Images stay'} visible in the transcript.
          </span>
        </span>
        <span
          class="mt-0.5 text-xs font-medium text-[var(--color-text-secondary)] opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
        >
          Continue
        </span>
      </button>
    </div>

    <div class="px-6 py-4">
      <SettingsSwitch
        checked={remember}
        label="Remember my choice"
        description="Image support is remembered for this model. Text-only skips future image prompts."
        compact
        flat
        onchange={() => {
          remember = !remember;
        }}
      />
    </div>

    <footer class="flex justify-end border-t border-[var(--color-border)] px-6 py-3">
      <button
        type="button"
        class="px-2 py-1 text-xs font-medium text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
        onclick={oncancel}
      >
        Cancel and keep editing
      </button>
    </footer>
  </div>
</div>
