<script lang="ts">
  import ChevronDown from 'lucide-svelte/icons/chevron-down';
  import Plus from 'lucide-svelte/icons/plus';
  import SlidersHorizontal from 'lucide-svelte/icons/sliders-horizontal';
  import Trash2 from 'lucide-svelte/icons/trash-2';
  import AlertTriangle from 'lucide-svelte/icons/alert-triangle';
  import KorySelect from './KorySelect.svelte';
  import NumberStepper from './NumberStepper.svelte';
  import SettingsSwitch from './SettingsSwitch.svelte';
  import {
    NOTE_PROPERTY_TYPES,
    parseNoteProperties,
    removeNoteProperty,
    setNoteProperty,
    type NoteProperty,
    type NotePropertyType,
    type NotePropertyValue,
  } from '@koryphaios/shared';

  interface Props {
    content: string;
    format?: 'markdown' | 'html';
    onchange: (content: string) => void;
  }

  let { content, format = 'markdown', onchange }: Props = $props();
  let expanded = $state(false);
  let adding = $state(false);
  let newKey = $state('');
  let newType = $state<NotePropertyType>('text');
  let error = $state<string | null>(null);

  const typeOptions = NOTE_PROPERTY_TYPES.map((type) => ({
    value: type,
    label:
      type === 'checkbox'
        ? 'Checkbox'
        : type === 'datetime'
          ? 'Date & time'
          : type.charAt(0).toUpperCase() + type.slice(1),
  }));
  const parsed = $derived(parseNoteProperties(content));
  const readOnly = $derived(format === 'html' || parsed.warnings.length > 0);

  function defaultValue(type: NotePropertyType): NotePropertyValue {
    if (type === 'checkbox') return false;
    if (type === 'number') return 0;
    if (type === 'list' || type === 'tags') return [];
    if (type === 'date') return new Date().toISOString().slice(0, 10);
    if (type === 'datetime') return new Date().toISOString();
    return '';
  }

  function commit(property: NoteProperty): void {
    try {
      onchange(setNoteProperty(content, property));
      error = null;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Property could not be updated';
    }
  }

  function remove(key: string): void {
    try {
      onchange(removeNoteProperty(content, key));
      error = null;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Property could not be removed';
    }
  }

  function addProperty(): void {
    const key = newKey.trim();
    if (!key) return;
    commit({ key, type: newType, value: defaultValue(newType) });
    if (!error) {
      newKey = '';
      adding = false;
    }
  }

  function textValue(value: NotePropertyValue): string {
    return Array.isArray(value) ? value.join(', ') : String(value);
  }

  function listValue(value: string): string[] {
    return value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }
</script>

<section
  class="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)]"
  aria-label="Note properties"
