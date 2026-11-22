<script lang="ts">
  import { onMount } from 'svelte';
  import RotateCcw from 'lucide-svelte/icons/rotate-ccw';
  import Sparkles from 'lucide-svelte/icons/sparkles';
  import Plus from 'lucide-svelte/icons/plus';
  import Trash2 from 'lucide-svelte/icons/trash-2';
  import Upload from 'lucide-svelte/icons/upload';
  import X from 'lucide-svelte/icons/x';
  import ChevronDown from 'lucide-svelte/icons/chevron-down';
  import KorySelect from './KorySelect.svelte';
  import SettingsPage from './settings/SettingsPage.svelte';
  import KorySlider from './KorySlider.svelte';
  import SettingsSwitch from './SettingsSwitch.svelte';
  import WelcomeCardIcon from './WelcomeCardIcon.svelte';
  import WelcomeBackground from './WelcomeBackground.svelte';
  import {
    welcomePreferencesStore,
    type WelcomePanelId,
  } from '$lib/stores/welcome-preferences.svelte';
  import { onboardingStore } from '$lib/stores/onboarding.svelte';
  import type { WelcomeSuggestionCard } from '@koryphaios/shared';
  import { providersStore } from '$lib/stores/providers.svelte';
  import { importWelcomeImage } from '$lib/utils/welcome-image';
  import type { WelcomeTextColor } from '$lib/utils/welcome-background-contrast';

  interface Props {
    onReplayWalkthrough?: () => void;
  }

  let { onReplayWalkthrough }: Props = $props();
  let selectedId = $state<string | null>(null);
  let advancedOpen = $state(false);
  let importError = $state('');
  let backgroundInput = $state<HTMLInputElement>();
  let iconInput = $state<HTMLInputElement>();
  let previewTextColor = $state<WelcomeTextColor | undefined>();

  const panels: Array<{ id: WelcomePanelId; label: string; description: string }> = [
    { id: 'suggestions', label: 'Starting suggestions', description: 'Show your preset cards in an empty agent feed.' },
  ];
  const iconOptions = [
    { value: 'sparkles', label: 'Sparkles' }, { value: 'zap', label: 'Lightning' },
    { value: 'paintbrush', label: 'Paintbrush' }, { value: 'git-branch', label: 'Branch' },
    { value: 'bug', label: 'Bug' }, { value: 'bot', label: 'Bot' },
    { value: 'terminal', label: 'Terminal' }, { value: 'layers', label: 'Layers' },
  ];
  const reasoningOptions = [
    { value: '', label: 'Provider default' }, { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' },
  ];
  const permissionOptions = [
    { value: '', label: 'Workspace default' }, { value: 'guarded', label: 'Guarded' },
    { value: 'ask', label: 'Ask before changes' },
    { value: 'yolo', label: 'YOLO' },
  ];
  const fitOptions = [
    { value: 'cover', label: 'Fill / crop' }, { value: 'contain', label: 'Fit entire image' },
    { value: 'fill', label: 'Stretch' },
  ];
  const positionOptions = [
    { value: 'center', label: 'Center' }, { value: 'top', label: 'Top' },
    { value: 'bottom', label: 'Bottom' }, { value: 'left', label: 'Left' }, { value: 'right', label: 'Right' },
  ];
  const cards = $derived(Object.entries(welcomePreferencesStore.preferences.suggestionCards));
  const visibleCards = $derived(cards.filter(([, card]) => card.enabled));
  const selectedCard = $derived(
    selectedId ? welcomePreferencesStore.preferences.suggestionCards[selectedId] : undefined,
  );
  const selectedCardId = $derived(selectedId ?? '');
  const providerOptions = $derived([
    { value: '', label: 'Auto / workspace default' },
    ...providersStore.statusList.map((provider) => ({ value: provider.name, label: provider.name })),
  ]);
  const walkthroughStatus = $derived.by(() => {
    const record = onboardingStore.record;
    if (!record) return 'Not completed yet on this device.';
    const when = new Date(record.finishedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    return record.outcome === 'completed' ? `Completed on ${when}.` : `Skipped on ${when}.`;
  });

  onMount(() => {
    if (providersStore.statusList.length === 0) void providersStore.loadProvidersFromApi();
    if (!selectedId && cards[0]) selectedId = cards[0][0];
  });

  function updateCard(id: string, patch: Partial<WelcomeSuggestionCard>) {
    welcomePreferencesStore.setSuggestionCard(id, patch);
  }

  function addCard() {
    const id = welcomePreferencesStore.addSuggestionCard();
    selectedId = id;
    advancedOpen = true;
  }

  function removeCard(id: string) {
    welcomePreferencesStore.removeSuggestionCard(id);
    if (selectedId === id) selectedId = cards.find(([cardId]) => cardId !== id)?.[0] ?? null;
  }

  function modelOptions(providerName: string) {
    const provider = providersStore.statusList.find((entry) => entry.name === providerName);
    return [{ value: '', label: 'Provider default' }, ...(provider?.models ?? []).map((model) => ({ value: model, label: model }))];
  }

  function setBrightness(
    background: NonNullable<typeof welcomePreferencesStore.preferences.background>,
    raw: string,
  ) {
    const value = Number(raw.replace(/[^0-9.]/g, ''));
    if (!Number.isFinite(value)) return;
    welcomePreferencesStore.setBackground({
      ...background,
      opacity: Math.min(100, Math.max(0, value)) / 100,
    });
  }

  async function importBackground(event: Event) {
    const file = (event.currentTarget as HTMLInputElement).files?.[0];
    (event.currentTarget as HTMLInputElement).value = '';
    if (!file) return;
    try {
      importError = '';
      const source = await importWelcomeImage(file, 'background');
      welcomePreferencesStore.setBackground({ source, fit: 'cover', position: 'center', opacity: 0.45 });
    } catch (error) {
      importError = error instanceof Error ? error.message : 'Image import failed.';
    }
  }

  async function importIcon(event: Event) {
    if (!selectedId) return;
    const id = selectedId;
    const file = (event.currentTarget as HTMLInputElement).files?.[0];
    (event.currentTarget as HTMLInputElement).value = '';
    if (!file) return;
    try {
      importError = '';
      const iconSource = await importWelcomeImage(file, 'icon');
      if (welcomePreferencesStore.preferences.suggestionCards[id]) updateCard(id, { iconSource });
    } catch (error) {
      importError = error instanceof Error ? error.message : 'Icon import failed.';
    }
  }

  function replayWalkthrough() {
    onboardingStore.replay();
    onReplayWalkthrough?.();
  }
</script>

<SettingsPage
  title="Home screen"
  description="Shape the empty feed with a background and the starting points you actually use."
  width="wide"
>
  {#snippet actions()}
    <button type="button" class="quiet-button" onclick={replayWalkthrough}><Sparkles size={14} /> Replay walkthrough</button>
  {/snippet}
<div class="home-settings">
  <section class="preview-shell" aria-label="Home screen preview">
    <div class="preview-toolbar">
      <div>
        <div class="flex items-center gap-2"><span class="status-dot"></span><h4>Live preview</h4></div>
        <p>Changes appear here immediately.</p>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <input bind:this={backgroundInput} id="home-background-file" class="hidden" type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" onchange={importBackground} />
        <button type="button" class="toolbar-button" onclick={() => backgroundInput?.click()}><Upload size={14} /> {welcomePreferencesStore.preferences.background ? 'Replace image' : 'Import image'}</button>
        {#if welcomePreferencesStore.preferences.background}
          <button type="button" class="toolbar-button muted" onclick={() => welcomePreferencesStore.setBackground(undefined)}><X size={14} /> Remove</button>
        {/if}
      </div>
    </div>
    <div class="preview-canvas">
      <WelcomeBackground
        background={welcomePreferencesStore.preferences.background}
        baseSurface="surface-1"
        contrastOpacity={0.52}
        onTextColor={(color) => (previewTextColor = color)}
      />
      <div class="preview-content" style:color={previewTextColor ?? 'var(--color-text-primary)'}>
        {#if welcomePreferencesStore.preferences.enabled.suggestions}
        <h2>{welcomePreferencesStore.preferences.homeTitle}</h2>
        <p class="preview-subtitle">{welcomePreferencesStore.preferences.homeSubtitle}</p>
        {#if visibleCards.length}
          <div class="preview-cards">
            {#each visibleCards as [id, card] (id)}
              <button type="button" aria-label={`Edit ${card.label} in preview`} aria-pressed={id === selectedId} class:selected={id === selectedId} class="preview-card" onclick={() => (selectedId = id)}>
                <span class="preview-icon"><WelcomeCardIcon icon={card.icon} source={card.iconSource} size={16} /></span>
                <span class="min-w-0 text-left"><strong>{card.label}</strong><small>{card.prompt}</small></span>
              </button>
            {/each}
          </div>
        {:else}
          <div class="preview-empty">Turn on a preset card to show it here.</div>
        {/if}
        {:else}
          <div class="preview-empty">Starting suggestions are hidden. Your home screen shows only the background.</div>
        {/if}
      </div>
    </div>
    {#if welcomePreferencesStore.preferences.background}
      {@const background = welcomePreferencesStore.preferences.background}
      <div class="background-controls">
        <div class="field"><span>Image scale</span><KorySelect compact label="Image scale" value={background.fit} options={fitOptions} onchange={(value) => welcomePreferencesStore.setBackground({ ...background, fit: value as 'cover' | 'contain' | 'fill' })} /></div>
        <div class="field"><span>Image position</span><KorySelect compact label="Image position" value={background.position} options={positionOptions} onchange={(value) => welcomePreferencesStore.setBackground({ ...background, position: value })} /></div>
        <div class="brightness-control">
          <div class="brightness-heading"><span>Brightness</span><input class="brightness-input" aria-label="Brightness percentage" inputmode="decimal" value={Math.round(background.opacity * 100)} onblur={(event) => setBrightness(background, event.currentTarget.value)} onkeydown={(event) => event.key === 'Enter' && setBrightness(background, event.currentTarget.value)} /><span>%</span></div>
          <KorySlider id="home-background-brightness" label="Brightness" value={background.opacity} min={0} max={1} step={0.01} displayValue={`${Math.round(background.opacity * 100)}%`} valueText={`${Math.round(background.opacity * 100)} percent`} onchange={(value) => welcomePreferencesStore.setBackground({ ...background, opacity: value })} />
        </div>
      </div>
    {/if}
  </section>
  {#if importError}<p role="alert" class="import-error text-sm text-[var(--color-error)]">{importError}</p>{/if}

  <section class="settings-section">
    <div class="section-heading"><div><h4>Home copy</h4><p>Edit the welcome message shown above the preset cards.</p></div></div>
    <div class="copy-fields">
      <label class="field"><span>Heading</span><input maxlength="160" value={welcomePreferencesStore.preferences.homeTitle} oninput={(event) => welcomePreferencesStore.setHomeCopy({ homeTitle: event.currentTarget.value })} /></label>
      <label class="field"><span>Supporting text</span><input maxlength="300" value={welcomePreferencesStore.preferences.homeSubtitle} oninput={(event) => welcomePreferencesStore.setHomeCopy({ homeSubtitle: event.currentTarget.value })} /></label>
    </div>
  </section>

  <section class="settings-section">
    <div class="section-heading">
      <div><h4>Starting suggestions</h4><p>Keep the home screen focused and useful.</p></div>
      {#each panels as panel}
        <div class="switch-control"><SettingsSwitch flat minimal quiet checked={welcomePreferencesStore.preferences.enabled[panel.id]} label={panel.label} description="" onchange={() => welcomePreferencesStore.setPanelEnabled(panel.id, !welcomePreferencesStore.preferences.enabled[panel.id])} /></div>
      {/each}
    </div>
    <div class="section-actions">
      <button type="button" class="text-button" onclick={() => welcomePreferencesStore.resetPanel('suggestions')}><RotateCcw size={13} /> Reset home content</button>
    </div>
  </section>

  <section class="settings-section">
    <div class="section-heading">
      <div><h4>Preset cards</h4><p>Select a card here or in the preview to edit its icon, name, and prompt.</p></div>
      <button type="button" class="accent-button" onclick={addCard}><Plus size={14} /> Add preset</button>
    </div>
    <div class="preset-layout">
      <div class="preset-list" role="group" aria-label="Preset cards">
        {#each cards as [id, card] (id)}
          <button type="button" aria-pressed={id === selectedId} class:selected={id === selectedId} class="preset-row" onclick={() => { selectedId = id; advancedOpen = false; }}>
            <span class="row-icon"><WelcomeCardIcon icon={card.icon} source={card.iconSource} size={17} /></span>
            <span class="min-w-0 flex-1 text-left"><strong>{card.label || 'Untitled preset'}</strong><small>{card.enabled ? 'Shown on home' : 'Hidden from home'}</small></span>
            <span class:active={card.enabled} class="visibility-pill">{card.enabled ? 'On' : 'Off'}</span>
          </button>
        {/each}
        {#if !cards.length}<p class="empty-list">No presets yet. Add one to get started.</p>{/if}
      </div>

      {#if selectedCard && selectedId}
        <div class="card-editor">
          <div class="editor-header">
            <div><p class="eyebrow">Editing preset</p><h5>{selectedCard.label || 'Untitled preset'}</h5></div>
            <button type="button" class="icon-button danger" title="Remove preset" aria-label={`Remove ${selectedCard.label}`} onclick={() => removeCard(selectedCardId)}><Trash2 size={15} /></button>
          </div>
          <div class="editor-main">
            <div class="icon-editor">
              <span class="large-icon"><WelcomeCardIcon icon={selectedCard.icon} source={selectedCard.iconSource} size={20} /></span>
              <div class="min-w-0"><strong>Card icon</strong><p>Use a built-in icon or import your own.</p></div>
              <input bind:this={iconInput} id="home-icon-file" class="hidden" type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" onchange={importIcon} />
              <button type="button" class="small-button" onclick={() => iconInput?.click()}><Upload size={13} /> Custom icon</button>
              {#if selectedCard.iconSource}<button type="button" class="small-button muted" onclick={() => updateCard(selectedCardId, { iconSource: undefined })}>Use built-in</button>{/if}
            </div>
            <div class="editor-grid">
              <label class="field"><span>Name</span><input maxlength="120" value={selectedCard.label} aria-label="Preset name" oninput={(event) => updateCard(selectedCardId, { label: event.currentTarget.value })} /></label>
              <div class="field"><span>Built-in icon</span><KorySelect compact label="Built-in icon" value={selectedCard.icon} options={iconOptions} onchange={(value) => updateCard(selectedCardId, { icon: value as WelcomeSuggestionCard['icon'], iconSource: undefined })} /></div>
            </div>
            <label class="field"><span>Prompt</span><textarea maxlength="20000" aria-label={`${selectedCard.label} task prompt`} value={selectedCard.prompt} oninput={(event) => updateCard(selectedCardId, { prompt: event.currentTarget.value })}></textarea></label>
            <div class="editor-footer">
              <SettingsSwitch compact flat checked={selectedCard.enabled} label="Show on home" description="This card appears in the live preview." onchange={() => updateCard(selectedCardId, { enabled: !selectedCard.enabled })} />
              <button type="button" class="advanced-toggle" aria-expanded={advancedOpen} onclick={() => (advancedOpen = !advancedOpen)}>Advanced options <span class:rotate-180={advancedOpen}><ChevronDown size={14} /></span></button>
            </div>
            {#if advancedOpen}
              <div class="advanced-panel">
                <div class="field"><span>Provider</span><KorySelect compact label="Provider" value={selectedCard.provider ?? ''} options={providerOptions} allowCustom customLabel="Use provider ID" onchange={(value) => updateCard(selectedCardId, { provider: value || undefined, model: value === selectedCard.provider ? selectedCard.model : undefined })} /></div>
                <div class="field"><span>Model</span><KorySelect compact label="Model" value={selectedCard.model ?? ''} options={modelOptions(selectedCard.provider ?? '')} allowCustom customLabel="Use model ID" onchange={(value) => updateCard(selectedCardId, { model: value || undefined })} /></div>
                <div class="field"><span>Reasoning</span><KorySelect compact label="Reasoning" value={selectedCard.reasoning ?? ''} options={reasoningOptions} onchange={(value) => updateCard(selectedCardId, { reasoning: value || undefined })} /></div>
                <div class="field"><span>Permissions</span><KorySelect compact label="Permissions" value={selectedCard.permission ?? ''} options={permissionOptions} onchange={(value) => updateCard(selectedCardId, { permission: value || undefined })} /></div>
                <label class="field"><span>Skills</span><input placeholder="Skills, separated by commas" value={selectedCard.skills.join(', ')} oninput={(event) => updateCard(selectedCardId, { skills: event.currentTarget.value.split(',').map((skill) => skill.trim()).filter(Boolean) })} /></label>
              </div>
            {/if}
          </div>
        </div>
      {/if}
    </div>
  </section>

  <p class="walkthrough-status">Welcome walkthrough · {walkthroughStatus}</p>
</div>
</SettingsPage>

<style>
  /* display: contents lets each section sit directly in SettingsPage's body
     stack (32px gaps) while keeping the descendant selectors below. */
  .home-settings { display: contents; color: var(--color-text-primary); }
  .quiet-button, .toolbar-button, .accent-button, .small-button, .text-button, .icon-button, .advanced-toggle { display: inline-flex; align-items: center; justify-content: center; gap: .45rem; transition: .16s ease; }
  .quiet-button, .toolbar-button, .small-button { border: 1px solid var(--color-border); border-radius: 8px; padding: .5rem .7rem; color: var(--color-text-secondary); background: color-mix(in srgb, var(--color-surface-2) 72%, transparent); font-size: .75rem; }
  .quiet-button:hover, .toolbar-button:hover, .small-button:hover { color: var(--color-text-primary); border-color: var(--color-text-muted); }
  .toolbar-button.muted, .small-button.muted { border-color: transparent; background: transparent; }
  .accent-button { border-radius: 8px; padding: .55rem .75rem; color: var(--color-accent); background: color-mix(in srgb, var(--color-accent) 12%, transparent); font-size: .8rem; font-weight: 600; flex-shrink: 0; }
  .accent-button:hover { filter: brightness(1.08); }
  .preview-shell { overflow: hidden; border: 1px solid var(--color-border); border-radius: 16px; background: var(--color-surface-2); }
  .preview-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 1rem; border-bottom: 1px solid var(--color-border); padding: .9rem 1rem; }
  .preview-toolbar h4, .section-heading h4 { font-size: .875rem; font-weight: 600; }
  .preview-toolbar p, .section-heading p, .icon-editor p, .section-actions { margin-top: .2rem; color: var(--color-text-muted); font-size: .7rem; }
  .status-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--color-accent); box-shadow: 0 0 0 4px color-mix(in srgb, var(--color-accent) 14%, transparent); }
  /* Keep these dimensions aligned with ManagerFeed's real empty-state:
     max-w-3xl, p-4, text-lg heading, mb-8 intro, and min-h-32 cards. */
  .preview-canvas { position: relative; min-height: 430px; background: var(--color-surface-1); background-repeat: no-repeat; transition: background .2s ease; }
  .preview-canvas::after { position: absolute; z-index: 0; inset: 0; content: ''; background: color-mix(in srgb, var(--color-surface-1) 48%, transparent); pointer-events: none; }
  .preview-content { position: relative; z-index: 1; max-width: 768px; margin: auto; padding: 1rem; }
  .eyebrow { color: var(--color-text-muted); font-size: .65rem; font-weight: 600; letter-spacing: .1em; text-transform: uppercase; }
  .preview-content h2 { margin-top: .25rem; font-size: 1.125rem; line-height: 1.25; font-weight: 650; letter-spacing: -.02em; }
  .preview-subtitle { margin-top: .5rem; margin-bottom: 2rem; color: color-mix(in srgb, currentColor 78%, transparent); font-size: .875rem; line-height: 1.5; }
  .preview-cards { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .75rem; }
  .preview-card { display: flex; align-items: flex-start; gap: .5rem; min-width: 0; min-height: 8rem; padding: 1rem; border: 1px solid var(--color-border); border-radius: 8px; background: var(--color-surface-1); text-align: left; transition: .16s ease; }
  .preview-card:hover, .preview-card.selected { border-color: color-mix(in srgb, var(--color-accent) 58%, var(--color-border)); transform: translateY(-1px); }
  .preview-icon, .row-icon, .large-icon { display: inline-flex; align-items: center; justify-content: center; flex: none; color: var(--color-accent); }
  .preview-icon { margin-top: .1rem; }
  .preview-card strong, .preset-row strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: .875rem; font-weight: 500; }
  .preview-card small, .preset-row small { display: block; overflow: hidden; margin-top: .5rem; color: var(--color-text-muted); font-size: .75rem; line-height: 1.5; text-overflow: ellipsis; }
  .preview-card small { display: -webkit-box; -webkit-line-clamp: 3; line-clamp: 3; -webkit-box-orient: vertical; }
  .preview-empty { padding: .25rem 0; color: var(--color-text-muted); font-size: .8125rem; }
  .settings-section { min-width: 0; }
  .import-error { margin-top: -1.25rem; }
  .section-heading { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
  .section-actions { display: flex; align-items: center; justify-content: flex-end; gap: 1rem; margin-top: .25rem; }
  .switch-control { flex: 0 0 auto; }
  .walkthrough-status { color: var(--color-text-muted); font-size: .75rem; }
  .text-button { padding: .25rem 0; color: var(--color-text-muted); font-size: .7rem; }
  .text-button:hover { color: var(--color-text-primary); }
  .preset-layout { display: grid; grid-template-columns: 225px minmax(0, 1fr); gap: 1rem; margin-top: 1rem; }
  .preset-list { display: flex; flex-direction: column; gap: .3rem; }
  .preset-row { display: flex; align-items: center; gap: .6rem; width: 100%; padding: .6rem; border: 1px solid transparent; border-radius: 9px; text-align: left; transition: .16s ease; }
  .preset-row:hover { background: var(--color-surface-2); }
  .preset-row.selected { border-color: color-mix(in srgb, var(--color-accent) 45%, var(--color-border)); background: color-mix(in srgb, var(--color-accent) 8%, var(--color-surface-2)); }
  .row-icon { width: 20px; }
  .visibility-pill { border-radius: 99px; padding: .16rem .36rem; color: var(--color-text-muted); background: var(--color-surface-3); font-size: 11px; }
  .visibility-pill.active { color: var(--color-accent); background: color-mix(in srgb, var(--color-accent) 12%, transparent); }
  .empty-list { padding: .8rem; color: var(--color-text-muted); font-size: .72rem; }
  .card-editor { min-width: 0; border-left: 1px solid var(--color-border); padding-left: 1.1rem; }
  .editor-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; }
  .editor-header h5 { margin-top: .2rem; font-size: .95rem; font-weight: 650; }
  .icon-button { width: 29px; height: 29px; border-radius: 7px; color: var(--color-text-muted); }
  .icon-button:hover { color: var(--color-error); background: var(--color-error-bg); }
  .editor-main { display: flex; flex-direction: column; gap: .9rem; margin-top: 1rem; }
  .icon-editor { display: flex; flex-wrap: wrap; align-items: center; gap: .65rem; padding-bottom: .5rem; }
  .large-icon { width: 24px; }
  .icon-editor strong { font-size: .74rem; font-weight: 600; }
  .icon-editor p { margin-top: .15rem; }
  .icon-editor .small-button { margin-left: auto; }
  .editor-grid, .advanced-panel, .background-controls { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .7rem; }
  .field { display: flex; min-width: 0; flex-direction: column; gap: .35rem; }
  .field span { color: var(--color-text-muted); font-size: 11px; }
  .field input, .field textarea { width: 100%; border: 1px solid var(--color-border); border-radius: 7px; background: var(--color-surface-1); padding: .55rem .65rem; color: var(--color-text-primary); font-size: .75rem; outline: none; }
  .field input:focus, .field textarea:focus { border-color: var(--color-accent); }
  .field textarea { min-height: 78px; resize: vertical; line-height: 1.45; }
  .editor-footer { display: flex; align-items: center; justify-content: space-between; gap: .8rem; border-top: 1px solid var(--color-border); padding-top: .65rem; }
  .advanced-toggle { color: var(--color-text-muted); font-size: .75rem; flex-shrink: 0; }
  .advanced-toggle:hover { color: var(--color-text-primary); }
  .rotate-180 { transform: rotate(180deg); }
  .advanced-panel { padding-top: .8rem; border-top: 1px solid var(--color-border); }
  .background-controls { padding: 1rem; grid-template-columns: 1fr 1fr 1.2fr; align-items: center; }
  .brightness-control { min-width: 0; }
  .brightness-heading { display: flex; align-items: center; justify-content: flex-end; gap: .25rem; color: var(--color-text-muted); font-size: 11px; }
  .brightness-heading > span:first-child { margin-right: auto; color: var(--color-text-primary); font-weight: 500; }
  .brightness-input { width: 3.5rem; border: 1px solid var(--color-border); border-radius: 5px; background: var(--color-surface-1); padding: .25rem .35rem; color: var(--color-accent); font: inherit; text-align: right; outline: none; }
  .brightness-input:focus { border-color: var(--color-accent); }
  .copy-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .7rem; margin-top: 1rem; max-width: 720px; }
  .home-settings :is(button, input, textarea):focus-visible, .quiet-button:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 3px; }
  @media (max-width: 700px) { .preview-toolbar, .section-heading, .section-actions, .editor-footer { align-items: flex-start; flex-direction: column; } .preview-canvas { min-height: 0; } .preview-cards, .preset-layout, .editor-grid, .advanced-panel, .background-controls, .copy-fields { grid-template-columns: 1fr; } .card-editor { border-left: 0; border-top: 1px solid var(--color-border); padding-top: 1rem; padding-left: 0; } .icon-editor .small-button { margin-left: 0; } }
</style>
