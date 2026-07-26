<script lang="ts">
  import { tick } from 'svelte';
  import { Bug, CheckCircle2, Flag, HelpCircle, Lightbulb, LoaderCircle, X } from 'lucide-svelte';
  import { apiFetch, parseJsonResponse } from '$lib/api.svelte';
  import { apiUrl } from '$lib/utils/api-url';
  import KorySelect from '$lib/components/KorySelect.svelte';
  import Turnstile from '$lib/components/Turnstile.svelte';

  type FeedbackCategory = 'bug' | 'idea' | 'question' | 'other';
  type FeedbackVisibility = 'private' | 'public';

  interface Props {
    open?: boolean;
    onClose?: () => void;
  }

  let { open = false, onClose }: Props = $props();
  let category = $state<FeedbackCategory>('idea');
  let visibility = $state<FeedbackVisibility>('private');
  let message = $state('');
  let email = $state('');
  let includeDiagnostics = $state(true);
  let submitting = $state(false);
  let sent = $state(false);
  let error = $state('');
  let appVersion = $state<string | undefined>();
  let messageInput = $state<HTMLTextAreaElement | null>(null);
  let turnstile = $state<Turnstile | null>(null);
  let turnstileSiteKey = $state(import.meta.env.VITE_TURNSTILE_SITE_KEY?.trim() || '');

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
    if (!turnstileSiteKey) {
      void fetch('https://koryphaios.com/api/feedback')
        .then((response) => (response.ok ? response.json() : null))
        .then((config: { turnstileSiteKey?: unknown } | null) => {
          if (typeof config?.turnstileSiteKey === 'string') turnstileSiteKey = config.turnstileSiteKey;
        })
        .catch(() => {});
    }
  });

  function close() {
    if (submitting) return;
    onClose?.();
  }

  function handleKeydown(event: KeyboardEvent) {
    if (open && event.key === 'Escape') close();
  }

  async function submit() {
    const trimmed = message.trim();
    if (!trimmed) {
      error = 'Tell us what happened before sending.';
      messageInput?.focus();
      return;
    }

    submitting = true;
    error = '';
    try {
      const diagnostics = includeDiagnostics
        ? {
            platform: typeof navigator !== 'undefined' ? navigator.platform : undefined,
            context:
              typeof window !== 'undefined' ? { route: window.location.pathname } : undefined,
          }
        : {};
      const isPublic = visibility === 'public';
      // Invisible for normal users; Cloudflare only shows a challenge when risk warrants it.
      const turnstileToken = await turnstile?.execute();
      const response = await apiFetch(
        apiUrl('/api/feedback'),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            category,
            visibility,
            message: trimmed,
            ...(turnstileToken ? { turnstileToken } : {}),
            ...(!isPublic ? diagnostics : {}),
            ...(!isPublic && email.trim() ? { email: email.trim() } : {}),
            ...(appVersion ? { appVersion } : {}),
          }),
        },
        15_000,
      );
      const result = await parseJsonResponse<{ ok?: boolean; error?: string }>(response);
      if (!response.ok || !result.ok)
        throw new Error(result.error || 'Feedback could not be delivered right now');
      sent = true;
      turnstile?.reset();
      message = '';
      email = '';
    } catch (submitError) {
      error =
        submitError instanceof Error
          ? submitError.message
          : 'Feedback could not be delivered right now';
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
              Stored locally by default. It never changes production prompts automatically.
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
            Feedback delivered
          </h3>
          <p class="mt-2 max-w-sm text-xs leading-5 text-[var(--color-text-muted)]">
            Thanks. Your report is in the team inbox and includes no identity unless you added a
            reply address.
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
              >Who should see this?</span
            >
            <KorySelect
              value={visibility}
              label="Feedback visibility"
              options={[
                {
                  value: 'private',
                  label: 'Private feedback',
                  description: 'Sent only to the Koryphaios team inbox.',
                },
                {
                  value: 'public',
                  label: 'Public feedback',
                  description: 'Published as a public community report on koryphaios.com. Never includes your email or diagnostics.',
                },
              ]}
              onchange={(value) => {
                visibility = value as FeedbackVisibility;
                if (visibility === 'public') {
                  email = '';
                  includeDiagnostics = false;
                }
              }}
            />
          </label>

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

          <label class="block">
            <span
              class="mb-2 block text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]"
              >Reply email <span class="normal-case tracking-normal">(optional)</span></span
            >
            <input
              type="email"
              bind:value={email}
              maxlength="254"
              autocomplete="email"
              placeholder="Leave blank to stay anonymous"
              class="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-2.5 text-xs text-[var(--color-text-primary)] outline-none transition focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--color-accent)]/15"
            />
          </label>

          {#if visibility === 'private'}<button
            type="button"
            role="switch"
            aria-checked={includeDiagnostics}
            class="flex w-full items-center justify-between gap-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-3 text-left"
            onclick={() => (includeDiagnostics = !includeDiagnostics)}
          >
            <span
              ><span class="block text-xs font-semibold text-[var(--color-text-primary)]"
                >Include basic diagnostics</span
              ><span class="mt-0.5 block text-[10px] text-[var(--color-text-muted)]"
                >App version, platform, and current app route. Never prompts, files, or API keys.</span
              ></span
            >
            <span
              class="relative h-5 w-9 shrink-0 rounded-full transition-colors {includeDiagnostics
                ? 'bg-[var(--color-accent)]'
                : 'bg-[var(--color-surface-4)]'}"
              ><span
                class="absolute top-0.5 size-4 rounded-full bg-white shadow transition-transform {includeDiagnostics
                  ? 'translate-x-[18px]'
                  : 'translate-x-0.5'}"
              ></span></span
            >
          </button>{:else}<p
              class="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-3 text-[10px] leading-5 text-[var(--color-text-muted)]"
            >
              Public reports include only the category, message, and optional app version. Do not include private project details, secrets, or contact information.
            </p>{/if}

          {#if error}<p
              role="alert"
              class="rounded-xl border border-red-500/25 bg-red-500/10 px-3 py-2.5 text-xs text-red-300"
            >
              {error}
            </p>{/if}

          {#if turnstileSiteKey}
            <Turnstile bind:this={turnstile} siteKey={turnstileSiteKey} />
          {/if}

          <div class="flex items-center justify-between gap-4 pt-1">
            <p class="text-[10px] leading-4 text-[var(--color-text-muted)]">
              {visibility === 'public'
                ? 'Public reports are published without email, diagnostics, source, prompts, screenshots, or API keys.'
                : 'We never upload source, prompts, screenshots, or API keys.'}
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
                {#if submitting}<LoaderCircle size={14} class="animate-spin" />Sending{:else}Send
                  feedback{/if}
              </button>
            </div>
          </div>
        </form>
      {/if}
    </div>
  </div>
{/if}
