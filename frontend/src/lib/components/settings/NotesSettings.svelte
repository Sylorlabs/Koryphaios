<script lang="ts">
  // Notes section of Settings, extracted from SettingsDrawer.svelte without
  // behavior changes. The drawer keeps the pane wrapper (tab visibility and
  // the notes-settings container) and passes its close-then-navigate handler.
  import {
    NOTE_TOOL_DEFINITIONS,
    type NotePermissionLevel,
    type NotesPermissionPreset,
  } from '@koryphaios/shared';
  import ChevronDown from 'lucide-svelte/icons/chevron-down';
  import ArrowUpRight from 'lucide-svelte/icons/arrow-up-right';
  import { notesStore } from '$lib/stores/notes.svelte';
  import KorySelect from '../KorySelect.svelte';
  import NumberStepper from '../NumberStepper.svelte';
  import KorySlider from '../KorySlider.svelte';
  import SettingsSwitch from '../SettingsSwitch.svelte';
  import KnowledgeScope from '../KnowledgeScope.svelte';
  import SegmentedChoice from '../agent-settings/SegmentedChoice.svelte';
  import SettingsPage from './SettingsPage.svelte';

  let { onNavigate }: {
    /** Close Settings (respecting unsaved-edit guards), then run `action`. */
    onNavigate: (action: () => void) => void;
  } = $props();

  const notePermissionLevelOptions = [
    { value: 'auto', label: 'Auto', description: 'Runs without asking' },
    { value: 'ask', label: 'Ask', description: 'Needs your approval' },
    { value: 'block', label: 'Block', description: 'Hidden from agents' },
  ];

  const notePermissionPresetOptions = $derived.by(() => {
    const options: { value: string; label: string; description: string; disabled?: boolean }[] = [
      {
        value: 'default',
        label: 'Recommended',
        description: 'Reads run freely; writes ask first',
      },
      {
        value: 'allow_all',
        label: 'Allow all',
        description: 'Every note tool runs without approval',
      },
      {
        value: 'ask_all',
        label: 'Ask first',
        description: 'Every note tool needs your approval',
      },
      {
        value: 'block_all',
        label: 'Block all',
        description: 'Agents cannot use note tools',
      },
    ];
    if (notesStore.agentPermissions.preset === 'custom') {
      options.push({
        value: 'custom',
        label: 'Custom',
        description: 'Your mixed per-tool policy',
        disabled: true,
      });
    }
    return options;
  });

  const notePermissionGroups = $derived.by(() =>
    (['read', 'write'] as const)
      .map((category) => ({
        title: category === 'read' ? 'Read tools' : 'Write tools',
        tools: NOTE_TOOL_DEFINITIONS.filter((tool) => tool.category === category),
      }))
      .filter((group) => group.tools.length > 0),
  );
</script>

<SettingsPage
  width="narrow"
  title="Notes"
  description="Your project’s documents, research, and saved findings."
