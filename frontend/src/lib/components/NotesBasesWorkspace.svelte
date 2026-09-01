<script lang="ts">
  import { onMount } from 'svelte';
  import Database from 'lucide-svelte/icons/database';
  import Plus from 'lucide-svelte/icons/plus';
  import RefreshCw from 'lucide-svelte/icons/refresh-cw';
  import Save from 'lucide-svelte/icons/save';
  import RotateCcw from 'lucide-svelte/icons/rotate-ccw';
  import Trash2 from 'lucide-svelte/icons/trash-2';
  import AlertTriangle from 'lucide-svelte/icons/alert-triangle';
  import ChevronLeft from 'lucide-svelte/icons/chevron-left';
  import ChevronRight from 'lucide-svelte/icons/chevron-right';
  import KorySelect from './KorySelect.svelte';
  import { noteBasesStore, DEFAULT_NOTE_BASE_DEFINITION } from '$lib/stores/note-bases.svelte';
  import {
    defaultNoteBaseFilterValue,
    normalizedNoteBasePropertyKey,
    noteBaseFieldCanSort,
    noteBaseFieldType,
  } from '$lib/utils/note-base-editor';
  import type {
    NoteBase,
    NoteBaseDefinition,
    NoteBaseField,
    NoteBaseOperator,
    NoteBaseQueryRow,
    NotePropertyType,
  } from '@koryphaios/shared';

  interface Props {
    onOpenNote: (noteId: string) => void;
  }

  let { onOpenNote }: Props = $props();
  let draftName = $state('');
  let draftDefinition = $state<NoteBaseDefinition>(structuredClone(DEFAULT_NOTE_BASE_DEFINITION));
  let dirty = $state(false);
  let lastActiveId: string | null = null;

  const systemFields = [
    ['title', 'Title'],
    ['folder', 'Folder'],
    ['tags', 'Tags'],
    ['pinned', 'Pinned'],
    ['context', 'Agent context'],
    ['created', 'Created'],
    ['updated', 'Updated'],
    ['format', 'Format'],
  ] as const;

  let fieldOptions = $derived([
    { value: 'none', label: 'No filter' },
    ...systemFields.map(([field, label]) => ({ value: `system:${field}`, label })),
    ...noteBasesStore.schemas.map((schema) => ({
      value: `property:${schema.key}:${schema.kind}`,
      label: `${schema.displayName} · ${schema.kind}`,
      description:
        schema.invalidCount > 0
          ? `${schema.invalidCount} note${schema.invalidCount === 1 ? '' : 's'} use another type`
          : `${schema.usageCount} note${schema.usageCount === 1 ? '' : 's'}`,
    })),
  ]);

  let sortFieldOptions = $derived(
    fieldOptions.filter((option) => {
      if (option.value === 'none') return true;
      return noteBaseFieldCanSort(decodeField(option.value));
    }),
  );

  let currentFilterField = $derived(
    draftDefinition.filter?.kind === 'predicate'
      ? encodeField(draftDefinition.filter.field)
      : 'none',
  );
  let currentFilterOperator = $derived(
    draftDefinition.filter?.kind === 'predicate' ? draftDefinition.filter.operator : 'eq',
  );
  let currentFilterValue = $derived(
    draftDefinition.filter?.kind === 'predicate' && draftDefinition.filter.value !== undefined
      ? String(draftDefinition.filter.value)
      : '',
  );
  let currentSortField = $derived(
    draftDefinition.sort[0] ? encodeField(draftDefinition.sort[0].field) : 'none',
  );
  let currentSortDirection = $derived(draftDefinition.sort[0]?.direction ?? 'asc');

  $effect(() => {
    const active = noteBasesStore.active;
    if (active?.id === lastActiveId) return;
    lastActiveId = active?.id ?? null;
    if (active) {
      draftName = active.name;
      draftDefinition = structuredClone(active.definition);
      dirty = false;
    }
  });

  $effect(() => {
    if (!noteBasesStore.active && noteBasesStore.bases.length > 0 && !noteBasesStore.loading) {
      void noteBasesStore.select(noteBasesStore.bases[0]!);
    }
  });

  onMount(() => {
    void noteBasesStore.refresh();
  });

  function encodeField(field: NoteBaseField): string {
    return field.source === 'system'
      ? `system:${field.field}`
      : `property:${field.key}:${field.type}`;
  }

  function decodeField(value: string): NoteBaseField | null {
    if (value === 'none') return null;
    const [source, key, type] = value.split(':');
    if (source === 'system' && key) {
      return { source: 'system', field: key as Extract<NoteBaseField, { source: 'system' }>['field'] };
    }
    if (source === 'property' && key && type) {
      return { source: 'property', key, type: type as NotePropertyType };
    }
    return null;
  }

  function operatorOptions(field: NoteBaseField | null) {
    const type = noteBaseFieldType(field);
    const empty = [
      { value: 'is_empty', label: 'Is empty' },
      { value: 'is_not_empty', label: 'Is not empty' },
    ];
    if (type === 'list' || type === 'tags') {
      return [
        { value: 'contains', label: 'Contains' },
        { value: 'not_contains', label: 'Does not contain' },
        ...empty,
      ];
    }
    if (type === 'number' || type === 'date' || type === 'datetime') {
      return [
        { value: 'eq', label: 'Equals' },
        { value: 'neq', label: 'Does not equal' },
        { value: 'gt', label: 'Greater than' },
        { value: 'gte', label: 'At least' },
        { value: 'lt', label: 'Less than' },
        { value: 'lte', label: 'At most' },
        ...empty,
      ];
    }
    if (type === 'checkbox') {
      return [
        { value: 'eq', label: 'Is' },
        { value: 'neq', label: 'Is not' },
        ...empty,
      ];
    }
    return [
      { value: 'eq', label: 'Equals' },
      { value: 'neq', label: 'Does not equal' },
      { value: 'contains', label: 'Contains' },
      { value: 'not_contains', label: 'Does not contain' },
      { value: 'starts_with', label: 'Starts with' },
      ...empty,
    ];
  }

  function defaultOperator(field: NoteBaseField): NoteBaseOperator {
    const type = noteBaseFieldType(field);
    return type === 'list' || type === 'tags' ? 'contains' : 'eq';
  }

  function coerceFilterValue(field: NoteBaseField, value: string): string | number | boolean {
    const type = noteBaseFieldType(field);
    if (type === 'number') return Number(value || 0);
    if (type === 'checkbox') return value !== 'false';
    return value;
  }

  function setFilterField(value: string): void {
    const field = decodeField(value);
    if (!field) {
      draftDefinition = { ...draftDefinition, filter: undefined };
    } else {
      draftDefinition = {
        ...draftDefinition,
        filter: {
          kind: 'predicate',
          field,
          operator: defaultOperator(field),
          value: defaultNoteBaseFilterValue(field),
        },
      };
      ensureViewField(field);
    }
    dirty = true;
  }

  function setFilterOperator(value: string): void {
    const filter = draftDefinition.filter;
    if (!filter || filter.kind !== 'predicate') return;
    const operator = value as NoteBaseOperator;
    const noValue = operator === 'is_empty' || operator === 'is_not_empty';
    draftDefinition = {
      ...draftDefinition,
      filter: {
        ...filter,
        operator,
        ...(noValue
          ? { value: undefined }
          : { value: filter.value ?? defaultNoteBaseFilterValue(filter.field) }),
      },
    };
    dirty = true;
  }

  function setFilterValue(value: string): void {
    const filter = draftDefinition.filter;
    if (!filter || filter.kind !== 'predicate') return;
    draftDefinition = {
      ...draftDefinition,
      filter: { ...filter, value: coerceFilterValue(filter.field, value) },
    };
    dirty = true;
  }

  function setSortField(value: string): void {
    const field = decodeField(value);
    draftDefinition = {
      ...draftDefinition,
      sort: field ? [{ field, direction: currentSortDirection }] : [],
    };
    dirty = true;
  }

  function ensureViewField(field: NoteBaseField): void {
    if (draftDefinition.view.fields.some((candidate) => encodeField(candidate) === encodeField(field))) {
      return;
    }
    draftDefinition = {
      ...draftDefinition,
      view: {
        ...draftDefinition.view,
        fields: [...draftDefinition.view.fields, field].slice(0, 20),
      },
    };
  }

  async function createBase(): Promise<void> {
    const names = new Set(noteBasesStore.bases.map((base) => base.name.toLowerCase()));
    let index = 1;
    let name = 'New Base';
    while (names.has(name.toLowerCase())) name = `New Base ${++index}`;
    await noteBasesStore.create(name);
  }

  async function saveBase(): Promise<void> {
    const active = noteBasesStore.active;
    if (!active) return;
    const saved = await noteBasesStore.update(active, {
      name: draftName.trim() || active.name,
      definition: draftDefinition,
    });
    if (saved) dirty = false;
  }

  async function removeBase(base: NoteBase): Promise<void> {
    const unsavedWarning = dirty && noteBasesStore.active?.id === base.id
      ? ' Unsaved view edits will be discarded.'
      : '';
    if (
      !confirm(
        `Move the Base "${base.name}" to Trash? Its history remains recoverable.${unsavedWarning}`,
      )
    ) {
      return;
    }
    if (await noteBasesStore.trash(base)) {
      lastActiveId = null;
      draftName = '';
      draftDefinition = structuredClone(DEFAULT_NOTE_BASE_DEFINITION);
      dirty = false;
    }
  }

  async function restoreBase(base: NoteBase): Promise<void> {
    await noteBasesStore.restore(base);
  }

  function fieldLabel(field: NoteBaseField): string {
    if (field.source === 'property') {
      return noteBasesStore.schemas.find((schema) => schema.key === field.key)?.displayName ?? field.key;
    }
    return systemFields.find(([key]) => key === field.field)?.[1] ?? field.field;
  }

  function cellValue(row: NoteBaseQueryRow, field: NoteBaseField): string {
    if (field.source === 'property') {
      const value = row.properties[normalizedNoteBasePropertyKey(field.key)];
      return Array.isArray(value) ? value.join(', ') : value === undefined ? '—' : String(value);
    }
    switch (field.field) {
      case 'title':
        return row.title;
      case 'folder':
        return row.folderPath;
      case 'tags':
        return row.tags.join(', ');
      case 'pinned':
        return row.pinned ? 'Yes' : 'No';
      case 'context':
        return row.includeInContext ? 'Included' : 'Not included';
      case 'created':
        return row.createdAt.toLocaleString();
      case 'updated':
        return row.updatedAt.toLocaleString();
      case 'format':
        return row.format;
    }
  }
