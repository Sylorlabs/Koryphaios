<script lang="ts">
  import type { NoteAppearances } from '@koryphaios/shared';
  import FileText from 'lucide-svelte/icons/file-text';
  import Share2 from 'lucide-svelte/icons/share-2';
  import LayoutGrid from 'lucide-svelte/icons/layout-grid';
  import Table2 from 'lucide-svelte/icons/table-2';
  import { notesStore } from '$lib/stores/notes.svelte';

  let {
    noteId,
    onOpenNote,
    onOpenCanvas,
    onShowBases,
  }: {
    noteId: string;
    onOpenNote: (id: string) => void;
    onOpenCanvas: (id: string) => void;
    onShowBases: () => void;
  } = $props();

  let appearances = $state<NoteAppearances | null>(null);
  let loading = $state(false);
  let error = $state('');
  let requestId = 0;

  // Relationship counterparties already carry typed pair context, so the
  // document-link section shows only references not covered by a relationship.
  const linkOnlyBacklinks = $derived(
    (appearances?.backlinks ?? []).filter(
      (row) => !(appearances?.relationships ?? []).some((rel) => rel.counterpartyId === row.noteId),
    ),
  );
  const relationshipLabels: Record<string, string> = {
    related_to: 'Related to',
    supports: 'Supports',
    contradicts: 'Contradicts',
    depends_on: 'Depends on',
    supersedes: 'Supersedes',
  };
  // Count what the section actually renders: relationship counterparties are
  // listed once as pairs, so the link bucket has already dropped them.
  const totalAppearances = $derived(
    linkOnlyBacklinks.length +
      (appearances?.relationships.length ?? 0) +
      (appearances?.canvases.length ?? 0) +
      (appearances?.bases.length ?? 0),
  );

  async function load(id: string) {
    const current = ++requestId;
    loading = true;
    error = '';
    const result = await notesStore.loadNoteAppearances(id);
    if (current !== requestId) return;
    if (result) {
      appearances = result;
    } else if (!appearances || appearances.noteId !== id) {
      // Keep a good scan on a transient failure; only report when there is
      // nothing usable for this note.
      error = 'Could not load where this note appears.';
    }
    loading = false;
  }

  $effect(() => {
    void load(noteId);
  });

  // Each effect invocation increments requestId, so note switches invalidate
  // older responses without tying the load to any shared store state.
</script>

<section
  aria-label="Where this note appears"
  class="border-t pt-4"
  style="border-color: var(--color-border);"
