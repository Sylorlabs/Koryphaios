<script lang="ts">
  import { onMount } from 'svelte';
  import type { NoteDraftSummary, NoteRelationship } from '@koryphaios/shared';
  import Share2 from 'lucide-svelte/icons/share-2';
  import FileText from 'lucide-svelte/icons/file-text';
  import History from 'lucide-svelte/icons/history';
  import { notesStore } from '$lib/stores/notes.svelte';
  import { apiFetch } from '$lib/api.svelte';
  import { apiUrl } from '$lib/utils/api-url';

  let {
    projectPath,
    onOpenNote,
    onOpenNetwork,
    onPendingCount,
  }: {
    projectPath: string | null;
    onOpenNote: (id: string) => void;
    onOpenNetwork: () => void;
    onPendingCount?: (count: number) => void;
  } = $props();

  let proposals = $state<NoteRelationship[]>([]);
  let staleAccepted = $state<NoteRelationship[]>([]);
  let drafts = $state<NoteDraftSummary[]>([]);
  let draftsError = $state('');
  let errors = $state<Record<string, string>>({});
  let busy = $state<Record<string, boolean>>({});
  let generation = 0;
  const requests = new Map<string, AbortController>();

  const pendingCount = $derived(proposals.length + drafts.length);

  interface Envelope<T> {
    data: T;
    success?: boolean;
    ok?: boolean;
    error?: string | { message?: string };
  }

  function begin(lane: string) {
    requests.get(lane)?.abort();
    const controller = new AbortController();
    requests.set(lane, controller);
    const scope = projectPath;
    const epoch = generation;
    const current = () =>
      !controller.signal.aborted &&
      scope === projectPath &&
      epoch === generation &&
      requests.get(lane) === controller;
    busy[lane] = true;
    errors[lane] = '';
    return { controller, scope, current };
  }

  async function request<T>(
    path: string,
    op: ReturnType<typeof begin>,
    method = 'GET',
    body?: unknown,
  ): Promise<Envelope<T>> {
    if (!op.scope) throw new Error('Choose a project first.');
    const response = await apiFetch(apiUrl(`/api/notes${path}`), {
      method,
      signal: op.controller.signal,
      headers: {
        'X-Koryphaios-Project': op.scope,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = (await response.json()) as Envelope<T>;
    if (!response.ok || result.success === false || result.ok === false) {
      if (response.status === 409) {
        throw new Error(
          'This change moved on while you reviewed it. Reload the review queue and decide on the current version.',
        );
      }
      throw new Error(
        typeof result.error === 'string'
          ? result.error
          : (result.error?.message ?? `Request failed (${response.status}).`),
      );
    }
    return result;
  }

  function failed(lane: string, op: ReturnType<typeof begin>, error: unknown) {
    if (op.current()) errors[lane] = error instanceof Error ? error.message : 'Request failed.';
  }

  async function loadRelationships() {
    const op = begin('relationships');
    try {
      const [proposedResult, acceptedResult] = await Promise.all([
        request<NoteRelationship[]>('/relationships?status=proposed&limit=100', op),
        request<NoteRelationship[]>('/relationships?status=accepted&limit=100', op),
      ]);
      if (!op.current()) return;
      proposals = proposedResult.data;
      staleAccepted = acceptedResult.data.filter((row) => row.stale);
    } catch (error) {
      failed('relationships', op, error);
    } finally {
      if (op.current()) busy['relationships'] = false;
    }
  }

  async function loadDrafts() {
    const op = begin('drafts');
    try {
      const result = await request<NoteDraftSummary[]>('/drafts', op);
      if (!op.current()) return;
      drafts = result.data;
      draftsError = '';
    } catch (error) {
      failed('drafts', op, error);
      if (op.current())
        draftsError = error instanceof Error ? error.message : 'Failed to load drafts.';
    } finally {
      if (op.current()) busy['drafts'] = false;
    }
  }

  async function openDraft(draft: NoteDraftSummary) {
    // Reuse NotesPanel's full recovery workflow (conflict confirmation, orphan
    // copy, durable backup attach, and explicit-save requirement). Do not
    // replace it with an eager edit or a silent discard.
    if (typeof window === 'undefined') return;
    window.dispatchEvent(
      new CustomEvent('kory-notes-review-draft', { detail: { draftId: draft.id } }),
    );
  }

  async function review(row: NoteRelationship, status: 'accepted' | 'rejected') {
    if (busy['review'] || row.status !== 'proposed' || (status === 'accepted' && row.stale)) return;
    const op = begin('review');
    try {
      await request(
        `/relationships/${encodeURIComponent(row.fromId)}/${encodeURIComponent(row.toId)}`,
        op,
        'PATCH',
        { status, expectedRevision: row.revision },
      );
      if (!op.current()) return;
      await loadRelationships();
    } catch (error) {
      failed('review', op, error);
    } finally {
      if (op.current()) busy['review'] = false;
    }
  }

  async function discard(draft: NoteDraftSummary) {
    if (busy['discard']) return;
    const op = begin('discard');
    try {
      await request(`/drafts/${encodeURIComponent(draft.id)}/discard`, op, 'POST', {
        expectedDraftRevision: draft.draftRevision,
      });
      if (!op.current()) return;
      await loadDrafts();
    } catch (error) {
      failed('discard', op, error);
    } finally {
      if (op.current()) busy['discard'] = false;
    }
  }

  async function reload() {
    generation++;
    await Promise.all([loadRelationships(), loadDrafts()]);
  }

  $effect(() => {
    // Count badge stays advisory; the tab renders its own queue on open.
    onPendingCount?.(pendingCount);
  });

  onMount(() => {
    if (projectPath) void reload();
    return () => {
      generation++;
      for (const controller of requests.values()) controller.abort();
    };
  });
</script>

<section aria-label="Change review" class="flex h-full flex-col gap-4 overflow-y-auto p-4">
  <header class="flex items-start justify-between gap-3">
    <div>
      <h2 class="text-sm font-semibold" style="color: var(--color-text-primary);">Change review</h2>
      <p class="mt-1 text-xs leading-5" style="color: var(--color-text-muted);">
        Everything the agent has proposed but not yet settled: relationship evidence waiting for a
        decision, accepted evidence whose endpoints moved, and recovery drafts. Nothing here is
        accepted automatically.
      </p>
    </div>
    <button
      type="button"
      class="rounded-lg px-2.5 py-1.5 text-xs transition-colors hover:bg-[var(--color-surface-3)]"
      style="color: var(--color-text-muted);"
      onclick={() => void reload()}
      disabled={busy['relationships'] || busy['drafts']}
    >
      Refresh
    </button>
  </header>

  <section aria-label="Proposed relationships" class="card">
    <div class="flex items-center gap-2 px-4 pt-4">
      <Share2 size={13} style="color: var(--color-text-muted);" />
      <h3
        class="text-xs font-semibold uppercase tracking-wider"
        style="color: var(--color-text-muted);"
      >
        Proposed relationships ({proposals.length})
      </h3>
    </div>
    {#if errors['relationships']}
      <p class="px-4 py-2 text-xs" style="color: var(--color-error);" role="alert">
        {errors['relationships']}
      </p>
    {/if}
    <div class="space-y-2 p-4">
      {#each proposals as row (`${row.fromId}:${row.toId}:${row.revision}`)}
        <div
          class="rounded-lg border p-3"
          style="border-color: var(--color-border); background: var(--color-surface-2);"
        >
          <div
            class="flex flex-wrap items-center gap-2 text-xs"
            style="color: var(--color-text-secondary);"
          >
            <button
              type="button"
              class="truncate underline-offset-2 hover:underline"
              onclick={() => onOpenNote(row.fromId)}
            >
              {row.fromTitle}
            </button>
            <span style="color: var(--color-text-muted);">— {row.type.replaceAll('_', ' ')} →</span>
            <button
              type="button"
              class="truncate underline-offset-2 hover:underline"
              onclick={() => onOpenNote(row.toId)}
            >
              {row.toTitle}
            </button>
            {#if row.stale}
              <span
                class="rounded px-1.5 py-0.5 text-[11px]"
                style="background: var(--color-warning-bg, var(--color-surface-3)); color: var(--color-warning, var(--color-text-secondary));"
                >endpoints changed</span
              >
            {/if}
          </div>
          <p class="mt-2 text-xs leading-5" style="color: var(--color-text-muted);">
            {row.evidence}
          </p>
          <div class="mt-2 flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              class="rounded-lg px-2.5 py-1 text-xs font-medium transition-colors"
              style="background: rgba(var(--color-accent-rgb), 0.12); color: var(--color-accent);"
              onclick={() => void review(row, 'accepted')}
              disabled={busy['review'] || row.stale}
              title={row.stale
                ? 'Endpoints changed: refresh the evidence before accepting'
                : 'Accept this evidence'}
              aria-label={`Accept ${row.fromTitle} ${row.type.replaceAll('_', ' ')} ${row.toTitle}`}
            >
              Accept
            </button>
            <button
              type="button"
              class="rounded-lg px-2.5 py-1 text-xs font-medium transition-colors hover:bg-[var(--color-surface-3)]"
              style="color: var(--color-text-secondary);"
              onclick={() => void review(row, 'rejected')}
              disabled={busy['review']}
              aria-label={`Reject ${row.fromTitle} ${row.type.replaceAll('_', ' ')} ${row.toTitle}`}
            >
              Reject
            </button>
          </div>
        </div>
      {:else}
        <p class="text-xs" style="color: var(--color-text-muted);">
          No proposals are waiting for a decision.
        </p>
      {/each}
    </div>
  </section>

  <section aria-label="Stale evidence" class="card">
    <div class="flex items-center gap-2 px-4 pt-4">
      <History size={13} style="color: var(--color-text-muted);" />
      <h3
        class="text-xs font-semibold uppercase tracking-wider"
        style="color: var(--color-text-muted);"
      >
        Stale evidence ({staleAccepted.length})
      </h3>
    </div>
    <div class="space-y-2 p-4">
      {#each staleAccepted as row (`${row.fromId}:${row.toId}:${row.revision}`)}
        <div
          class="flex flex-wrap items-center gap-2 text-xs"
          style="color: var(--color-text-secondary);"
        >
          <button
            type="button"
            class="truncate underline-offset-2 hover:underline"
            onclick={() => onOpenNote(row.fromId)}
          >
            {row.fromTitle}
          </button>
          <span style="color: var(--color-text-muted);">— {row.type.replaceAll('_', ' ')} →</span>
          <button
            type="button"
            class="truncate underline-offset-2 hover:underline"
            onclick={() => onOpenNote(row.toId)}
          >
            {row.toTitle}
          </button>
          <button
            type="button"
            class="ml-auto rounded-lg px-2.5 py-1 text-xs font-medium transition-colors hover:bg-[var(--color-surface-3)]"
            style="color: var(--color-accent);"
            onclick={onOpenNetwork}
            aria-label={`Open Network to refresh evidence for ${row.fromTitle} ${row.type.replaceAll('_', ' ')} ${row.toTitle}`}
          >
            Refresh evidence in Network
          </button>
        </div>
      {:else}
        <p class="text-xs" style="color: var(--color-text-muted);">
          Accepted evidence still matches both endpoints.
        </p>
      {/each}
    </div>
  </section>

  <section aria-label="Recovery drafts" class="card">
    <div class="flex items-center gap-2 px-4 pt-4">
      <FileText size={13} style="color: var(--color-text-muted);" />
      <h3
        class="text-xs font-semibold uppercase tracking-wider"
        style="color: var(--color-text-muted);"
      >
        Recovery drafts ({drafts.length})
      </h3>
    </div>
    {#if draftsError || errors['drafts']}
      <div class="px-4 py-2 text-xs" style="color: var(--color-error);" role="alert">
        {draftsError || errors['drafts']}
        <button type="button" class="ml-2 underline" onclick={() => void loadDrafts()}>Retry</button
        >
      </div>
    {/if}
    {#if errors['review']}
      <p class="px-4 py-2 text-xs" style="color: var(--color-error);" role="alert">
        {errors['review']}
      </p>
    {/if}
    {#if errors['discard']}
      <p class="px-4 py-2 text-xs" style="color: var(--color-error);" role="alert">
        {errors['discard']}
      </p>
    {/if}
    <div class="space-y-2 p-4">
      {#each drafts as draft (draft.id)}
        <div
          class="flex flex-wrap items-center gap-2 rounded-lg border p-3 text-xs"
          style="border-color: var(--color-border); background: var(--color-surface-2); color: var(--color-text-secondary);"
        >
          <span class="truncate font-medium">{draft.title}</span>
          <span
            class="rounded px-1.5 py-0.5 text-[11px]"
            style="background: var(--color-surface-3); color: var(--color-text-muted);"
            >draft of revision {draft.baseRevision} · {draft.state}</span
          >
          <span class="ml-auto flex items-center gap-1.5">
            <button
              type="button"
              class="rounded-lg px-2.5 py-1 text-xs font-medium transition-colors hover:bg-[var(--color-surface-3)]"
              style="color: var(--color-accent);"
              onclick={() => void openDraft(draft)}
              aria-label={`Review recovery draft of ${draft.title}`}
            >
              Review draft
            </button>
            <button
              type="button"
              class="rounded-lg px-2.5 py-1 text-xs font-medium transition-colors hover:bg-[var(--color-error-bg)]"
              style="color: var(--color-error);"
              onclick={() => void discard(draft)}
              disabled={busy['discard']}
              aria-label={`Discard recovery draft of ${draft.title}`}
            >
              Discard
            </button>
          </span>
        </div>
      {:else}
        <p class="text-xs" style="color: var(--color-text-muted);">
          No recovery drafts are pending.
        </p>
      {/each}
    </div>
  </section>
</section>
