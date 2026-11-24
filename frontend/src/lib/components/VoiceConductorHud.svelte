<script lang="ts">
  // Compact read-out for the voice conductor: what was understood, the result,
  // an Undo when the action is reversible, and Confirm / Cancel while a
  // destructive command or an unrecognised utterance waits for a decision.
  import AudioLines from 'lucide-svelte/icons/audio-lines';
  import Check from 'lucide-svelte/icons/check';
  import Undo2 from 'lucide-svelte/icons/undo-2';
  import X from 'lucide-svelte/icons/x';
  import { voiceConductor } from '$lib/voice-conductor/conductor.svelte';
  import type { ConductorHud } from '$lib/voice-conductor/controller';

  let hud = $derived<ConductorHud | null>(voiceConductor.state.hud);
  let busy = $derived(voiceConductor.state.busy);
  let now = $state(Date.now());

  $effect(() => {
    if (!hud?.confirm) return;
    now = Date.now();
    const timer = setInterval(() => (now = Date.now()), 250);
    return () => clearInterval(timer);
  });

  let secondsLeft = $derived(
    hud?.confirm ? Math.max(0, Math.ceil((hud.confirm.expiresAt - now) / 1000)) : 0,
  );

  const TONE_COLOR: Record<string, string> = {
    info: 'var(--color-info)',
    success: 'var(--color-success)',
    warning: 'var(--color-warning)',
    error: 'var(--color-error)',
    confirm: 'var(--color-error)',
    fallback: 'var(--color-info)',
  };
</script>

{#if hud}
  {#key hud.id}
    <div
      class="conductor-hud"
      data-testid="voice-conductor-hud"
      data-tone={hud.tone}
      role={hud.confirm ? 'alertdialog' : 'status'}
      aria-live={hud.confirm ? 'assertive' : 'polite'}
      aria-label="Voice command"
      style="--hud-tone: {TONE_COLOR[hud.tone] ?? 'var(--color-info)'};"
    >
      <div class="flex items-start gap-2">
        <AudioLines size={15} class="mt-0.5 shrink-0" style="color: var(--hud-tone);" aria-hidden="true" />
        <div class="min-w-0 flex-1">
          <p class="text-[12px] font-semibold text-[var(--color-text-primary)]" data-testid="voice-conductor-title">
            {hud.title}
          </p>
          {#if hud.detail}
            <p class="mt-0.5 text-[12px] leading-snug text-[var(--color-text-secondary)]" data-testid="voice-conductor-detail">
              {hud.detail}
            </p>
          {/if}
          {#if hud.heard && hud.heard !== hud.detail}
            <p class="mt-0.5 truncate text-[11px] text-[var(--color-text-muted)]">Heard: “{hud.heard}”</p>
          {/if}
        </div>
        {#if !hud.confirm}
          <button
            type="button"
            class="hud-icon-button"
            aria-label="Dismiss voice command"
            onclick={() => voiceConductor.dismiss()}
          >
            <X size={13} />
          </button>
        {/if}
      </div>

      {#if hud.confirm}
        <div class="mt-2 flex items-center gap-2">
          <button
            type="button"
            class="hud-button hud-button-primary"
            data-testid="voice-conductor-confirm"
            disabled={busy}
            onclick={() => void voiceConductor.confirm()}
          >
            <Check size={13} aria-hidden="true" />
            {hud.confirm.label}
          </button>
          <button
            type="button"
            class="hud-button"
            data-testid="voice-conductor-cancel"
            onclick={() => voiceConductor.dismiss()}
          >
            Cancel
          </button>
          <span class="ml-auto text-[11px] tabular-nums text-[var(--color-text-muted)]">
            {hud.confirm.destructive ? `Say “yes” · ${secondsLeft}s` : 'Or say “yes”'}
          </span>
        </div>
      {:else if hud.canUndo}
        <div class="mt-2 flex items-center">
          <button
            type="button"
            class="hud-button"
            data-testid="voice-conductor-undo"
            onclick={() => void voiceConductor.undo()}
          >
            <Undo2 size={13} aria-hidden="true" />
            {hud.undoLabel ?? 'Undo'}
          </button>
        </div>
      {/if}
    </div>
  {/key}
{/if}

<style>
  .conductor-hud {
    position: fixed;
    left: 50%;
    bottom: 9.5rem;
    z-index: 60;
    width: min(26rem, calc(100vw - 2rem));
    transform: translateX(-50%);
    padding: 0.625rem 0.75rem;
    border: 1px solid var(--color-border);
    border-left: 3px solid var(--hud-tone);
    border-radius: 0.75rem;
    background: var(--color-surface-2);
    box-shadow: 0 10px 30px rgb(0 0 0 / 0.25);
    animation: hud-in 160ms ease-out;
  }

  .hud-button {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    min-height: 1.75rem;
    padding: 0.2rem 0.6rem;
    border: 1px solid var(--color-border);
    border-radius: 0.5rem;
    background: var(--color-surface-3);
    color: var(--color-text-primary);
    font-size: 12px;
    font-weight: 500;
  }

  .hud-button:hover:not(:disabled) {
    border-color: var(--hud-tone);
  }

  .hud-button:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }

  .hud-button-primary {
    border-color: var(--hud-tone);
    color: var(--hud-tone);
  }

  .hud-button:focus-visible,
  .hud-icon-button:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 2px;
  }

  .hud-icon-button {
    display: inline-flex;
    padding: 0.2rem;
    border-radius: 0.375rem;
    color: var(--color-text-muted);
  }

  .hud-icon-button:hover {
    background: var(--color-surface-3);
  }

  @keyframes hud-in {
    from {
      opacity: 0;
      transform: translate(-50%, 6px);
    }
    to {
      opacity: 1;
      transform: translate(-50%, 0);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .conductor-hud {
      animation: none;
    }
  }
</style>
