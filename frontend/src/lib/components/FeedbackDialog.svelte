<script lang="ts">
  import { tick } from 'svelte';
  import { ArrowUpRight, Bug, CheckCircle2, Flag, HelpCircle, Lightbulb, LoaderCircle, X } from 'lucide-svelte';

  type FeedbackCategory = 'bug' | 'idea' | 'question' | 'other';

  const ISSUE_URL = 'https://github.com/Sylorlabs/Koryphaios/issues/new';

  interface Props {
    open?: boolean;
    onClose?: () => void;
  }

  let { open = false, onClose }: Props = $props();
  let category = $state<FeedbackCategory>('idea');
  let message = $state('');
  let sent = $state(false);
  let submitting = $state(false);
  let error = $state('');
  let appVersion = $state<string | undefined>();
  let messageInput = $state<HTMLTextAreaElement | null>(null);

  const categories: Array<{ id: FeedbackCategory; label: string; icon: typeof Flag }> = [
    { id: 'bug', label: 'Bug', icon: Bug },
    { id: 'idea', label: 'Idea', icon: Lightbulb },
    { id: 'question', label: 'Question', icon: HelpCircle },
    { id: 'other', label: 'Other', icon: Lightbulb },
  ];

  $effect(() => {
    if (!open) return;
    sent = false;
    error = '';
    void tick().then(() => messageInput?.focus());
    if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
      void import('@tauri-apps/api/app')
        .then(({ getVersion }) => getVersion())
        .then((version) => {
          appVersion = version;
        })
        .catch(() => {});
    }
  });

  function close() {
    onClose?.();
  }

  function handleKeydown(event: KeyboardEvent) {
    if (open && event.key === 'Escape') close();
  }

  async function openIssue(url: string): Promise<boolean> {
    const inTauri =
      typeof window !== 'undefined' &&
      ('__TAURI_INTERNALS__' in window || '__TAURI__' in window);
    if (inTauri) {
      try {
        const { open } = await import('@tauri-apps/plugin-shell');
        await open(url);
        return true;
      } catch (err) {
        console.error('[Koryphaios] Failed to open issue page via shell:', err);
      }
    }
    try {
      return window.open(url, '_blank', 'noopener,noreferrer') !== null;
    } catch (err) {
      console.error('[Koryphaios] Failed to open issue page:', err);
      return false;
    }
    return false;
  }

  async function submit() {
    const trimmed = message.trim();
    if (!trimmed) {
      messageInput?.focus();
      return;
    }

    submitting = true;
    error = '';
    const type = categories.find((option) => option.id === category)?.label.toLowerCase() ?? 'feedback';
    const title = `[${type}] ${trimmed.slice(0, 80)}`;
    const body = [trimmed, ...(appVersion ? [``, `**App version:** ${appVersion}`] : [])].join(
      '\n',
    );
    try {
      const opened = await openIssue(`${ISSUE_URL}?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`);
      if (!opened) {
        error = 'Could not open GitHub to create the report. Check your connection and try again.';
        return;
      }
      sent = true;
      message = '';
    } finally {
      submitting = false;
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

{#if open}
  <div
    class="fixed inset-0 z-[100] flex items-center justify-center bg-black/65 p-4 backdrop-blur-sm"
    role="presentation"
    onclick={(event) => event.currentTarget === event.target && close()}
  >
    <div
      class="w-full max-w-xl overflow-hidden rounded-3xl border border-[var(--color-border)] bg-[var(--color-surface-1)] shadow-2xl"
      role="dialog"
      aria-modal="true"
      aria-labelledby="feedback-title"
    >
      <div class="relative border-b border-[var(--color-border)] px-6 py-5">
        <div
          class="pointer-events-none absolute inset-0 bg-gradient-to-br from-[var(--color-accent)]/12 via-transparent to-violet-500/8"
        ></div>
        <div class="relative flex items-start justify-between gap-4">
          <div>
            <div
              class="mb-2 flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.16em] text-[var(--color-accent)]"
            >
              <Flag size={13} /> Direct feedback
            </div>
            <h2 id="feedback-title" class="text-lg font-semibold text-[var(--color-text-primary)]">
              Help shape Koryphaios
            </h2>
            <p class="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">
              Submitting opens a GitHub issue in the Koryphaios repository.
            </p>
          </div>
          <button
            type="button"
            class="rounded-xl p-2 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-3)] hover:text-[var(--color-text-primary)]"
            aria-label="Close feedback"
            onclick={close}><X size={18} /></button
          >
        </div>
      </div>

      {#if sent}
        <div class="flex flex-col items-center px-8 py-12 text-center">
          <div
            class="mb-4 grid size-14 place-items-center rounded-2xl bg-emerald-500/12 text-emerald-400"
          >
            <CheckCircle2 size={28} />
          </div>
          <h3 class="text-base font-semibold text-[var(--color-text-primary)]">
            Opening GitHub issue
          </h3>
          <p class="mt-2 max-w-sm text-xs leading-5 text-[var(--color-text-muted)]">
            GitHub opened with your report filled in. Review it there and submit when ready — no
            reply email is needed.
          </p>
          <button
            type="button"
            class="mt-6 rounded-xl bg-[var(--color-accent)] px-5 py-2.5 text-xs font-bold text-white"
            onclick={close}>Done</button
          >
        </div>
      {:else}
        <form
          class="space-y-5 px-6 py-6"
          onsubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <fieldset>
            <legend
              class="mb-2 text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]"
              >What kind of feedback?</legend
            >
            <div class="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {#each categories as option (option.id)}
                <button
                  type="button"
                  aria-pressed={category === option.id}
                  class="flex items-center justify-center gap-2 rounded-xl border px-3 py-2.5 text-xs font-semibold transition-colors {category ===
                  option.id
                    ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/12 text-[var(--color-accent)]'
                    : 'border-[var(--color-border)] bg-[var(--color-surface-2)] text-[var(--color-text-secondary)] hover:border-[var(--color-border-bright)]'}"
                  onclick={() => (category = option.id)}
                  ><option.icon size={14} />{option.label}</button
                >
              {/each}
            </div>
          </fieldset>

          <label class="block">
            <span
              class="mb-2 block text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]"
              >What should we know?</span
            >
            <textarea
              bind:this={messageInput}
              bind:value={message}
              maxlength="8000"
              rows="6"
              required
              placeholder="Share the details that would help us act on this."
              class="w-full resize-y rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-3 text-sm leading-6 text-[var(--color-text-primary)] outline-none transition focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--color-accent)]/15"
            ></textarea>
            <span class="mt-1 block text-right text-[10px] text-[var(--color-text-muted)]"
              >{message.length.toLocaleString()} / 8,000</span
            >
          </label>

          <p
            class="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-3 text-[10px] leading-5 text-[var(--color-text-muted)]"
          >
            The report is created on GitHub. It includes only the category, message, and optional
            app version. Do not include private project details, secrets, or contact information.
          </p>

          {#if error}<p
              role="alert"
              class="rounded-xl border border-red-500/25 bg-red-500/10 px-3 py-2.5 text-xs text-red-300"
            >
              {error}
            </p>{/if}

          <div class="flex items-center justify-between gap-4 pt-1">
            <p class="text-[10px] leading-4 text-[var(--color-text-muted)]">
              Reports never include diagnostics, source, prompts, screenshots, or API keys.
            </p>
            <div class="flex gap-2">
              <button
                type="button"
                class="rounded-xl px-4 py-2.5 text-xs font-semibold text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-3)]"
                onclick={close}>Cancel</button
              >
              <button
                type="submit"
                disabled={submitting || !message.trim()}
                class="flex min-w-28 items-center justify-center gap-2 rounded-xl bg-[var(--color-accent)] px-5 py-2.5 text-xs font-bold text-white shadow-lg shadow-[var(--color-accent)]/15 transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-45"
              >
                {#if submitting}<LoaderCircle size={14} class="animate-spin" />Opening GitHub{:else}<ArrowUpRight size={14} />Create issue{/if}
              </button>
            </div>
          </div>
        </form>
      {/if}
    </div>
  </div>
{/if}
