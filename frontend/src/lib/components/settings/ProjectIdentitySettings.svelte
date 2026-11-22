<script lang="ts">
  import { onMount } from 'svelte';
  import {
    automaticProjectIcon,
    normalizeProjectIconCustomColor,
    normalizeProjectIconSpec,
    segmentGraphemes,
    MAX_PROJECT_MONOGRAM_GRAPHEMES,
    PROJECT_ICON_COLORS,
    type ProjectIconColor,
    type ProjectIconCustomColor,
    type ProjectIconMode,
    type ProjectIconShape,
    type ProjectIconSpec,
    type ProjectIdentity,
  } from '@koryphaios/shared';
  import { apiFetch, parseJsonResponse } from '$lib/api.svelte';
  import { apiUrl } from '$lib/utils/api-url';
  import {
    projectIdentityFor,
    projectIdentityProjection,
    projectStore,
  } from '$lib/stores/project.svelte';
  import { projectIconAssetUrl, readBlobAsDataUrl } from '$lib/utils/project-icon-assets.svelte';
  import { PROJECT_ICON_COLOR_CSS } from '$lib/utils/project-icon-colors';
  import Palette from 'lucide-svelte/icons/palette';
  import ImagePlus from 'lucide-svelte/icons/image-plus';
  import KorySelect from '../KorySelect.svelte';
  import ProjectIcon from '../ProjectIcon.svelte';
  import CustomProviderIconEditor from './CustomProviderIconEditor.svelte';
  import SettingsPage from './SettingsPage.svelte';
  import ColorPickerModal from '../ColorPickerModal.svelte';
  import type { CustomProviderIconSelection } from './custom-provider-icon';

  type IconMode = ProjectIconMode;
  /** 'project' means "let the identity pick its deterministic color". */
  type ColorChoice = 'project' | 'custom' | ProjectIconColor;
  type IdentityResponse = {
    ok?: boolean;
    data?: ProjectIdentity & { revision?: number; assetUrl?: string };
    error?: string;
  };

  /** User-picked path; null while the picker keeps following the active project. */
  let pinnedPath = $state<string | null>(null);
  let loadedPath = $state<string | null>(null);
  let identity = $state<ProjectIdentity | null>(null);
  let revision = $state(1);
  let name = $state('');
  let mode = $state<IconMode>('automatic');
  let monogramText = $state('');
  let imageAssetId = $state('');
  /** Cropped PNG staged locally; nothing is uploaded until Save. */
  let imageDraft = $state<{ blob: Blob; dataUrl: string } | null>(null);
  let draftToken = 0;
  let assetUrl = $state('');
  let colorChoice = $state<ColorChoice>('project');
  let customColor = $state('');
  let shape = $state<ProjectIconShape>('rounded-square');
  let cleanFingerprint = $state('');
  let loading = $state(false);
  let saving = $state(false);
  let message = $state('');
  let error = $state('');
  let showColorPicker = $state(false);

  const editingPath = $derived(pinnedPath ?? projectStore.currentPath);

  const projectOptions = $derived.by(() => {
    const options = projectStore.workspaceProjects.map((entry) => ({
      value: entry.path,
      label: projectIdentityFor(entry).name,
      description:
        entry.path === projectStore.currentPath
          ? `Current project · ${entry.path}`
          : entry.path,
    }));
    if (editingPath && !options.some((option) => option.value === editingPath)) {
      options.push({
        value: editingPath,
        label: editingPath.split(/[\\/]/u).filter(Boolean).at(-1) ?? editingPath,
        description:
          editingPath === projectStore.currentPath
            ? `Current project · ${editingPath}`
            : editingPath,
      });
    }
    return options;
  });
  const projectIdentityByPath = $derived(
    new Map(projectStore.workspaceProjects.map((entry) => [entry.path, projectIdentityFor(entry)])),
  );

  const contentCards: Array<{ value: IconMode; label: string; description: string }> = [
    { value: 'automatic', label: 'Initials', description: 'From the project name' },
    { value: 'monogram', label: 'Custom', description: 'Letters or emoji' },
    { value: 'image', label: 'Image', description: 'Your picture' },
    { value: 'color', label: 'Color only', description: 'Just a colored shape' },
  ];
  const colorSelectOptions = [
    {
      value: 'project',
      label: 'Project color',
      description: 'Picked from the project name',
    },
    ...PROJECT_ICON_COLORS.map((item) => ({
      value: item,
      label: item[0].toUpperCase() + item.slice(1),
    })),
    { value: 'custom', label: 'Custom', description: 'Choose any validated hex color.' },
  ];
  const shapeOptions: Array<{ value: ProjectIconShape; label: string }> = [
    { value: 'circle', label: 'Circle' },
    { value: 'rounded-square', label: 'Rounded' },
    { value: 'square', label: 'Square' },
    { value: 'transparent', label: 'None' },
  ];

  const previewIdentity = $derived.by((): ProjectIdentity | null => {
    const base =
      identity ??
      (editingPath
        ? projectIdentityProjection({
            path: editingPath,
            name: editingPath.split(/[\\/]/u).filter(Boolean).at(-1) ?? 'Project',
            modifiedAt: 0,
          }).identity
        : null);
    if (!base) return null;
    const nextName = name.trim();
    return nextName && nextName !== base.name ? { ...base, name: nextName } : base;
  });
  /** The deterministic "project color" for the identity being previewed. */
  const projectColor = $derived<ProjectIconColor>(
    previewIdentity ? (automaticProjectIcon(previewIdentity).color ?? 'accent') : 'accent',
  );

  /** Monogram text and image assetId are separate fields so style switches never leak one into the other. */
  function buildPendingSpec(
    specMode: IconMode,
    monogram: string,
    assetId: string,
    choice: ColorChoice,
    custom: string,
    iconShape: ProjectIconShape,
    fallbackColor: ProjectIconColor,
  ): ProjectIconSpec {
    const normalizedCustom =
      choice === 'custom' ? normalizeProjectIconCustomColor(custom) : undefined;
    const presentation: {
      color?: ProjectIconColor;
      customColor?: ProjectIconCustomColor;
      shape: ProjectIconShape;
    } = { shape: iconShape };
    if (normalizedCustom) presentation.customColor = normalizedCustom;
    else if (choice !== 'custom' && choice !== 'project') presentation.color = choice;
    else if (specMode === 'color') presentation.color = fallbackColor;
    switch (specMode) {
      case 'monogram':
        return { mode: 'monogram', value: monogram.trim(), ...presentation };
      case 'color':
        return { mode: 'color', ...presentation };
      case 'image':
        return { mode: 'image', assetId: assetId || 'pending-upload', ...presentation };
      default:
        return { mode: 'automatic', ...presentation };
    }
  }

  const pendingSpec = $derived(
    buildPendingSpec(
      mode,
      monogramText,
      imageAssetId,
      colorChoice,
      customColor,
      shape,
      projectColor,
    ),
  );
  const imagePreviewUrl = $derived(imageDraft?.dataUrl ?? assetUrl);

  const fingerprint = $derived(
    JSON.stringify({
      name,
      spec: normalizeProjectIconSpec(pendingSpec),
      draft: mode === 'image' && imageDraft !== null,
    }),
  );
  const dirty = $derived(Boolean(cleanFingerprint) && fingerprint !== cleanFingerprint);

  const graphemeCount = $derived(
    mode === 'monogram' ? segmentGraphemes(monogramText.trim()).length : 0,
  );
  const monogramTooLong = $derived(
    mode === 'monogram' && graphemeCount > MAX_PROJECT_MONOGRAM_GRAPHEMES,
  );
  const customColorInvalid = $derived(
    colorChoice === 'custom' && !normalizeProjectIconCustomColor(customColor),
  );
  const canSave = $derived(
    Boolean(identity) &&
      !loading &&
      !saving &&
      dirty &&
      !monogramTooLong &&
      !customColorInvalid &&
      (mode !== 'image' || Boolean(imageDraft) || Boolean(imageAssetId)),
  );

  function fieldsFromIcon(icon: ProjectIconSpec) {
    return {
      mode: icon.mode as IconMode,
      monogramText: icon.mode === 'monogram' ? icon.value : '',
      imageAssetId: icon.mode === 'image' ? icon.assetId : '',
      colorChoice: (icon.customColor ? 'custom' : (icon.color ?? 'project')) as ColorChoice,
      customColor: icon.customColor ?? '',
      shape: icon.shape ?? 'rounded-square',
    };
  }

  function setFromIdentity(next: ProjectIdentity, nextRevision = 1) {
    const fields = fieldsFromIcon(next.icon);
    identity = next;
    revision = nextRevision;
    name = next.name;
    mode = fields.mode;
    monogramText = fields.monogramText;
    imageAssetId = fields.imageAssetId;
    imageDraft = null;
    draftToken += 1;
    assetUrl =
      next.icon.mode === 'image'
        ? (next.assetUrl ?? `/api/workspace/project-icon/${next.icon.assetId}`)
        : '';
    colorChoice = fields.colorChoice;
    customColor = fields.customColor;
    shape = fields.shape;
    // Snapshot the form-equivalent of the stored spec so edits can be
    // detected against the same defaults the form applies.
    cleanFingerprint = JSON.stringify({
      name: next.name,
      spec: normalizeProjectIconSpec(
        buildPendingSpec(
          fields.mode,
          fields.monogramText,
          fields.imageAssetId,
          fields.colorChoice,
          fields.customColor,
          fields.shape,
          automaticProjectIcon(next).color ?? 'accent',
        ),
      ),
      draft: false,
    });
  }

  function selectProject(path: string) {
    if (!path || path === editingPath) return;
    pinnedPath = path;
  }

  let shapeNotice = $state('');

  function setMode(next: IconMode) {
    if (next === mode) return;
    mode = next;
    shapeNotice = '';
    if (next === 'monogram' && !monogramText.trim() && previewIdentity) {
      monogramText = automaticProjectIcon(previewIdentity).value;
    }
    // A color-only tile has nothing to paint without a background.
    if (next === 'color' && shape === 'transparent') {
      shape = 'rounded-square';
      shapeNotice = 'Color only needs a shape — background switched to Rounded.';
    }
  }

  function setColorChoice(next: string) {
    colorChoice = next as ColorChoice;
    if (next === 'custom' && !customColor) customColor = '#D5B261';
  }

  function swatchBackground(value: string): string {
    if (value === 'project') return PROJECT_ICON_COLOR_CSS[projectColor];
    if (value === 'custom') {
      return (
        normalizeProjectIconCustomColor(customColor) ??
        'conic-gradient(#F04747, #F59E0B, #34C759, #0A84FF, #BF5AF2, #F04747)'
      );
    }
    return PROJECT_ICON_COLOR_CSS[value as ProjectIconColor] ?? 'transparent';
  }

  function stageImageDraft(selection: CustomProviderIconSelection | null) {
    if (!selection?.blob) {
      imageDraft = null;
      draftToken += 1;
      // Removing a stored image leaves nothing to show — return to initials.
      if (mode === 'image' && imageAssetId) {
        mode = 'automatic';
        imageAssetId = '';
        assetUrl = '';
      }
      return;
    }
    const blob = selection.blob;
    const token = ++draftToken;
    void readBlobAsDataUrl(blob)
      .then((dataUrl) => {
        if (token === draftToken) imageDraft = { blob, dataUrl };
      })
      .catch(() => {
        error = 'Could not read the edited image';
      });
  }

  async function load(path: string) {
    loadedPath = path;
    loading = true;
    error = '';
    message = '';
    imageDraft = null;
    draftToken += 1;
    try {
      const response = await apiFetch(apiUrl('/api/workspace/project-identity'), {
        headers: { 'X-Koryphaios-Project': path },
      });
      if (loadedPath !== path) return; // a newer selection superseded this fetch
      const body = await parseJsonResponse<IdentityResponse>(response);
      if (loadedPath !== path) return;
      if (!response.ok || !body.ok || !body.data)
        throw new Error(body.error || 'Could not load project identity');
      setFromIdentity(body.data, body.data.revision ?? 1);
    } catch (cause) {
      if (loadedPath !== path) return;
      error = cause instanceof Error ? cause.message : 'Could not load project identity';
    } finally {
      if (loadedPath === path) loading = false;
    }
  }

  async function save() {
    const path = editingPath;
    if (!path || !identity || saving || !canSave) return;
    saving = true;
    error = '';
    message = '';
    try {
      const pendingName = name;
      const nameChanged = pendingName !== identity.name;
      if (mode === 'image' && imageDraft) {
        // One upload per save: the POST commits the image plus its
        // presentation, then a second call carries a name change only.
        const form = new FormData();
        form.set('file', imageDraft.blob, 'project-icon.png');
        form.set(
          'color',
          colorChoice === 'custom' || colorChoice === 'project' ? '' : colorChoice,
        );
        form.set('customColor', colorChoice === 'custom' ? customColor : '');
        form.set('shape', shape);
        const uploadResponse = await apiFetch(apiUrl('/api/workspace/project-icon'), {
          method: 'POST',
          headers: { 'X-Koryphaios-Project': path },
          body: form,
        });
        const uploadBody = await parseJsonResponse<IdentityResponse>(uploadResponse);
        if (!uploadResponse.ok || !uploadBody.ok || !uploadBody.data)
          throw new Error(uploadBody.error || 'Could not upload project icon');
        setFromIdentity(uploadBody.data, uploadBody.data.revision ?? revision + 1);
        if (nameChanged) {
          const nameResponse = await apiFetch(apiUrl('/api/workspace/project-identity'), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'X-Koryphaios-Project': path },
            body: JSON.stringify({ name: pendingName, expectedRevision: revision }),
          });
          const nameBody = await parseJsonResponse<IdentityResponse>(nameResponse);
          if (!nameResponse.ok || !nameBody.ok || !nameBody.data)
            throw new Error(nameBody.error || 'Could not save project identity');
          setFromIdentity(nameBody.data, nameBody.data.revision ?? revision + 1);
        }
      } else {
        const response = await apiFetch(apiUrl('/api/workspace/project-identity'), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'X-Koryphaios-Project': path },
          body: JSON.stringify({
            name: pendingName,
            icon: normalizeProjectIconSpec(pendingSpec),
            expectedRevision: revision,
          }),
        });
        const body = await parseJsonResponse<IdentityResponse>(response);
        if (!response.ok || !body.ok || !body.data)
          throw new Error(body.error || 'Could not save project identity');
        setFromIdentity(body.data, body.data.revision ?? revision + 1);
      }
      message = 'Project identity saved.';
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not save project identity';
    } finally {
      saving = false;
    }
  }

  async function reset() {
    const path = editingPath;
    if (!path || !identity || saving || loading) return;
    saving = true;
    error = '';
    message = '';
    try {
      const response = await apiFetch(apiUrl('/api/workspace/project-identity'), {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', 'X-Koryphaios-Project': path },
        body: JSON.stringify({ expectedRevision: revision }),
      });
      const body = await parseJsonResponse<IdentityResponse>(response);
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

  onMount(() => {
    const path = editingPath;
    if (path && loadedPath !== path) void load(path);
  });
  $effect(() => {
    const path = editingPath;
    if (path && loadedPath !== path) void load(path);
  });
</script>

<div class="flex min-h-0 flex-1 flex-col overflow-y-auto">
  <SettingsPage
    title="Project identity"
    description="Choose the name, appearance, and shape Koryphaios uses for this project everywhere."
    width="narrow"
  >
    {#if projectOptions.length > 0 || !editingPath}
      <div class="space-y-3">
        {#if projectOptions.length > 0}
          <KorySelect
            label="Project"
            value={editingPath ?? ''}
            options={projectOptions}
            searchable={projectStore.workspaceProjects.length > 8}
            disabled={loading || saving}
            leading={projectLeading}
            onchange={selectProject}
          />
        {/if}
        {#if !editingPath}
          <p class="text-sm text-[var(--color-text-muted)]">Select a project to edit its identity.</p>
        {/if}
      </div>
    {/if}

    {#if editingPath}
      {#if loading}<p class="text-xs text-[var(--color-text-muted)]">
          Loading project identity…
        </p>{/if}
      {#if previewIdentity}
        <section
          class="space-y-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-4"
        >
          <div class="flex items-center gap-4">
            <ProjectIcon
              identity={previewIdentity}
              icon={pendingSpec}
              assetUrl={mode === 'image' ? imagePreviewUrl : ''}
              size={72}
            />
            <div class="min-w-0 flex-1 space-y-2">
              <div class="min-w-0">
                <p class="truncate text-base font-semibold text-[var(--color-text-primary)]">
                  {previewIdentity.name}
                </p>
                <p class="mt-0.5 truncate text-xs text-[var(--color-text-muted)]" title={editingPath}>
                  {editingPath}
                </p>
              </div>
              <div
                class="flex w-fit items-center gap-1.5 rounded-lg bg-[var(--color-surface-1)] py-1 pl-1 pr-2.5"
              >
                <ProjectIcon
                  identity={previewIdentity}
                  icon={pendingSpec}
                  assetUrl={mode === 'image' ? imagePreviewUrl : ''}
                  size={20}
                />
                <span
                  class="truncate text-xs font-medium text-[var(--color-text-secondary)]"
                  aria-label="Sidebar preview">{previewIdentity.name}</span
                >
              </div>
            </div>
          </div>
          <label class="block text-xs font-medium text-[var(--color-text-secondary)]" for="project-name">
            Display name
            <input
              id="project-name"
              class="mt-2 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-1)] px-3 py-2.5 text-sm text-[var(--color-text-primary)] outline-none transition-colors focus:border-[var(--color-accent)]"
              bind:value={name}
              disabled={loading || saving}
              maxlength="120"
            />
          </label>
        </section>
      {/if}

      <section class="space-y-5">
        <div>
          <h3 class="text-sm font-semibold text-[var(--color-text-primary)]">Icon</h3>
          <p class="mt-1 text-xs leading-relaxed text-[var(--color-text-muted)]">
            Pick what the icon shows, then how much background it gets and its color.
          </p>
        </div>

        <div class="space-y-2">
          <h4 class="text-xs font-semibold text-[var(--color-text-primary)]">Content</h4>
          <div class="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {#each contentCards as card (card.value)}
              <button
                type="button"
                aria-label={card.label}
                aria-pressed={mode === card.value}
                class="flex min-h-20 flex-col items-center justify-center gap-1.5 rounded-xl border px-2 py-2 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/60 disabled:cursor-not-allowed disabled:opacity-50 {mode === card.value ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/12 text-[var(--color-text-primary)]' : 'border-[var(--color-border)] bg-[var(--color-surface-1)] text-[var(--color-text-secondary)] hover:border-[var(--color-accent)]/50 hover:bg-[var(--color-surface-3)] hover:text-[var(--color-text-primary)]'}"
                onclick={() => setMode(card.value)}
              >
                {#if previewIdentity}
                  {@render contentTilePreview(card.value)}
                {/if}
                <span>{card.label}</span>
                <span class="text-center text-[11px] font-normal leading-tight text-[var(--color-text-muted)]">
                  {card.description}
                </span>
              </button>
            {/each}
          </div>
        </div>

        {#if mode === 'monogram' || mode === 'image'}
          <div class="border-t border-[var(--color-border)] pt-4">
            {#if mode === 'monogram'}
              <div class="space-y-2">
                <label
                  class="block text-xs font-medium text-[var(--color-text-secondary)]"
                  for="icon-value"
                >
                  Letters &amp; emoji
                  <input
                    id="icon-value"
                    class="mt-2 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-1)] px-3 py-2.5 text-sm text-[var(--color-text-primary)] outline-none transition-colors focus:border-[var(--color-accent)]"
                    bind:value={monogramText}
                    disabled={loading || saving}
                    placeholder="🚀 or K"
                    autocomplete="off"
                    spellcheck="false"
                  />
                </label>
                <p class="text-[11px] leading-relaxed text-[var(--color-text-muted)]">
                  One or two letters, an emoji, or both. Both parts are drawn together inside the
                  icon.
                </p>
                {#if monogramTooLong}
                  <p role="alert" class="text-[11px] text-[var(--color-error)]">
                    Use at most two characters or one emoji.
                  </p>
                {/if}
              </div>
            {/if}

            {#if mode === 'image'}
              <div class="project-image-editor">
                <CustomProviderIconEditor
                  existingIconUrl={imageDraft?.dataUrl ?? projectIconAssetUrl(assetUrl)}
                  frameShape={shape === 'transparent' ? 'square' : shape}
                  disabled={loading || saving || !identity}
                  onchange={stageImageDraft}
                />
              </div>
              <p class="text-[11px] leading-relaxed text-[var(--color-text-muted)]">
                Images are normalized to a private 256×256 PNG asset. The upload happens when you
                save; no image data is stored in browser storage.
              </p>
            {/if}
          </div>
        {/if}

        <div class="space-y-2">
          <h4 class="text-xs font-semibold text-[var(--color-text-primary)]">Background</h4>
          {#if shapeNotice}
            <p role="status" class="text-[11px] leading-relaxed text-[var(--color-text-muted)]">
              {shapeNotice}
            </p>
          {/if}
          {#if mode === 'color'}
            <p class="text-[11px] leading-relaxed text-[var(--color-text-muted)]">
              Color only needs a shape, so None is unavailable.
            </p>
          {/if}
          <div class="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {#each shapeOptions as option (option.value)}
              {@const disabled = option.value === 'transparent' && mode === 'color'}
              <button
                type="button"
                aria-label={option.label}
                aria-pressed={shape === option.value}
                {disabled}
                title={disabled ? 'Color only needs a shape' : option.label}
                class="flex min-h-20 flex-col items-center justify-center gap-1.5 rounded-xl border px-2 py-2 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/60 disabled:cursor-not-allowed disabled:opacity-50 {shape === option.value ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/12 text-[var(--color-text-primary)]' : 'border-[var(--color-border)] bg-[var(--color-surface-1)] text-[var(--color-text-secondary)] hover:border-[var(--color-accent)]/50 hover:bg-[var(--color-surface-3)] hover:text-[var(--color-text-primary)]'}"
                onclick={() => {
                  shape = option.value;
                  shapeNotice = '';
                }}
              >
                {#if previewIdentity}
                  <ProjectIcon
                    identity={previewIdentity}
                    icon={buildPendingSpec(
                      mode,
                      monogramText,
                      imageAssetId,
                      colorChoice,
                      customColor,
                      option.value,
                      projectColor,
                    )}
                    assetUrl={mode === 'image' ? imagePreviewUrl : ''}
                    size={34}
                  />
                {/if}
                {option.label}
              </button>
            {/each}
          </div>
        </div>

        <div class="space-y-3">
          <div>
            <h4 class="text-xs font-semibold text-[var(--color-text-primary)]">Color</h4>
            <p class="mt-1 text-[11px] leading-relaxed text-[var(--color-text-muted)]">
              {#if mode === 'color'}
                Fill color.
              {:else if shape === 'transparent'}
                Letter color.
              {:else if mode === 'image'}
                Shown behind transparent areas and if the image can't load.
              {:else}
                Tints the background and colors the letters.
              {/if}
            </p>
          </div>
          <KorySelect
            label="Color"
            value={colorChoice}
            options={colorSelectOptions}
            disabled={loading || saving}
            leading={colorSwatch}
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
      </section>

      <div class="space-y-3">
      {#if error}<p role="alert" class="text-xs text-[var(--color-error)]">{error}</p>{/if}
      {#if message}<p role="status" class="text-xs text-[var(--color-success)]">{message}</p>{/if}
      <div class="flex flex-wrap items-center justify-between gap-3">
        <p class="text-[11px] leading-relaxed text-[var(--color-text-muted)]">
          {#if dirty}<span class="font-medium text-[var(--color-warning)]">Unsaved changes</span>
            · {/if}Changes apply to every client connected to this project.
        </p>
        <div class="flex flex-wrap gap-2">
          <button
            type="button"
            class="rounded-xl bg-[var(--color-accent)] px-4 py-2.5 text-xs font-semibold text-[var(--color-on-accent)] transition-colors disabled:cursor-not-allowed disabled:bg-[var(--color-surface-3)] disabled:text-[var(--color-text-muted)] disabled:shadow-none"
            disabled={!canSave}
            onclick={() => void save()}>{saving ? 'Saving…' : 'Save changes'}</button
          >
          <button
            type="button"
            class="rounded-xl border border-[var(--color-border)] px-4 py-2.5 text-xs font-semibold text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-2)] disabled:opacity-50"
            disabled={saving || loading || !identity}
            onclick={() => void reset()}>Reset to default</button
          >
        </div>
      </div>
      </div>
    {/if}
  </SettingsPage>
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

{#snippet projectLeading(option: { value: string } | undefined)}
  {#if option}
    {@const optionIdentity =
      projectIdentityByPath.get(option.value) ??
      (option.value === editingPath ? previewIdentity : null)}
    {#if optionIdentity}
      <ProjectIcon identity={optionIdentity} size={18} />
    {/if}
  {/if}
{/snippet}

{#snippet colorSwatch(option: { value: string } | undefined)}
  {#if option}
    <span
      data-testid="color-swatch"
      class="h-3.5 w-3.5 shrink-0 rounded border border-[var(--color-border)]"
      style={`background: ${swatchBackground(option.value)};`}
      aria-hidden="true"
    ></span>
  {/if}
{/snippet}

{#snippet contentTilePreview(value: IconMode)}
  {#if previewIdentity}
    {#if value === 'automatic'}
      <ProjectIcon
        identity={previewIdentity}
        icon={buildPendingSpec(
          'automatic',
          '',
          '',
          colorChoice,
          customColor,
          'rounded-square',
          projectColor,
        )}
        size={34}
      />
    {:else if value === 'monogram'}
      <ProjectIcon
        identity={previewIdentity}
        icon={buildPendingSpec(
          'monogram',
          monogramText.trim() || 'Aa',
          '',
          colorChoice,
          customColor,
          'rounded-square',
          projectColor,
        )}
        size={34}
      />
    {:else if value === 'image'}
      {@const tileSrc = imageDraft?.dataUrl ?? projectIconAssetUrl(assetUrl)}
      {#if tileSrc}
        <img
          src={tileSrc}
          alt=""
          class="h-[34px] w-[34px] rounded-[24%] object-cover"
        />
      {:else}
        <span
          class="flex h-[34px] w-[34px] items-center justify-center rounded-[24%] bg-[var(--color-surface-3)] text-[var(--color-text-muted)]"
          aria-hidden="true"><ImagePlus size={16} /></span
        >
      {/if}
    {:else}
      <span
        class="h-[34px] w-[34px] rounded-[24%]"
        style={`background: ${swatchBackground(colorChoice)};`}
        aria-hidden="true"
      ></span>
    {/if}
  {/if}
{/snippet}