>
  <button
    type="button"
    class="flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-[var(--color-surface-3)]"
    aria-expanded={expanded}
    onclick={() => (expanded = !expanded)}
  >
    <SlidersHorizontal size={13} class="text-[var(--color-accent)]" aria-hidden="true" />
    <span class="font-medium text-[var(--color-text-primary)]">Properties</span>
    <span class="text-[10px] text-[var(--color-text-muted)]">{parsed.properties.length}</span>
    {#if parsed.warnings.length > 0}
      <span class="ml-1 inline-flex items-center gap-1 text-[10px] text-[var(--color-warning)]">
        <AlertTriangle size={10} aria-hidden="true" /> Needs source repair
      </span>
    {/if}
    <ChevronDown
      size={13}
      class="ml-auto text-[var(--color-text-muted)] transition-transform {expanded
        ? 'rotate-180'
        : ''}"
      aria-hidden="true"
    />
  </button>

  {#if expanded}
    <div class="border-t border-[var(--color-border)] px-3 py-3">
      {#if format === 'html'}
        <p class="text-xs leading-5 text-[var(--color-text-muted)]">
          Typed YAML properties are available for Markdown notes. HTML notes keep system fields only.
        </p>
      {:else if parsed.warnings.length > 0}
        <div
          class="rounded-lg border px-3 py-2 text-xs leading-5"
          style="border-color: color-mix(in srgb, var(--color-warning) 35%, var(--color-border)); background: var(--color-warning-bg); color: var(--color-text-primary);"
          role="status"
        >
          <p class="font-medium">Edit the YAML source to repair these properties.</p>
          <ul class="mt-1 list-disc pl-4 text-[var(--color-text-secondary)]">
            {#each parsed.warnings as warning}
              <li>{warning.key ? `${warning.key}: ` : ''}{warning.message}</li>
            {/each}
          </ul>
          <p class="mt-1 text-[var(--color-text-muted)]">
            Koryphaios preserves the original bytes and will not guess at unsupported YAML.
          </p>
        </div>
      {:else}
        <div class="space-y-2">
          {#each parsed.properties as property (property.key.toLowerCase())}
            <div
              class="grid grid-cols-[minmax(100px,0.8fr)_minmax(0,1.6fr)_28px] items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-1)] p-2"
            >
              <div class="min-w-0">
                <div class="truncate text-xs font-medium text-[var(--color-text-primary)]">
                  {property.key}
                </div>
                <div class="text-[9px] uppercase tracking-wider text-[var(--color-text-muted)]">
                  {property.type}
                </div>
              </div>

              {#if property.type === 'checkbox'}
                <SettingsSwitch
                  checked={Boolean(property.value)}
                  label={property.key}
                  description="Boolean property"
                  minimal
                  compact
                  onchange={() =>
                    commit({ ...property, value: !Boolean(property.value) })}
                />
              {:else if property.type === 'number'}
                <NumberStepper
                  value={Number(property.value)}
                  min={-1_000_000_000}
                  max={1_000_000_000}
                  step={1}
                  unit=""
                  compact
                  label={property.key}
                  onchange={(value) => commit({ ...property, value })}
                />
              {:else if property.type === 'list' || property.type === 'tags'}
                <input
                  type="text"
                  value={textValue(property.value)}
                  aria-label={`${property.key} comma-separated values`}
                  class="h-9 min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-0)] px-2 text-xs text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]"
                  placeholder="one, two, three"
                  onchange={(event) =>
                    commit({
                      ...property,
                      value: listValue(event.currentTarget.value),
                    })}
                />
              {:else}
                <input
                  type={property.type === 'date' ? 'date' : 'text'}
                  value={String(property.value)}
                  aria-label={property.key}
                  class="h-9 min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-0)] px-2 text-xs text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]"
                  placeholder={property.type === 'datetime'
                    ? '2026-08-30T13:42:00-07:00'
                    : 'Value'}
                  onchange={(event) => commit({ ...property, value: event.currentTarget.value })}
                />
              {/if}

              <button
                type="button"
                class="flex h-7 w-7 items-center justify-center rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-error-bg)] hover:text-[var(--color-error)]"
                aria-label={`Remove ${property.key} property`}
                onclick={() => remove(property.key)}
              >
                <Trash2 size={12} aria-hidden="true" />
              </button>
            </div>
          {/each}
        </div>

        {#if adding}
          <div
            class="mt-3 grid grid-cols-[minmax(0,1fr)_150px_auto] items-end gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-1)] p-2"
          >
            <label class="min-w-0 text-[10px] text-[var(--color-text-muted)]">
              Name
              <input
                type="text"
                bind:value={newKey}
                maxlength="80"
                class="mt-1 h-9 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-0)] px-2 text-xs text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]"
                placeholder="status"
                onkeydown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    addProperty();
                  }
                }}
              />
            </label>
            <KorySelect
              value={newType}
              options={typeOptions}
              label="Property type"
              compact
              onchange={(value) => (newType = value as NotePropertyType)}
            />
            <button
              type="button"
              class="inline-flex h-9 items-center gap-1 rounded-lg bg-[var(--color-accent)] px-3 text-xs font-medium text-[var(--color-accent-foreground)] disabled:opacity-40"
              disabled={!newKey.trim() || readOnly}
              onclick={addProperty}
            >
              <Plus size={12} aria-hidden="true" /> Add
            </button>
          </div>
        {:else}
          <button
            type="button"
            class="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-2.5 py-1.5 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-3)]"
            onclick={() => (adding = true)}
          >
            <Plus size={12} aria-hidden="true" /> Add property
          </button>
        {/if}

        {#if parsed.properties.length === 0 && !adding}
          <p class="mt-2 text-[10px] text-[var(--color-text-muted)]">
            Properties stay in portable YAML frontmatter and can be queried by saved Bases.
          </p>
        {/if}
      {/if}

      {#if error}
        <p class="mt-2 text-xs text-[var(--color-error)]" role="alert">{error}</p>
      {/if}
    </div>
  {/if}
</section>