>
  <div class="flex items-center justify-between gap-2 mb-2">
    <div
      class="text-xs font-semibold uppercase tracking-widest"
      style="color: var(--color-text-muted);"
    >
      Where this note appears
    </div>
    {#if appearances && totalAppearances > 0}
      <span class="text-[11px] tabular-nums" style="color: var(--color-text-muted);">
        {totalAppearances}
        {totalAppearances === 1 ? 'place' : 'places'}
      </span>
    {/if}
  </div>

  {#if loading && !appearances}
    <div class="px-3 py-2 text-xs" style="color: var(--color-text-muted);">Scanning…</div>
  {:else if error}
    <div class="px-3 py-2 text-xs" style="color: var(--color-error);" role="alert">{error}</div>
  {:else if appearances}
    {#if totalAppearances === 0}
      <div class="px-3 py-2 text-xs" style="color: var(--color-text-muted);">
        This note does not appear anywhere else yet.
      </div>
    {/if}

    {#if appearances.relationships.length > 0}
      <div class="mb-2">
        <div
          class="px-3 pb-1 text-[10px] font-medium uppercase tracking-wider"
          style="color: var(--color-text-muted);"
        >
          Relationships ({appearances.relationships.length})
        </div>
        <div class="space-y-1">
          {#each appearances.relationships as rel (`${rel.fromId}:${rel.toId}:${rel.revision}`)}
            <button
              type="button"
              class="flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left text-xs transition-colors hover:bg-[var(--color-surface-3)]"
              style="color: var(--color-text-secondary);"
              onclick={() => onOpenNote(rel.counterpartyId)}
              aria-label={`${rel.counterpartyTitle} · ${relationshipLabels[rel.type] ?? rel.type} · ${rel.status}${rel.stale ? ' · stale evidence' : ''}`}
            >
              <Share2 size={11} style="color: var(--color-text-muted); flex-shrink: 0;" />
              <span class="truncate">{rel.counterpartyTitle}</span>
              <span
                class="ml-auto flex-shrink-0 rounded px-1.5 py-0.5 text-[11px]"
                style="background: var(--color-surface-3); color: var(--color-text-muted);"
                >{relationshipLabels[rel.type] ?? rel.type} · {rel.status}{rel.stale
                  ? ' · stale'
                  : ''}</span
              >
            </button>
          {/each}
        </div>
      </div>
    {/if}

    {#if linkOnlyBacklinks.length > 0}
      <div class="mb-2">
        <div
          class="px-3 pb-1 text-[10px] font-medium uppercase tracking-wider"
          style="color: var(--color-text-muted);"
        >
          Document links ({linkOnlyBacklinks.length})
        </div>
        <div class="space-y-1">
          {#each linkOnlyBacklinks as backlink (backlink.noteId)}
            <button
              type="button"
              class="flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left text-xs transition-colors hover:bg-[var(--color-surface-3)]"
              style="color: var(--color-text-secondary);"
              onclick={() => onOpenNote(backlink.noteId)}
              aria-label={`${backlink.title} · document link`}
            >
              <FileText size={11} style="color: var(--color-text-muted); flex-shrink: 0;" />
              <span class="truncate">{backlink.title}</span>
            </button>
          {/each}
        </div>
      </div>
    {/if}

    {#if appearances.canvases.length > 0}
      <div class="mb-2">
        <div
          class="px-3 pb-1 text-[10px] font-medium uppercase tracking-wider"
          style="color: var(--color-text-muted);"
        >
          Canvases ({appearances.canvases.length})
        </div>
        <div class="space-y-1">
          {#each appearances.canvases as card (card.noteId + card.cardId)}
            <button
              type="button"
              class="flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left text-xs transition-colors hover:bg-[var(--color-surface-3)]"
              style="color: var(--color-text-secondary);"
              onclick={() => onOpenCanvas(card.noteId)}
              aria-label={`${card.title}${card.cardText ? ` · ${card.cardText}` : ''} · Canvas`}
            >
              <LayoutGrid size={11} style="color: var(--color-text-muted); flex-shrink: 0;" />
              <span class="truncate">{card.title}{card.cardText ? ` · ${card.cardText}` : ''}</span>
            </button>
          {/each}
        </div>
      </div>
    {/if}

    {#if appearances.bases.length > 0}
      <div class="mb-2">
        <div
          class="px-3 pb-1 text-[10px] font-medium uppercase tracking-wider"
          style="color: var(--color-text-muted);"
        >
          Saved Bases ({appearances.bases.length})
        </div>
        <div class="space-y-1">
          {#each appearances.bases as base (base.baseId)}
            <button
              type="button"
              class="flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left text-xs transition-colors hover:bg-[var(--color-surface-3)]"
              style="color: var(--color-text-secondary);"
              onclick={onShowBases}
              aria-label={`${base.name} · saved Base`}
            >
              <Table2 size={11} style="color: var(--color-text-muted); flex-shrink: 0;" />
              <span class="truncate">{base.name}</span>
            </button>
          {/each}
        </div>
      </div>
    {/if}

    {#if appearances.truncated}
      <div class="px-3 pb-2 text-[11px]" style="color: var(--color-text-muted);">
        Some appearances were skipped at the safety scan limit.
      </div>
    {/if}
  {/if}
</section>
