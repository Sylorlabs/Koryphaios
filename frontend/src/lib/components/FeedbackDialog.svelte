<script lang="ts">
  import { tick } from 'svelte';
  import { Bug, CheckCircle2, ExternalLink, Flag, HelpCircle, Lightbulb, X } from 'lucide-svelte';

  type FeedbackCategory = 'bug' | 'idea' | 'question' | 'other';

  interface Props {
    open?: boolean;
    onClose?: () => void;
  }

  let { open = false, onClose }: Props = $props();
  let category = $state<FeedbackCategory>('idea');
  let title = $state('');
  let message = $state('');
  let reproduction = $state('');
  let opened = $state(false);
  let appVersion = $state('Unknown');
  let platform = $state('Unknown');
  let issueContextReady: Promise<void> | null = null;
  let messageInput = $state<HTMLTextAreaElement | null>(null);

  const categories: Array<{ id: FeedbackCategory; label: string; icon: typeof Flag }> = [
    { id: 'bug', label: 'Bug', icon: Bug },
    { id: 'idea', label: 'Idea', icon: Lightbulb },
    { id: 'question', label: 'Question', icon: HelpCircle },
    { id: 'other', label: 'Other', icon: Lightbulb },
  ];

  $effect(() => {
    if (!open) return;
    opened = false;
    void tick().then(() => messageInput?.focus());
    issueContextReady = loadIssueContext();
  });

  function detectedPlatform() {
    if (typeof navigator === 'undefined') return 'Unknown';
    const userAgentData = navigator as Navigator & {
      userAgentData?: { platform?: string };
    };
    return userAgentData.userAgentData?.platform || navigator.platform || navigator.userAgent || 'Unknown';
  }

  async function loadIssueContext() {
    platform = detectedPlatform();
    appVersion = __KORYPHAIOS_FRONTEND_VERSION__ ?? 'Unknown';
    const inTauri =
      typeof window !== 'undefined' && ('__TAURI_INTERNALS__' in window || '__TAURI__' in window);

    if (inTauri) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        appVersion = await invoke<string>('get_app_version');
        return;
      } catch {
        // Fall through to the packaged app configuration below.
      }
    }

    try {
      const response = await fetch('/app.config.json');
      const config = (await response.json()) as { app?: { version?: unknown } };
      if (response.ok && typeof config.app?.version === 'string' && config.app.version.trim()) {
        appVersion = config.app.version.trim();
      }
    } catch {
      // The build-time version above remains a useful fallback for development.
    }
  }

  function close() {
    onClose?.();
  }

  function handleKeydown(event: KeyboardEvent) {
    if (open && event.key === 'Escape') close();
  }

  function issueUrl() {
    const cleanTitle = title.trim() || `${category[0].toUpperCase()}${category.slice(1)} feedback`;
    const trimmed = message.trim();
    const steps = reproduction.trim() || 'Not provided.';
    const body = [
      `**Category:** ${category}`,
      '',
      '## What happened',
      trimmed,
      '',
      '## Steps to reproduce',
      steps,
      '',
      '## App context',
      `- Koryphaios version: ${appVersion ?? 'Unknown'}`,
      `- Platform: ${platform}`,
      '',
      '> Do not include private project details, prompts, source code, secrets, or API keys.',
    ].join('\n');
    return `https://github.com/Sylorlabs/Koryphaios/issues/new?${new URLSearchParams({
      title: `[${category}] ${cleanTitle}`,
      body,
    }).toString()}`;
  }

  async function submit() {
    if (!message.trim()) {
      messageInput?.focus();
      return;
    }
    await issueContextReady;
    const url = issueUrl();
    const inTauri =
      typeof window !== 'undefined' && ('__TAURI_INTERNALS__' in window || '__TAURI__' in window);
    if (inTauri) {
      try {
        const { open } = await import('@tauri-apps/plugin-shell');
        await open(url);
      } catch (openError) {
        console.error('Failed to open GitHub issue form:', openError);
        window.open(url, '_blank', 'noopener,noreferrer');
      }
    } else {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
    opened = true;
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
      class="max-h-[calc(100vh-2rem)] w-full max-w-xl overflow-y-auto rounded-3xl border border-[var(--color-border)] bg-[var(--color-surface-1)] shadow-2xl"
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
              <Flag size={13} /> Public feedback
            </div>
            <h2 id="feedback-title" class="text-lg font-semibold text-[var(--color-text-primary)]">
              Open a GitHub issue
            </h2>
            <p class="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">
              Your report is drafted here, then opened in GitHub for you to review and submit publicly.
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

      {#if opened}
        <div class="flex flex-col items-center px-8 py-12 text-center">
          <div
            class="mb-4 grid size-14 place-items-center rounded-2xl bg-emerald-500/12 text-emerald-400"
          >
            <CheckCircle2 size={28} />
          </div>
          <h3 class="text-base font-semibold text-[var(--color-text-primary)]">
            GitHub issue draft opened
          </h3>
          <p class="mt-2 max-w-sm text-xs leading-5 text-[var(--color-text-muted)]">
            Review the prefilled issue in GitHub, then submit it when it is ready. Nothing was sent
            from Koryphaios.
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
              >Issue title</span
            >
            <input
              bind:value={title}
              maxlength="160"
              required
              placeholder="A concise summary"
              class="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-2.5 text-sm text-[var(--color-text-primary)] outline-none transition focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--color-accent)]/15"
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
              >Steps to reproduce <span class="normal-case tracking-normal">(optional)</span></span
            >
            <textarea
              bind:value={reproduction}
              maxlength="4000"
              rows="3"
              placeholder="1. Open …&#10;2. Click …&#10;3. Notice …"
              class="w-full resize-y rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-3 text-sm leading-6 text-[var(--color-text-primary)] outline-none transition focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--color-accent)]/15"
            ></textarea>
          </label>

          <aside class="border-t border-[var(--color-border)] pt-5">
            <p class="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-3 text-[10px] leading-5 text-[var(--color-text-muted)]">
              This always creates a public GitHub issue draft. It includes the category, report, steps, app version, and platform—never project files, prompts, screenshots, secrets, or API keys.
            </p>
          </aside>

          <div class="flex items-center justify-between gap-4 pt-1">
            <p class="text-[10px] leading-4 text-[var(--color-text-muted)]">
              GitHub opens next. You choose whether to submit the issue.
            </p>
            <div class="flex gap-2">
              <button
                type="button"
                class="rounded-xl px-4 py-2.5 text-xs font-semibold text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-3)]"
                onclick={close}>Cancel</button
              >
              <button
                type="submit"
                disabled={!message.trim() || !title.trim()}
                class="flex min-w-28 items-center justify-center gap-2 rounded-xl bg-[var(--color-accent)] px-5 py-2.5 text-xs font-bold text-white shadow-lg shadow-[var(--color-accent)]/15 transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-45"
              >
                <ExternalLink size={14} />Open GitHub issue
              </button>
            </div>
          </div>
        </form>
      {/if}
    </div>
  </div>
{/if}
