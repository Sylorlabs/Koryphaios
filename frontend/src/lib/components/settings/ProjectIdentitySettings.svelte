<script lang="ts">
  import { onMount } from 'svelte';
  import {
    normalizeProjectIconCustomColor,
    normalizeProjectIconSpec,
    PROJECT_ICON_COLORS,
    type ProjectIconSpec,
    type ProjectIconShape,
    type ProjectIdentity,
  } from '@koryphaios/shared';
  import { apiFetch, parseJsonResponse } from '$lib/api.svelte';
  import { apiUrl } from '$lib/utils/api-url';
  import { projectIdentityProjection, projectStore } from '$lib/stores/project.svelte';
  import Palette from 'lucide-svelte/icons/palette';
  import KorySelect from '../KorySelect.svelte';
  import ProjectIcon from '../ProjectIcon.svelte';
  import CustomProviderIconEditor from './CustomProviderIconEditor.svelte';
  import ColorPickerModal from '../ColorPickerModal.svelte';
  import type { CustomProviderIconSelection } from './custom-provider-icon';

  let identity = $state<ProjectIdentity | null>(null);
  let revision = $state(1);
  let mode = $state<ProjectIconSpec['mode']>('automatic');
  let value = $state('');
  let color = $state<(typeof PROJECT_ICON_COLORS)[number]>('accent');
  let colorChoice = $state<'automatic' | 'custom' | (typeof PROJECT_ICON_COLORS)[number]>('automatic');
  let customColor = $state('');
  let shape = $state<ProjectIconShape>('rounded-square');
  let loading = $state(false);
  let saving = $state(false);
  let message = $state('');
  let error = $state('');
  let loadedPath = $state<string | null>(null);
  let assetUrl = $state('');
  let showColorPicker = $state(false);

  // Emoji and monogram are one field: a monogram is up to two graphemes, so a
  // single input accepts "K", "🚀", or "🚀K" and the icon draws both parts
  // together. Identities stored in emoji mode load into this same field.
  const modeOptions = [
    { value: 'automatic', label: 'Automatic', description: 'A deterministic monogram and color from the project name.' },
    { value: 'monogram', label: 'Monogram & emoji', description: 'One or two letters, an emoji, or both — shown together.' },
    { value: 'color', label: 'Color tile', description: 'Use a color tile without text.' },
    {
      value: 'image',
      label: 'Uploaded image',
      description: 'Upload, crop, and store a private project image.',
    },
  ];
  const colorOptions = PROJECT_ICON_COLORS.map((item) => ({
    value: item,
    label: item[0].toUpperCase() + item.slice(1),
  }));
  const colorSelectOptions = [
    { value: 'automatic', label: 'Automatic', description: 'Use the deterministic project color.' },
    ...colorOptions,
    { value: 'custom', label: 'Custom color', description: 'Choose any validated hex color.' },
  ];
  const shapeOptions: Array<{ value: ProjectIconShape; label: string; radius: string }> = [
    { value: 'circle', label: 'Circle', radius: '999px' },
    { value: 'rounded-square', label: 'Rounded square', radius: '24%' },
    { value: 'square', label: 'Square', radius: '0' },
  ];

  const currentPath = $derived(projectStore.currentPath);
  const previewSpec = $derived.by((): ProjectIconSpec => {
    const custom = colorChoice === 'custom' ? normalizeProjectIconCustomColor(customColor) : undefined;
    const presentation = {
      ...(colorChoice !== 'automatic' && colorChoice !== 'custom' ? { color: colorChoice } : {}),
      ...(custom ? { customColor: custom } : {}),
      shape,
    };
    if (mode === 'automatic') return { mode: 'automatic', ...presentation };
    if (mode === 'emoji') return { mode, value, ...presentation };
    if (mode === 'monogram') return { mode, value, ...presentation };
    if (mode === 'color') return { mode, ...presentation };
    return { mode: 'image', assetId: value || 'pending-upload', ...presentation };
  });
  const previewIdentity = $derived.by(
    () =>
      identity ??
      (currentPath
        ? projectIdentityProjection({
            path: currentPath,
            name: currentPath.split(/[\\/]/u).filter(Boolean).at(-1) ?? 'Project',
            modifiedAt: 0,
          }).identity
        : null),
  );

  function setFromIdentity(next: ProjectIdentity, nextRevision = 1) {
    identity = next;
    revision = nextRevision;
    mode = next.icon.mode === 'emoji' ? 'monogram' : next.icon.mode;
    value =
      next.icon.mode === 'emoji' || next.icon.mode === 'monogram'
        ? next.icon.value
        : next.icon.mode === 'image'
          ? next.icon.assetId
          : '';
    color = next.icon.color ?? 'accent';
    colorChoice = next.icon.customColor
      ? 'custom'
      : next.icon.color ?? (next.icon.mode === 'automatic' ? 'automatic' : 'accent');
    customColor = next.icon.customColor ?? '';
    shape = next.icon.shape ?? 'rounded-square';
  }

  let graphemeCount = $derived.by(() => {
    if (mode !== 'monogram') return 0;
    const Segmenter = (
      Intl as typeof Intl & {
        Segmenter?: new (l?: string) => { segment(input: string): Iterable<{ segment: string }> };
      }
    ).Segmenter;
    const text = value.trim();
    if (!text) return 0;
    return Segmenter
      ? [...new Segmenter().segment(text)].length
      : Array.from(text).length;
  });
  const monogramTooLong = $derived(mode === 'monogram' && graphemeCount > 2);

  function setMode(next: ProjectIconSpec['mode']) {
    mode = next;
    if (next === 'color' && colorChoice === 'automatic') colorChoice = 'accent';
  }

  function setColorChoice(next: string) {
    colorChoice = next as typeof colorChoice;
    if (next !== 'custom') customColor = '';
    if (next !== 'automatic' && next !== 'custom') color = next as typeof color;
    if (next === 'custom' && !customColor) customColor = '#D5B261';
  }

  async function uploadImage(selection: CustomProviderIconSelection | null) {
    if (!selection?.blob || !currentPath || !identity) return;
    saving = true;
    error = '';
    try {
      const form = new FormData();
      form.set('file', selection.blob, 'project-icon.png');
      form.set('color', colorChoice !== 'automatic' && colorChoice !== 'custom' ? colorChoice : '');
      form.set('customColor', colorChoice === 'custom' ? customColor : '');
      form.set('shape', shape);
      const response = await apiFetch(apiUrl('/api/workspace/project-icon'), {
        method: 'POST',
        headers: { 'X-Koryphaios-Project': currentPath },
        body: form,
      });
      const body = await parseJsonResponse<{
        ok?: boolean;
        data?: ProjectIdentity & { revision?: number; assetUrl?: string };
        error?: string;
      }>(response);
      if (!response.ok || !body.ok || !body.data)
        throw new Error(body.error || 'Could not upload project icon');
      assetUrl = body.data.assetUrl ?? '';
      setFromIdentity(body.data, body.data.revision ?? revision + 1);
      message = 'Project image saved.';
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not upload project icon';
    } finally {
      saving = false;
    }
  }

  async function load() {
    if (!currentPath || loadedPath === currentPath) return;
    loadedPath = currentPath;
    loading = true;
    error = '';
    try {
      const response = await apiFetch(apiUrl('/api/workspace/project-identity'), {
        headers: { 'X-Koryphaios-Project': currentPath },
      });
      const body = await parseJsonResponse<{
        ok?: boolean;
        data?: ProjectIdentity & { revision?: number; assetUrl?: string };
        error?: string;
      }>(response);
      if (!response.ok || !body.ok || !body.data)
        throw new Error(body.error || 'Could not load project identity');
      setFromIdentity(body.data, body.data.revision ?? 1);
      assetUrl = body.data.assetUrl ?? '';
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not load project identity';
    } finally {
      loading = false;
    }
  }

  async function save() {
    if (!currentPath || !identity || saving || (mode === 'image' && !value)) return;
    saving = true;
    error = '';
    message = '';
    try {
      const icon = normalizeProjectIconSpec(previewSpec);
      const response = await apiFetch(apiUrl('/api/workspace/project-identity'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Koryphaios-Project': currentPath },
        body: JSON.stringify({ name: identity.name, icon, expectedRevision: revision }),
      });
      const body = await parseJsonResponse<{
        ok?: boolean;
        data?: ProjectIdentity & { revision?: number };
        error?: string;
      }>(response);
      if (!response.ok || !body.ok || !body.data)
        throw new Error(body.error || 'Could not save project identity');
      setFromIdentity(body.data, body.data.revision ?? revision + 1);
      message = 'Project identity saved.';
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not save project identity';
    } finally {
      saving = false;
    }
  }

  async function reset() {
    if (!currentPath || saving) return;
    saving = true;
    error = '';
    message = '';
    try {
      const response = await apiFetch(apiUrl('/api/workspace/project-identity'), {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', 'X-Koryphaios-Project': currentPath },
        body: JSON.stringify({ expectedRevision: revision }),
      });
      const body = await parseJsonResponse<{
        ok?: boolean;
        data?: ProjectIdentity & { revision?: number };
        error?: string;
      }>(response);
      if (!response.ok || !body.ok || !body.data)
        throw new Error(body.error || 'Could not reset project identity');
      setFromIdentity(body.data, body.data.revision ?? revision + 1);
      message = 'Project identity reset.';
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not reset project identity';
    } finally {
      saving = false;
    }
  }

  onMount(() => void load());
  $effect(() => {
    if (currentPath && loadedPath !== currentPath) void load();
  });