</script>

<div class="grid h-full min-h-0 grid-cols-[220px_minmax(0,1fr)] bg-[var(--color-surface-1)]">
  <aside class="flex min-h-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-surface-0)]">
    <div class="flex items-center gap-2 border-b border-[var(--color-border)] px-3 py-3">
      <Database size={14} class="text-[var(--color-accent)]" />
      <span class="text-xs font-semibold text-[var(--color-text-primary)]" title="Saved filter views — query notes by properties, tags, or status">Saved Bases</span>
      <button
        type="button"
        class="ml-auto rounded-lg bg-[var(--color-surface-3)] p-1.5 text-[var(--color-text-primary)] hover:bg-[var(--color-accent)] hover:text-black"
        aria-label="Create Base"
        title="Create a new Base = saved filter view"
        onclick={() => void createBase()}><Plus size={13} /></button
      >
    </div>
    <div class="min-h-0 flex-1 overflow-y-auto p-2">
      {#if noteBasesStore.bases.length === 0 && !noteBasesStore.loading}
        <div class="px-2 py-8 text-center">
          <p class="text-xs font-semibold text-[var(--color-text-primary)]">Bases are filtered views of your notes</p>
          <p class="mt-1.5 text-xs leading-5 text-[var(--color-text-muted)]">Create a saved query — e.g. “all open tasks sorted by due date” or “notes tagged #project”. Updates live as notes change.</p>
          <button
            type="button"
            class="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-[var(--color-accent)] px-4 py-2 text-xs font-bold text-black shadow-md hover:brightness-110"
            onclick={() => void createBase()}>+ Create your first Base</button
          >
        </div>
      {/if}
      {#each noteBasesStore.bases as base (base.id)}
        <button
          type="button"
          class="mb-1 flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs transition-colors hover:bg-[var(--color-surface-3)]"
          style="background: {noteBasesStore.active?.id === base.id
            ? 'var(--color-surface-3)'
            : 'transparent'}; color: {noteBasesStore.active?.id === base.id
            ? 'var(--color-text-primary)'
            : 'var(--color-text-secondary)'};"
          onclick={() => void noteBasesStore.select(base)}
        >
          <Database size={12} class="shrink-0 text-[var(--color-accent)]" />
          <span class="min-w-0 flex-1 truncate">{base.name}</span>
        </button>
      {/each}
    </div>
    {#if noteBasesStore.trashed.length > 0}
      <section
        class="max-h-44 shrink-0 overflow-y-auto border-t border-[var(--color-border)] p-2"
        aria-label="Trashed Bases"
      >
        <p class="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
          Trash
        </p>
        {#each noteBasesStore.trashed as base (base.id)}
          <div class="flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs">
            <span class="min-w-0 flex-1 truncate text-[var(--color-text-muted)]">{base.name}</span>
            <button
              type="button"
              class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-surface-3)] hover:text-[var(--color-accent)] disabled:opacity-40"
              aria-label={`Restore Base ${base.name}`}
              disabled={noteBasesStore.saving}
              onclick={() => void restoreBase(base)}
            >
              <RotateCcw size={12} aria-hidden="true" />
            </button>
          </div>
        {/each}
      </section>
    {/if}
  </aside>

  <main class="flex min-h-0 min-w-0 flex-col">
    {#if noteBasesStore.active}
      <div class="shrink-0 border-b border-[var(--color-border)] bg-[var(--color-surface-0)] p-3">
        <div class="flex items-center gap-2">
          <input
            type="text"
            bind:value={draftName}
            maxlength="120"
            oninput={() => (dirty = true)}
            aria-label="Base name"
            class="h-9 min-w-0 flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-1)] px-3 text-sm font-semibold text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]"
          />
          <button
            type="button"
            class="inline-flex h-9 items-center gap-1.5 rounded-lg bg-[var(--color-accent)] px-3 text-xs font-semibold text-[var(--color-accent-foreground)] disabled:opacity-40"
            disabled={!dirty || noteBasesStore.saving}
            onclick={() => void saveBase()}><Save size={12} /> Save view</button
          >
          <button
            type="button"
            class="flex h-9 w-9 items-center justify-center rounded-lg border border-[var(--color-border)] text-[var(--color-text-muted)] hover:bg-[var(--color-error-bg)] hover:text-[var(--color-error)]"
            aria-label="Move Base to Trash"
            onclick={() => void removeBase(noteBasesStore.active!)}><Trash2 size={13} /></button
          >
        </div>

        <div class="mt-3 grid grid-cols-2 gap-2 xl:grid-cols-4">
          <KorySelect
            value={currentFilterField}
            options={fieldOptions}
            compact
            label="Filter field"
            onchange={setFilterField}
          />
          {#if draftDefinition.filter?.kind === 'predicate'}
            <KorySelect
              value={currentFilterOperator}
              options={operatorOptions(draftDefinition.filter.field)}
              compact
              label="Filter operator"
              onchange={setFilterOperator}
            />
            {#if currentFilterOperator !== 'is_empty' && currentFilterOperator !== 'is_not_empty'}
              {#if noteBaseFieldType(draftDefinition.filter.field) === 'checkbox'}
                <KorySelect
                  value={currentFilterValue || 'true'}
                  options={[
                    { value: 'true', label: 'True' },
                    { value: 'false', label: 'False' },
                  ]}
                  compact
                  label="Filter value"
                  onchange={setFilterValue}
                />
              {:else}
                <input
                  type="text"
                  value={currentFilterValue}
                  aria-label="Filter value"
                  placeholder="Filter value"
                  class="h-9 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-1)] px-3 text-xs text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]"
                  oninput={(event) => setFilterValue(event.currentTarget.value)}
                />
              {/if}
            {/if}
          {/if}
          <KorySelect
            value={currentSortField}
            options={sortFieldOptions}
            compact
            label="Sort field"
            onchange={setSortField}
          />
          {#if currentSortField !== 'none'}
            <KorySelect
              value={currentSortDirection}
              options={[
                { value: 'asc', label: 'Ascending' },
                { value: 'desc', label: 'Descending' },
              ]}
              compact
              label="Sort direction"
              onchange={(value) => {
                const first = draftDefinition.sort[0];
                if (!first) return;
                draftDefinition = {
                  ...draftDefinition,
                  sort: [{ ...first, direction: value as 'asc' | 'desc' }],
                };
                dirty = true;
              }}
            />
          {/if}
          <KorySelect
            value={draftDefinition.view.kind}
            options={[
              { value: 'table', label: 'Table' },
              { value: 'list', label: 'List' },
              { value: 'card', label: 'Cards' },
            ]}
            compact
            label="View layout"
            onchange={(value) => {
              draftDefinition = {
                ...draftDefinition,
                view: { ...draftDefinition.view, kind: value as 'table' | 'list' | 'card' },
              };
              dirty = true;
            }}
          />
        </div>
      </div>

      {#if noteBasesStore.error}
        <div
          class="flex items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-error-bg)] px-4 py-2 text-xs text-[var(--color-error)]"
          role="alert"
        >
          <AlertTriangle size={13} /> {noteBasesStore.error}
          <button type="button" class="ml-auto underline" onclick={() => void noteBasesStore.refresh()}
            >Retry</button
          >
        </div>
      {/if}
      {#if noteBasesStore.result?.invalidDocumentCount}
        <div
          class="flex items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-warning-bg)] px-4 py-2 text-xs text-[var(--color-warning)]"
          role="status"
        >
          <AlertTriangle size={13} /> {noteBasesStore.result.invalidDocumentCount} note{noteBasesStore
            .result.invalidDocumentCount === 1
            ? ' has'
            : 's have'} unsupported or malformed frontmatter. System fields remain queryable.
        </div>
      {/if}

      <div class="min-h-0 flex-1 overflow-auto p-4">
        {#if noteBasesStore.loading && !noteBasesStore.result}
          <div class="flex h-full items-center justify-center gap-2 text-xs text-[var(--color-text-muted)]">
            <RefreshCw size={13} class="animate-spin" /> Indexing and querying this Base…
          </div>
        {:else if !noteBasesStore.result || noteBasesStore.result.rows.length === 0}
          <div class="flex h-full flex-col items-center justify-center text-center">
            <Database size={28} class="text-[var(--color-text-muted)]" />
            <p class="mt-3 text-sm font-medium text-[var(--color-text-primary)]">No matching notes</p>
            <p class="mt-1 text-xs text-[var(--color-text-muted)]">
              Adjust the typed filter and save the view.
            </p>
          </div>
        {:else if draftDefinition.view.kind === 'table'}
          <table class="w-full border-separate border-spacing-0 text-left text-xs">
            <thead class="sticky top-0 z-10 bg-[var(--color-surface-1)]">
              <tr>
                <th
                  class="w-16 border-b border-[var(--color-border)] px-3 py-2 font-semibold text-[var(--color-text-muted)]"
                >
                  <span class="sr-only">Open note</span>
                </th>
                {#each draftDefinition.view.fields as field (encodeField(field))}
                  <th class="border-b border-[var(--color-border)] px-3 py-2 font-semibold text-[var(--color-text-muted)]">
                    {fieldLabel(field)}
                  </th>
                {/each}
              </tr>
            </thead>
            <tbody>
              {#each noteBasesStore.result.rows as row (row.id)}
                <tr class="hover:bg-[var(--color-surface-2)]">
                  <td class="border-b border-[var(--color-border)]/60 px-3 py-2.5">
                    <button
                      type="button"
                      class="rounded text-xs font-medium text-[var(--color-accent)] underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]"
                      aria-label={`Open ${row.title}`}
                      onclick={() => onOpenNote(row.id)}>Open</button
                    >
                  </td>
                  {#each draftDefinition.view.fields as field (encodeField(field))}
                    <td class="max-w-80 truncate border-b border-[var(--color-border)]/60 px-3 py-2.5 text-[var(--color-text-secondary)]">
                      {cellValue(row, field)}
                    </td>
                  {/each}
                </tr>
              {/each}
            </tbody>
          </table>
        {:else if draftDefinition.view.kind === 'list'}
          <div class="space-y-1">
            {#each noteBasesStore.result.rows as row (row.id)}
              <button
                type="button"
                class="flex w-full items-center gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2.5 text-left hover:border-[var(--color-accent)]/50"
                onclick={() => onOpenNote(row.id)}
              >
                <span class="min-w-0 flex-1 truncate text-sm font-medium text-[var(--color-text-primary)]">{row.title}</span>
                <span class="truncate text-xs text-[var(--color-text-muted)]">{row.folderPath}</span>
              </button>
            {/each}
          </div>
        {:else}
          <div class="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
            {#each noteBasesStore.result.rows as row (row.id)}
              <button
                type="button"
                class="min-h-28 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-4 text-left hover:border-[var(--color-accent)]/50 hover:bg-[var(--color-surface-3)]"
                onclick={() => onOpenNote(row.id)}
              >
                <span class="block truncate text-sm font-semibold text-[var(--color-text-primary)]">{row.title}</span>
                <span class="mt-1 block truncate text-xs text-[var(--color-text-muted)]">{row.folderPath}</span>
                <span class="mt-4 block truncate text-xs text-[var(--color-text-secondary)]">
                  {Object.entries(row.properties)
                    .slice(0, 3)
                    .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value}`)
                    .join(' · ') || 'No typed properties'}
                </span>
              </button>
            {/each}
          </div>
        {/if}
      </div>

      {#if noteBasesStore.result}
        <div class="flex shrink-0 items-center justify-between border-t border-[var(--color-border)] px-4 py-2 text-xs text-[var(--color-text-muted)]">
          <span>
            {noteBasesStore.result.rows.length === 0 ? 0 : noteBasesStore.result.offset + 1}–{noteBasesStore
              .result.rows.length === 0
              ? 0
              : noteBasesStore.result.offset + noteBasesStore.result.rows.length}
          </span>
          <div class="flex items-center gap-1">
            <button
              type="button"
              class="rounded-lg border border-[var(--color-border)] p-1.5 hover:bg-[var(--color-surface-3)] disabled:opacity-30"
              disabled={noteBasesStore.result.offset === 0 || noteBasesStore.loading}
              aria-label="Previous Base page"
              onclick={() =>
                void noteBasesStore.query(
                  noteBasesStore.active!.id,
                  Math.max(0, noteBasesStore.result!.offset - noteBasesStore.result!.limit),
                )}><ChevronLeft size={13} /></button
            >
            <button
              type="button"
              class="rounded-lg border border-[var(--color-border)] p-1.5 hover:bg-[var(--color-surface-3)] disabled:opacity-30"
              disabled={!noteBasesStore.result.hasMore || noteBasesStore.loading}
              aria-label="Next Base page"
              onclick={() =>
                void noteBasesStore.query(
                  noteBasesStore.active!.id,
                  noteBasesStore.result!.offset + noteBasesStore.result!.limit,
                )}><ChevronRight size={13} /></button
            >
          </div>
        </div>
      {/if}
    {:else if !noteBasesStore.loading}
      <div class="flex h-full flex-col items-center justify-center px-8 text-center">
        <Database size={30} class="text-[var(--color-text-muted)]" />
        <p class="mt-3 text-sm font-semibold text-[var(--color-text-primary)]">Choose or create a Base</p>
        <p class="mt-1.5 max-w-md text-xs leading-5 text-[var(--color-text-muted)]">A Base is a saved filter &amp; sort over all notes in this project — like a smart folder or database view. Pick one on the left or create a new one.</p>
        <button
          type="button"
          class="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-[var(--color-accent)] px-4 py-2 text-xs font-bold text-black shadow-md hover:brightness-110"
          onclick={() => void createBase()}>+ Create Base</button
        >
      </div>
    {/if}
  </main>
</div>
