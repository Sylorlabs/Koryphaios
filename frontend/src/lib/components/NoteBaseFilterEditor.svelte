<script lang="ts">
  import KorySelect from './KorySelect.svelte';
  import NoteBaseFilterEditor from './NoteBaseFilterEditor.svelte';
  import type { NoteBaseFilter, NoteBaseField, NoteBaseOperator } from '@koryphaios/shared';
  import { defaultNoteBaseFilterValue, noteBaseFieldType } from '$lib/utils/note-base-editor';
  let {
    filter,
    fields,
    onChange,
    depth = 0,
  }: {
    filter?: NoteBaseFilter;
    fields: Array<{ value: string; label: string; description?: string }>;
    onChange: (filter: NoteBaseFilter | undefined) => void;
    depth?: number;
  } = $props();
  function encode(field: NoteBaseField) {
    return field.source === 'system'
      ? `system:${field.field}`
      : `property:${field.key}:${field.type}`;
  }
  function decode(value: string): NoteBaseField {
    const [source, key, type] = value.split(':');
    return source === 'system'
      ? { source: 'system', field: key as Extract<NoteBaseField, { source: 'system' }>['field'] }
      : {
          source: 'property',
          key: key!,
          type: type as Extract<NoteBaseField, { source: 'property' }>['type'],
        };
  }
  function predicate(): NoteBaseFilter {
    return {
      kind: 'predicate',
      field: { source: 'system', field: 'title' },
      operator: 'contains',
      value: '',
    };
  }
  function operators(field: NoteBaseField) {
    const type = noteBaseFieldType(field);
    const values =
      type === 'list' || type === 'tags'
        ? ['contains', 'not_contains']
        : type === 'checkbox'
          ? ['eq', 'neq']
          : ['number', 'date', 'datetime'].includes(type ?? '')
            ? ['eq', 'neq', 'gt', 'gte', 'lt', 'lte']
            : ['eq', 'neq', 'contains', 'not_contains', 'starts_with'];
    return [...values, 'is_empty', 'is_not_empty'].map((value) => ({
      value,
      label: (
        {
          eq: 'Equals',
          neq: 'Does not equal',
          gt: 'Greater than',
          gte: 'At least',
          lt: 'Less than',
          lte: 'At most',
          contains: 'Contains',
          not_contains: 'Does not contain',
          starts_with: 'Starts with',
          is_empty: 'Is empty',
          is_not_empty: 'Is not empty',
        } as Record<string, string>
      )[value]!,
    }));
  }
  function replaceChild(index: number, child?: NoteBaseFilter) {
    if (filter?.kind !== 'group') return;
    const children = [...filter.filters];
    if (child) children[index] = child;
    else children.splice(index, 1);
    onChange(children.length ? { ...filter, filters: children } : undefined);
  }
  function valueChange(value: string) {
    if (filter?.kind !== 'predicate') return;
    const type = noteBaseFieldType(filter.field);
    const typed =
      type === 'number' ? Number(value) : type === 'checkbox' ? value === 'true' : value;
    onChange({ ...filter, value: typed });
  }
</script>

<div
  class="space-y-2 {depth > 0 ? 'border-l border-[var(--color-border)]/70 pl-3' : ''}"
  aria-label={depth ? 'Filter group' : 'Base filters'}
>
  {#if !filter}
    <p class="text-xs text-[var(--color-text-muted)]">
      All notes match. Add conditions to narrow this view.
    </p>
    <button type="button" class="control" onclick={() => onChange(predicate())}
      >Add condition</button
    >
  {:else if filter.kind === 'group'}
    <div class="flex flex-wrap items-center gap-2">
      <KorySelect
        label="Match conditions"
        compact
        value={filter.operator}
        options={[
          { value: 'and', label: 'Match all (AND)' },
          { value: 'or', label: 'Match any (OR)' },
        ]}
        onchange={(value) => {
          if (filter?.kind === 'group') onChange({ ...filter, operator: value as 'and' | 'or' });
        }}
      />
      <button
        type="button"
        class="control"
        disabled={filter.filters.length >= 20}
        onclick={() => {
          if (filter?.kind === 'group')
            onChange({ ...filter, filters: [...filter.filters, predicate()] });
        }}>Add condition</button
      >
      {#if depth < 3}<button
          type="button"
          class="control"
          onclick={() => {
            if (filter?.kind === 'group')
              onChange({
                ...filter,
                filters: [
                  ...filter.filters,
                  { kind: 'group', operator: 'or', filters: [predicate()] },
                ],
              });
          }}>Add group</button
        >{/if}
      <button
        type="button"
        class="control"
        aria-label="Remove filter group"
        onclick={() => onChange(undefined)}>Remove group</button
      >
    </div>
    {#each filter.filters as child, index}
      <NoteBaseFilterEditor
        filter={child}
        {fields}
        depth={depth + 1}
        onChange={(next) => replaceChild(index, next)}
      />
    {/each}
  {:else}
    <div class="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto]">
      <KorySelect
        label="Filter field"
        compact
        value={encode(filter.field)}
        options={fields.filter((field) => field.value !== 'none')}
        onchange={(value) => {
          const field = decode(value);
          onChange({
            kind: 'predicate',
            field,
            operator: ['list', 'tags'].includes(noteBaseFieldType(field) ?? '') ? 'contains' : 'eq',
            value: defaultNoteBaseFilterValue(field),
          });
        }}
      />
      <KorySelect
        label="Filter operator"
        compact
        value={filter.operator}
        options={operators(filter.field)}
        onchange={(value) => {
          if (filter?.kind === 'predicate')
            onChange({
              ...filter,
              operator: value as NoteBaseOperator,
              value: value.startsWith('is_')
                ? undefined
                : (filter.value ?? defaultNoteBaseFilterValue(filter.field)),
            });
        }}
      />
      {#if !filter.operator.startsWith('is_')}
        {#if noteBaseFieldType(filter.field) === 'checkbox'}
          <KorySelect
            label="Filter value"
            compact
            value={String(filter.value ?? true)}
            options={[
              { value: 'true', label: 'True' },
              { value: 'false', label: 'False' },
            ]}
            onchange={valueChange}
          />
        {:else}
          <input
            class="control min-w-0"
            aria-label="Filter value"
            value={String(filter.value ?? '')}
            oninput={(event) => valueChange(event.currentTarget.value)}
          />
        {/if}
      {/if}
      <button
        type="button"
        class="control"
        aria-label="Remove condition"
        onclick={() => onChange(undefined)}>Remove</button
      >
    </div>
    {#if depth === 0}
      <button
        type="button"
        class="control"
        onclick={() => {
          if (filter) onChange({ kind: 'group', operator: 'and', filters: [filter, predicate()] });
        }}>Add another condition</button
      >
    {/if}
  {/if}
</div>

<style>
  .control {
    border: 0;
    border-radius: 0.65rem;
    background: var(--color-surface-2);
    color: var(--color-text-primary);
    padding: 0.45rem 0.65rem;
    font-size: 0.75rem;
  }
  .control:hover {
    background: var(--color-surface-3);
  }
  .control:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 2px;
  }
  .control:disabled {
    opacity: 0.45;
  }
</style>