>
  {#snippet meta()}
    <KnowledgeScope
      compact
      scope="Project"
      showProjectName
      description="Notes belong to the selected project folder. Subfolders organize its collection. Markdown and HTML files can appear as live documents. Pinning changes list order; inclusion in agent context is a separate choice."
    />
  {/snippet}
  {#snippet actions()}
    <button
      type="button"
      class="notes-open-action"
      disabled={!notesStore.settings.enabled}
      onclick={() =>
        onNavigate(() => {
          window.dispatchEvent(new CustomEvent('open-project-notes'));
        })}>Open project notes<ArrowUpRight size={15} /></button
    >
  {/snippet}

  <section class="notes-section" aria-labelledby="notes-collection-title">
    <div class="notes-section-heading">
      <h4 id="notes-collection-title">Collection</h4>
      <p>Where your notes live and how new notes are organized.</p>
    </div>

    <div class="notes-setting-row">
      <div>
        <span class="notes-row-label">Enable Notes</span>
        <p>Make project notes available in your workspace.</p>
      </div>
      <SettingsSwitch
        checked={notesStore.settings.enabled}
        label="Enable Notes"
        description=""
        onchange={() =>
          void notesStore.updateSettings({ enabled: !notesStore.settings.enabled })}
        minimal
        flat
        quiet
      />
    </div>
    <div class="notes-setting-row">
      <div>
        <label for="notes-default-folder">Default folder</label>
        <p>New notes start here, inside this project’s collection.</p>
      </div>
      <input
        id="notes-default-folder"
        type="text"
        placeholder="/"
        class="notes-folder-input"
        value={notesStore.settings.defaultFolderPath}
        onchange={(e) =>
          notesStore.updateSettings({ defaultFolderPath: e.currentTarget.value || '/' })}
      />
    </div>
  </section>

  <section class="notes-section" aria-labelledby="notes-indexing-title">
    <div class="notes-section-heading">
      <h4 id="notes-indexing-title">Project indexing</h4>
      <p>How far one pass indexes a large repository.</p>
    </div>
    <div class="notes-setting-row">
      <div>
        <span class="notes-row-label">Soft index limit</span>
        <p>
          {(notesStore.settings.indexScanLimitEnabled ?? true)
            ? `Stop after ${(notesStore.settings.indexScanLimit ?? 50000).toLocaleString()} documents and offer to continue.`
            : 'No soft limit: each pass indexes the whole project.'}
        </p>
      </div>
      <div class="notes-row-controls">
        {#if notesStore.settings.indexScanLimitEnabled ?? true}
          <div class="notes-budget-control">
            <NumberStepper
              compact
              quiet
              value={notesStore.settings.indexScanLimit ?? 50000}
              min={1000}
              max={1000000}
              step={1000}
              label="Soft project index limit"
              onchange={(value) => notesStore.updateSettings({ indexScanLimit: value })}
            />
          </div>
        {/if}
        <SettingsSwitch
          checked={notesStore.settings.indexScanLimitEnabled ?? true}
          label="Soft index limit"
          description=""
          onchange={() =>
            void notesStore.updateSettings({
              indexScanLimitEnabled: !(notesStore.settings.indexScanLimitEnabled ?? true),
            })}
          minimal
          flat
          quiet
        />
      </div>
    </div>
    <div class="notes-setting-row">
      <div>
        <span class="notes-row-label">Limit notice</span>
        <p>Hide the notice shown when a pass reaches the soft limit.</p>
      </div>
      <SettingsSwitch
        checked={notesStore.settings.hideIndexLimitNotice ?? false}
        label="Hide index limit notice"
        description=""
        onchange={() =>
          void notesStore.updateSettings({
            hideIndexLimitNotice: !(notesStore.settings.hideIndexLimitNotice ?? false),
          })}
        minimal
        flat
        quiet
      />
    </div>
  </section>

  <section class="notes-section" aria-labelledby="notes-context-title">
    <div class="notes-section-heading">
      <h4 id="notes-context-title">Agent context</h4>
      <p>Choose what agents can draw on during a conversation.</p>
    </div>
    <div class="notes-setting-row">
      <div>
        <span class="notes-row-label">Include selected notes</span>
        <p>Only notes marked In context. Pinning does not include a note.</p>
      </div>
      <SettingsSwitch
        checked={notesStore.settings.autoIncludeInContext}
        label="Include selected notes in agent context"
        description=""
        onchange={() =>
          void notesStore.updateSettings({
            autoIncludeInContext: !notesStore.settings.autoIncludeInContext,
          })}
        minimal
        flat
        quiet
      />
    </div>
    <div class="notes-setting-row">
      <div>
        <span class="notes-row-label">Context budget</span>
        <p>
          {(notesStore.settings.maxContextTokensEnabled ?? true)
            ? 'Maximum tokens from explicitly selected notes.'
            : 'No token cap — selected notes are included in full.'}
        </p>
      </div>
      <div class="notes-row-controls">
        {#if notesStore.settings.maxContextTokensEnabled ?? true}
          <div class="notes-budget-control">
            <NumberStepper
              compact
              quiet
              value={notesStore.settings.maxContextTokens}
              min={100}
              max={100000}
              step={100}
              label="Maximum note context tokens"
              onchange={(value) => notesStore.updateSettings({ maxContextTokens: value })}
            />
          </div>
        {/if}
        <SettingsSwitch
          checked={notesStore.settings.maxContextTokensEnabled ?? true}
          label="Max context tokens"
          description=""
          onchange={() =>
            void notesStore.updateSettings({
              maxContextTokensEnabled: !(
                notesStore.settings.maxContextTokensEnabled ?? true
              ),
            })}
          minimal
          flat
          quiet
        />
      </div>
    </div>
    <div class="notes-setting-row">
      <div>
        <span class="notes-row-label">Note tool preset</span>
        <p>Baseline approval for every note tool. Tune individual tools below.</p>
      </div>
      <div class="notes-profile-control">
        <KorySelect
          compact
          value={notesStore.agentPermissions.preset}
          options={notePermissionPresetOptions}
          label="Note tool permission preset"
          disabled={!notesStore.agentPermissionsLoaded ||
            notesStore.agentPermissionsSaving}
          onchange={(value) => {
            if (value !== 'custom') {
              void notesStore.applyAgentPermissionPreset(
                value as Exclude<NotesPermissionPreset, 'custom'>,
              );
            }
          }}
        />
      </div>
    </div>
    <details class="notes-disclosure">
      <summary
        ><div>
          <h4>Per-tool permissions</h4>
          <p>Approve, automate, or hide each note tool.</p>
        </div>
        <ChevronDown size={14} /></summary
      >
      <div class="notes-disclosure-body">
        {#if notesStore.agentPermissionsLoaded}
          {#each notePermissionGroups as group (group.title)}
            <h5 class="notes-permission-group">{group.title}</h5>
            {#each group.tools as tool (tool.name)}
              <div class="notes-permission-row">
                <span
                  class="notes-permission-label"
                  data-kory-tooltip={tool.description}>{tool.label}</span
                >
                <span class="notes-permission-controls">
                  <SegmentedChoice
                    label={`${tool.label} permission`}
                    value={notesStore.agentPermissions.tools[tool.name]}
                    options={notePermissionLevelOptions}
                    hideDescription
                    disabled={notesStore.agentPermissionsSaving}
                    onchange={(value) =>
                      void notesStore.setAgentToolPermission(
                        tool.name,
                        value as NotePermissionLevel,
                      )}
                  />
                </span>
              </div>
            {/each}
          {/each}
          <button
            type="button"
            class="notes-text-action"
            onclick={() => void notesStore.resetAgentPermissions()}
            >Reset to defaults</button
          >
        {:else}
          <p class="notes-permission-empty">
            Note tool permissions load with the selected project.
          </p>
        {/if}
      </div>
    </details>
  </section>

  <!-- Graph tuning is secondary to everyday Notes setup. -->
  <section class="notes-section" aria-labelledby="notes-graph-title">
    <details class="notes-disclosure">
      <summary
        ><div>
          <h4 id="notes-graph-title">Graph appearance</h4>
          <p>Adjust the spacing and motion of connected notes.</p>
        </div>
        <ChevronDown size={14} /></summary
      >
      <div class="notes-disclosure-body notes-graph-controls">
        <KorySlider
          id="notes-gravity"
          label="Gravity"
          value={notesStore.settings.graphPhysics.gravity}
          min={-500}
          max={0}
          step={10}
          valueText={`${notesStore.settings.graphPhysics.gravity} gravity strength`}
          onchange={(gravity) =>
            notesStore.updateSettings({
              graphPhysics: { ...notesStore.settings.graphPhysics, gravity },
            })}
        />
        <KorySlider
          id="notes-link-distance"
          label="Link distance"
          value={notesStore.settings.graphPhysics.linkDistance}
          min={50}
          max={300}
          step={10}
          valueText={`${notesStore.settings.graphPhysics.linkDistance} pixels`}
          onchange={(linkDistance) =>
            notesStore.updateSettings({
              graphPhysics: { ...notesStore.settings.graphPhysics, linkDistance },
            })}
        />
        <KorySlider
          id="notes-charge"
          label="Charge strength"
          value={notesStore.settings.graphPhysics.chargeStrength}
          min={-500}
          max={-50}
          step={10}
          valueText={`${notesStore.settings.graphPhysics.chargeStrength} charge strength`}
          onchange={(chargeStrength) =>
            notesStore.updateSettings({
              graphPhysics: { ...notesStore.settings.graphPhysics, chargeStrength },
            })}
        />
      </div>
    </details>
  </section>

  <footer class="notes-settings-footer">
    <button
      type="button"
      class="notes-text-action"
      onclick={() =>
        onNavigate(() =>
          window.dispatchEvent(new CustomEvent('open-notes-graph')),
        )}>Open graph<ArrowUpRight size={13} /></button
    >
    <button
      type="button"
      class="notes-text-action"
      onclick={() => void notesStore.importMemoryAsNotes()}
      >Import memory as reference notes</button
    >
  </footer>
</SettingsPage>

<style>
  .notes-open-action {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    flex-shrink: 0;
    min-height: 32px;
    padding: 0 12px;
    border-radius: 7px;
    background: var(--color-surface-3);
    color: var(--color-text-primary);
    font-size: 12px;
    font-weight: 500;
  }
  .notes-open-action:hover {
    background: var(--color-surface-4);
  }
  .notes-section {
    color: var(--color-text-primary);
  }
  .notes-section-heading {
    margin-bottom: 8px;
  }
  .notes-section h4 {
    font-size: 14px;
    font-weight: 600;
    color: var(--color-text-primary);
  }
  .notes-section-heading p,
  .notes-disclosure summary p {
    margin-top: 4px;
    font-size: 12px;
    line-height: 1.6;
    color: var(--color-text-muted);
  }
  .notes-section-heading-actions {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
  }
  .notes-setting-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 28px;
    min-height: 64px;
    padding: 10px 0;
  }
  .notes-setting-row > div:first-child {
    min-width: 0;
  }
  .notes-row-label,
  .notes-setting-row label {
    font-size: 13px;
    font-weight: 500;
  }
  .notes-setting-row p {
    margin-top: 5px;
    font-size: 12px;
    line-height: 1.65;
    color: var(--color-text-muted);
  }
  .notes-setting-row > :global(button[aria-checked]),
  .notes-row-controls :global(button[aria-checked]) {
    width: auto;
    flex-shrink: 0;
    padding: 6px 0;
  }
  .notes-row-controls {
    display: flex;
    align-items: center;
    gap: 16px;
    flex-shrink: 0;
  }
  .notes-budget-control {
    width: 178px;
  }
  .notes-folder-input {
    width: 240px;
    max-width: 45%;
    flex-shrink: 0;
    height: 36px;
    padding: 0 12px;
    border: 0;
    border-radius: 7px;
    background: var(--color-surface-2);
    font-size: 13px;
    color: var(--color-text-primary);
  }
  .notes-profile-control {
    width: 200px;
    flex-shrink: 0;
  }
  .notes-profile-control :global(button[aria-haspopup='listbox']) {
    border-color: transparent;
    border-radius: 7px;
    background: var(--color-surface-2);
  }
  .notes-permission-group {
    margin: 14px 0 2px;
    font-size: 12px;
    font-weight: 500;
    color: var(--color-text-muted);
  }
  .notes-permission-group:first-child {
    margin-top: 0;
  }
  .notes-permission-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 20px;
    min-height: 44px;
    padding: 4px 0;
  }
  .notes-permission-label {
    min-width: 0;
    font-size: 12.5px;
    font-weight: 500;
    color: var(--color-text-primary);
    cursor: help;
  }
  .notes-permission-controls {
    flex-shrink: 0;
  }
  .notes-permission-empty {
    margin: 0;
    font-size: 12px;
    line-height: 1.6;
    color: var(--color-text-muted);
  }
  .notes-text-action {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 30px;
    border-radius: 5px;
    font-size: 12px;
    color: var(--color-text-muted);
  }
  .notes-text-action:hover {
    color: var(--color-text-primary);
  }
  .notes-disclosure summary {
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 40px;
    cursor: pointer;
    list-style: none;
    border-radius: 5px;
  }
  .notes-disclosure summary::-webkit-details-marker {
    display: none;
  }
  .notes-disclosure summary > :global(svg:last-child) {
    margin-left: auto;
    flex-shrink: 0;
    color: var(--color-text-muted);
  }
  .notes-disclosure[open] summary > :global(svg:last-child) {
    transform: rotate(180deg);
  }
  .notes-disclosure-meta {
    margin-left: auto;
    font-size: 11px;
    color: var(--color-text-muted);
  }
  .notes-disclosure-body {
    padding: 16px 0 4px;
  }
  .notes-graph-controls {
    display: grid;
    gap: 20px;
    max-width: 560px;
    padding-top: 24px;
  }
  .notes-settings-footer {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 24px;
  }
  :global(.notes-settings-scroll) button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .notes-open-action:focus-visible,
  .notes-text-action:focus-visible,
  .notes-disclosure summary:focus-visible,
  .notes-folder-input:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 3px;
  }
  @container notes-settings (max-width: 600px) {
    .notes-setting-row {
      gap: 16px;
    }
    .notes-row-controls {
      gap: 12px;
    }
    .notes-budget-control {
      width: 150px;
    }
  }
  @container notes-settings (max-width: 420px) {
    .notes-setting-row:has(.notes-row-controls),
    .notes-setting-row:has(.notes-folder-input) {
      align-items: flex-start;
      flex-direction: column;
      gap: 12px;
    }
    .notes-row-controls {
      align-self: flex-end;
    }
    .notes-folder-input {
      width: 100%;
      max-width: none;
    }
    .notes-profile-control {
      width: 100%;
    }
    .notes-section-heading-actions {
      flex-wrap: wrap;
      gap: 6px;
    }
    .notes-permission-row {
      align-items: flex-start;
      flex-direction: column;
      gap: 10px;
    }
    .notes-permission-controls {
      align-self: flex-end;
    }
    .notes-disclosure-meta {
      display: none;
    }
  }
</style>