</script>

<div class="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 py-5 sm:px-8">
  <div class="mx-auto w-full max-w-2xl space-y-5 pb-8">
    <header>
      <p class="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--color-accent)]">
        Project settings
      </p>
      <h2 class="mt-1 text-xl font-semibold tracking-tight text-[var(--color-text-primary)]">
        Project identity
      </h2>
      <p class="mt-1 max-w-xl text-xs leading-5 text-[var(--color-text-muted)]">
        Choose the name, appearance, and shape Koryphaios uses for this project everywhere.
      </p>
    </header>

    {#if !currentPath}
      <div
        class="rounded-xl border border-dashed border-[var(--color-border)] p-5 text-sm text-[var(--color-text-muted)]"
      >
        Select a project to edit its identity.
      </div>
    {:else}
      {#if loading}<p class="text-xs text-[var(--color-text-muted)]">
          Loading project identity…
        </p>{/if}
      {#if previewIdentity}
        <div
          class="flex items-center gap-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-4 shadow-sm"
        >
          <ProjectIcon identity={previewIdentity} icon={previewSpec} {assetUrl} size={64} />
          <div class="min-w-0 flex-1">
            <p class="truncate text-base font-semibold text-[var(--color-text-primary)]">
              {identity?.name ?? previewIdentity.name}
            </p>
            <p class="mt-1 text-xs text-[var(--color-text-muted)]">
              Live preview · saved to this project, not this device
            </p>
          </div>
          <span
            class="hidden shrink-0 rounded-full border border-[var(--color-border)] bg-[var(--color-surface-1)] px-2.5 py-1 text-[10px] font-medium text-[var(--color-text-secondary)] sm:inline-flex"
          >
            {mode === 'automatic' ? 'Automatic' : mode === 'image' ? 'Image' : 'Custom'}
          </span>
        </div>
      {/if}

      <section class="space-y-3 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-4">
        <div>
          <h3 class="text-sm font-semibold text-[var(--color-text-primary)]">Name</h3>
          <p class="mt-1 text-xs leading-relaxed text-[var(--color-text-muted)]">
            This is the label people will see in project pickers and navigation.
          </p>
        </div>
        <label class="block text-xs font-medium text-[var(--color-text-secondary)]" for="project-name">
          Display name
          <input
            id="project-name"
            class="mt-2 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-1)] px-3 py-2.5 text-sm text-[var(--color-text-primary)] outline-none transition-colors focus:border-[var(--color-accent)]"
            value={identity?.name ?? ''}
            oninput={(event) => {
              if (identity) identity = { ...identity, name: event.currentTarget.value };
            }}
            maxlength="120"
          />
        </label>
      </section>

      <section class="space-y-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-4">
        <div>
          <h3 class="text-sm font-semibold text-[var(--color-text-primary)]">Icon style</h3>
          <p class="mt-1 text-xs leading-relaxed text-[var(--color-text-muted)]">
            Start with a content style, then tune its color and silhouette below.
          </p>
        </div>
        <KorySelect
          label="Icon mode"
          value={mode}
          options={modeOptions}
          disabled={loading || saving}
          onchange={(next) => setMode(next as ProjectIconSpec['mode'])}
        />

        {#if mode === 'monogram'}
          <div class="space-y-2">
            <label class="block text-xs font-medium text-[var(--color-text-secondary)]" for="icon-value">
              Monogram &amp; emoji
              <input
                id="icon-value"
                class="mt-2 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-1)] px-3 py-2.5 text-sm text-[var(--color-text-primary)] outline-none transition-colors focus:border-[var(--color-accent)]"
                bind:value
                disabled={loading || saving}
                placeholder="🚀 or K"
                autocomplete="off"
                spellcheck="false"
              />
            </label>
            <p class="text-[11px] leading-relaxed text-[var(--color-text-muted)]">
              One or two letters, an emoji, or both. Both parts are drawn together inside the icon.
            </p>
            {#if monogramTooLong}
              <p role="alert" class="text-[11px] text-[var(--color-error)]">
                Use at most two characters or one emoji.
              </p>
            {/if}
          </div>
        {/if}

        <div class="space-y-3">
          <div>
            <h4 class="text-xs font-semibold text-[var(--color-text-primary)]">Color</h4>
            <p class="mt-1 text-[11px] leading-relaxed text-[var(--color-text-muted)]">
              Keep the deterministic color, choose a theme token, or use a custom hex color.
            </p>
          </div>
          <KorySelect
            label="Color"
            value={colorChoice}
            options={colorSelectOptions}
            disabled={loading || saving}
            onchange={setColorChoice}
          />
          {#if colorChoice === 'custom'}
            <div class="flex items-center gap-3">
              <button
                type="button"
                class="h-11 w-11 shrink-0 rounded-xl border border-[var(--color-border)] shadow-inner"
                style={`background: ${customColor || '#D5B261'};`}
                disabled={loading || saving}
                onclick={() => (showColorPicker = true)}
                aria-label="Open color picker"
              ></button>
              <input
                type="text"
                aria-label="Custom hex color"
                value={customColor}
                maxlength="7"
                spellcheck="false"
                disabled={loading || saving}
                class="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 font-mono text-xs uppercase text-[var(--color-text-primary)] outline-none transition-colors focus:border-[var(--color-accent)] disabled:opacity-50"
                oninput={(event) => {
                  const next = (event.currentTarget as HTMLInputElement).value;
                  const normalized = normalizeProjectIconCustomColor(next);
                  if (normalized) customColor = normalized;
                }}
              />
              <button
                type="button"
                class="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-2.5 py-1.5 text-[11px] font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-3)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/60 disabled:opacity-50"
                disabled={loading || saving}
                onclick={() => (showColorPicker = true)}
              >
                <Palette size={12} /> Pick color
              </button>
            </div>
          {/if}
        </div>

        <fieldset class="space-y-2" disabled={loading || saving}>
          <legend class="text-xs font-semibold text-[var(--color-text-primary)]">Shape</legend>
          <p class="text-[11px] leading-relaxed text-[var(--color-text-muted)]">
            Choose the silhouette that appears beside the project name.
          </p>
          <div class="grid grid-cols-3 gap-2">
            {#each shapeOptions as option (option.value)}
              <button
                type="button"
                aria-label={option.label}
                aria-pressed={shape === option.value}
                class="flex min-h-20 flex-col items-center justify-center gap-2 rounded-xl border px-2 py-2 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/60 {shape ===
                option.value
                  ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/12 text-[var(--color-text-primary)]'
                  : 'border-[var(--color-border)] bg-[var(--color-surface-1)] text-[var(--color-text-secondary)] hover:border-[var(--color-accent)]/50 hover:bg-[var(--color-surface-3)] hover:text-[var(--color-text-primary)]'}"
                onclick={() => (shape = option.value)}
              >
                <span
                  class="h-8 w-8 border border-current bg-[var(--color-accent)]/20"
                  style={`border-radius: ${option.radius};`}
                ></span>
                {option.label}
              </button>
            {/each}
          </div>
        </fieldset>

        {#if mode === 'image'}
          <div class="project-image-editor">
            <CustomProviderIconEditor
              existingIconUrl={assetUrl || null}
              disabled={loading || saving || !identity}
              onchange={(selection) => void uploadImage(selection)}
            />
          </div>
          <p class="text-[11px] leading-relaxed text-[var(--color-text-muted)]">
            Images are normalized to a private 256×256 PNG asset. Shape and color changes are saved
            with the project identity; no image data is stored in browser storage.
          </p>
        {/if}
      </section>

      {#if error}<p role="alert" class="text-xs text-[var(--color-error)]">{error}</p>{/if}
      {#if message}<p role="status" class="text-xs text-[var(--color-success)]">{message}</p>{/if}
      <div class="flex flex-wrap items-center justify-between gap-3">
        <p class="text-[11px] leading-relaxed text-[var(--color-text-muted)]">
          Changes apply to every client connected to this project.
        </p>
        <div class="flex flex-wrap gap-2">
          <button
            type="button"
            class="rounded-xl bg-[var(--color-accent)] px-4 py-2.5 text-xs font-semibold text-[var(--color-surface-0)] transition-opacity disabled:opacity-50"
            disabled={saving || loading || !identity || (mode === 'image' && !value)}
            onclick={() => void save()}>{saving ? 'Saving…' : 'Save identity'}</button
          >
          <button
            type="button"
            class="rounded-xl border border-[var(--color-border)] px-4 py-2.5 text-xs font-semibold text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-2)] disabled:opacity-50"
            disabled={saving || loading || !identity}
            onclick={() => void reset()}>Reset</button
          >
        </div>
      </div>
    {/if}
  </div>
  <ColorPickerModal
    open={showColorPicker}
    target="primary"
    onClose={() => (showColorPicker = false)}
    onApply={(hex) => {
      customColor = hex;
      showColorPicker = false;
    }}
  />
</div>

<style>
  /* The project-level shape picker above is the single source of truth. Keep
   * the existing crop editor focused on framing without changing its provider
   * settings implementation. */
  :global(.project-image-editor fieldset) {
    display: none;
  }
</style>
