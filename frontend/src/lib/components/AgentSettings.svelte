<script lang="ts">
  import { agentSettingsStore, DEFAULT_AGENT_SETTINGS } from "$lib/stores/agent-settings.svelte";
  import { 
    Bot, 
    Shield, 
    FileText, 
    Settings,
    AlertTriangle,
    CheckCircle,
    XCircle,
    Save,
    RotateCcw,
    Plus,
    Gavel,
    Eye,
    EyeOff,
    AlertOctagon,
    FlaskConical,
    Globe,
    Layers
  } from "lucide-svelte";

  // Props
  interface Props {
    onClose?: () => void;
  }

  let { onClose }: Props = $props();

  // Local state for preferences editing
  let preferencesContent = $state(agentSettingsStore.preferences?.content ?? "");
  let preferencesDirty = $state(false);

  // Sync preferences content
  $effect(() => {
    if (agentSettingsStore.preferences && !preferencesDirty) {
      preferencesContent = agentSettingsStore.preferences.content;
    }
  });

  // Tab configuration - uses semantic theme colors
  const tabs = [
    { id: "settings" as const, label: "Agent Settings", icon: Bot, color: "var(--color-info)" },
    { id: "preferences" as const, label: "Preferences.md", icon: FileText, color: "var(--color-success)" },
    { id: "enforcement" as const, label: "Rule Enforcement", icon: Gavel, color: "var(--color-error)" },
  ];

  // Handler helpers
  async function toggleSetting(key: keyof typeof DEFAULT_AGENT_SETTINGS) {
    const current = agentSettingsStore.settings[key];
    await agentSettingsStore.saveSettings({ [key]: !current });
  }

  async function handleSavePreferences() {
    if (await agentSettingsStore.savePreferences(preferencesContent)) {
      preferencesDirty = false;
    }
  }

  function handlePreferencesChange(value: string) {
    preferencesContent = value;
    preferencesDirty = true;
  }

  async function handleResetPreferences() {
    preferencesContent = agentSettingsStore.preferences?.content ?? "";
    preferencesDirty = false;
  }

  // Enforcement level options - uses semantic theme colors
  const enforcementLevels = [
    { 
      value: "strict", 
      label: "Strict", 
      description: "Critic blocks ANY rule violation",
      icon: AlertOctagon,
      color: "var(--color-error)",
      bgColor: "var(--color-error-bg, rgba(239, 68, 68, 0.1))"
    },
    { 
      value: "moderate", 
      label: "Moderate", 
      description: "Critic blocks critical violations, warns on others",
      icon: AlertTriangle,
      color: "var(--color-warning)",
      bgColor: "var(--color-warning-bg, rgba(245, 158, 11, 0.1))"
    },
    { 
      value: "lenient", 
      label: "Lenient", 
      description: "Critic only blocks critical violations",
      icon: Eye,
      color: "var(--color-info, #3b82f6)",
      bgColor: "var(--color-info-bg, rgba(59, 130, 246, 0.1))"
    },
  ] as const;
</script>

<div class="flex h-full min-h-0 min-w-0 flex-col">
  <!-- Header -->
  <div class="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b border-[var(--color-border)]">
    <div class="flex flex-wrap items-center gap-2">
      <Bot size={18} style="color: var(--color-info);" />
      <h3 class="text-sm font-semibold text-[var(--color-text-primary)]">Agent Configuration</h3>
    </div>
    <div class="flex flex-wrap items-center gap-2">
      <!-- Always Enforced Badge -->
      <span class="flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-full" style="background: var(--color-error-bg); color: var(--color-error);">
        <Shield size={12} />
        Rules Always Enforced
      </span>
      {#if onClose}
        <button
          onclick={onClose}
          aria-label="Close"
          class="p-1.5 rounded-lg hover:bg-[var(--color-surface-3)] text-[var(--color-text-muted)]"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
        </button>
      {/if}
    </div>
  </div>

  <!-- Tabs -->
  <div class="flex shrink-0 overflow-x-auto border-b border-[var(--color-border)]">
    {#each tabs as tab}
      <button
        onclick={() => agentSettingsStore.setActiveTab(tab.id)}
        class="shrink-0 whitespace-nowrap flex items-center gap-1.5 px-3 py-2 text-xs font-medium transition-colors border-b-2
          {agentSettingsStore.activeTab === tab.id 
            ? 'border-[var(--color-accent)] bg-[var(--color-surface-2)]' 
            : 'border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-1)]'}"
        style={agentSettingsStore.activeTab === tab.id ? `color: ${tab.color};` : ''}
      >
        <tab.icon size={14} />
        {tab.label}
      </button>
    {/each}
  </div>

  <!-- Content -->
  <div class="flex-1 min-h-0 overflow-hidden">
    {#if agentSettingsStore.isLoading}
      <div class="flex items-center justify-center h-full">
        <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-[var(--color-accent)]"></div>
      </div>

    {:else if agentSettingsStore.activeTab === "settings"}
      <div class="h-full min-h-0 overflow-y-auto p-6">
        <div class="grid gap-6 xl:grid-cols-[minmax(0,1.15fr)_minmax(320px,0.85fr)]">
          <div class="space-y-6">
            <section class="space-y-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-1)] p-5">
              <div class="space-y-1">
                <h4 class="flex items-center gap-2 text-sm font-semibold text-[var(--color-text-primary)]">
                  <Gavel size={16} style="color: var(--color-error);" />
                  Rule Enforcement Level
                </h4>
                <p class="text-xs text-[var(--color-text-muted)]">
                  How strictly the Critic enforces rules. Rules are always applied.
                </p>
              </div>

              <div class="grid gap-3 lg:grid-cols-3">
                {#each enforcementLevels as level}
                  <button
                    onclick={() => agentSettingsStore.saveSettings({ ruleEnforcementLevel: level.value })}
                    class="flex h-full flex-col gap-3 rounded-xl border p-4 text-left transition-all
                      {agentSettingsStore.settings.ruleEnforcementLevel === level.value
                        ? 'border-[var(--color-accent)] shadow-sm'
                        : 'border-[var(--color-border)] bg-[var(--color-surface-2)] hover:bg-[var(--color-surface-3)]'}"
                    style={agentSettingsStore.settings.ruleEnforcementLevel === level.value ? `background: ${level.bgColor};` : ''}
                  >
                    <div class="flex items-center justify-between gap-3">
                      <div class="flex items-center gap-2">
                        <div class="rounded-lg p-2" style={`background: color-mix(in srgb, ${level.color} 14%, transparent); color: ${level.color};`}>
                          <level.icon size={18} />
                        </div>
                        <span class="text-sm font-medium text-[var(--color-text-primary)]">{level.label}</span>
                      </div>
                      {#if agentSettingsStore.settings.ruleEnforcementLevel === level.value}
                        <CheckCircle size={16} style="color: var(--color-success);" />
                      {/if}
                    </div>
                    <p class="text-xs text-[var(--color-text-muted)]">{level.description}</p>
                  </button>
                {/each}
              </div>
            </section>

            <section class="space-y-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-1)] p-5">
              <div class="space-y-1">
                <h4 class="flex items-center gap-2 text-sm font-semibold text-[var(--color-text-primary)]">
                  <Shield size={16} class="text-purple-400" />
                  Critic Workflow
                </h4>
                <p class="text-xs text-[var(--color-text-muted)]">
                  Review behavior and auto-apply controls for the Critic.
                </p>
              </div>

              <div class="grid gap-3 sm:grid-cols-2">
                <label class="flex h-full cursor-pointer items-start justify-between gap-4 rounded-xl bg-[var(--color-surface-2)] p-4 hover:bg-[var(--color-surface-3)]">
                  <div>
                    <div class="text-sm font-medium text-[var(--color-text-primary)]">Enable Critic Gate</div>
                    <div class="mt-1 text-xs text-[var(--color-text-muted)]">Critic reviews all changes before application.</div>
                  </div>
                  <input
                    type="checkbox"
                    checked={agentSettingsStore.settings.criticGateEnabled}
                    onchange={() => toggleSetting("criticGateEnabled")}
                    class="mt-1 h-4 w-4 rounded border-[var(--color-border)] bg-[var(--color-surface-0)] text-[var(--color-accent)] focus:ring-[var(--color-accent)]"
                  />
                </label>

                <label class="flex h-full cursor-pointer items-start justify-between gap-4 rounded-xl bg-[var(--color-surface-2)] p-4 hover:bg-[var(--color-surface-3)]">
                  <div>
                    <div class="text-sm font-medium text-[var(--color-text-primary)]">Critic Enforces Preferences</div>
                    <div class="mt-1 text-xs text-[var(--color-text-muted)]">Apply `preferences.md` as a hard workflow contract.</div>
                  </div>
                  <input
                    type="checkbox"
                    checked={agentSettingsStore.settings.criticEnforcesPreferences}
                    onchange={() => toggleSetting("criticEnforcesPreferences")}
                    class="mt-1 h-4 w-4 rounded border-[var(--color-border)] bg-[var(--color-surface-0)] text-[var(--color-accent)] focus:ring-[var(--color-accent)]"
                  />
                </label>

                <label class="flex h-full cursor-pointer items-start justify-between gap-4 rounded-xl bg-[var(--color-surface-2)] p-4 hover:bg-[var(--color-surface-3)]">
                  <div>
                    <div class="text-sm font-medium text-[var(--color-text-primary)]">Auto-Apply Safe Fixes</div>
                    <div class="mt-1 text-xs text-[var(--color-text-muted)]">Apply low-risk changes without manual confirmation.</div>
                  </div>
                  <input
                    type="checkbox"
                    checked={agentSettingsStore.settings.autoApplySafeFixes}
                    onchange={() => toggleSetting("autoApplySafeFixes")}
                    class="mt-1 h-4 w-4 rounded border-[var(--color-border)] bg-[var(--color-surface-0)] text-[var(--color-accent)] focus:ring-[var(--color-accent)]"
                  />
                </label>

                <label class="flex h-full cursor-pointer items-start justify-between gap-4 rounded-xl bg-[var(--color-surface-2)] p-4 hover:bg-[var(--color-surface-3)]">
                  <div>
                    <div class="text-sm font-medium text-[var(--color-text-primary)]">Confirm Rule Violations</div>
                    <div class="mt-1 text-xs text-[var(--color-text-muted)]">Require human approval before applying risky overrides.</div>
                  </div>
                  <input
                    type="checkbox"
                    checked={agentSettingsStore.settings.confirmRuleViolations}
                    onchange={() => toggleSetting("confirmRuleViolations")}
                    class="mt-1 h-4 w-4 rounded border-[var(--color-border)] bg-[var(--color-surface-0)] text-[var(--color-accent)] focus:ring-[var(--color-accent)]"
                  />
                </label>
              </div>
            </section>

            <section class="space-y-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-1)] p-5">
              <div class="space-y-1">
                <h4 class="text-sm font-semibold text-[var(--color-text-primary)]">Approval Thresholds</h4>
                <p class="text-xs text-[var(--color-text-muted)]">
                  Escalate larger edits before the agent applies them.
                </p>
              </div>

              <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div class="rounded-xl bg-[var(--color-surface-2)] p-4">
                  <label for="max-files" class="mb-2 block text-xs text-[var(--color-text-muted)]">Max Files Changed</label>
                  <input
                    id="max-files"
                    type="number"
                    min="1"
                    max="50"
                    value={agentSettingsStore.settings.approvalThresholdFiles}
                    onchange={(e) => agentSettingsStore.saveSettings({ approvalThresholdFiles: parseInt(e.currentTarget.value) })}
                    class="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-0)] px-3 py-2 text-sm text-[var(--color-text-primary)]"
                  />
                  <p class="mt-2 text-[10px] text-[var(--color-text-muted)]">
                    Require approval if more than this many files change.
                  </p>
                </div>

                <div class="rounded-xl bg-[var(--color-surface-2)] p-4">
                  <label for="max-lines" class="mb-2 block text-xs text-[var(--color-text-muted)]">Max Lines Changed</label>
                  <input
                    id="max-lines"
                    type="number"
                    min="10"
                    max="1000"
                    step="10"
                    value={agentSettingsStore.settings.approvalThresholdLines}
                    onchange={(e) => agentSettingsStore.saveSettings({ approvalThresholdLines: parseInt(e.currentTarget.value) })}
                    class="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-0)] px-3 py-2 text-sm text-[var(--color-text-primary)]"
                  />
                  <p class="mt-2 text-[10px] text-[var(--color-text-muted)]">
                    Require approval if more than this many lines change.
                  </p>
                </div>
              </div>
            </section>
          </div>

          <div class="space-y-6">
            <section class="space-y-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-1)] p-5">
              <div class="space-y-1">
                <h4 class="text-sm font-semibold text-[var(--color-text-primary)]">Agent Memory</h4>
                <p class="text-xs text-[var(--color-text-muted)]">
                  Control whether the agent can persist what it learns.
                </p>
              </div>

              <div class="space-y-3">
                <label class="flex cursor-pointer items-start justify-between gap-4 rounded-xl bg-[var(--color-surface-2)] p-4 hover:bg-[var(--color-surface-3)]">
                  <div>
                    <div class="text-sm font-medium text-[var(--color-text-primary)]">Agent Can Update Memory</div>
                    <div class="mt-1 text-xs text-[var(--color-text-muted)]">Allow agents to update memory files.</div>
                  </div>
                  <input
                    type="checkbox"
                    checked={agentSettingsStore.settings.agentMemoryEnabled}
                    onchange={() => toggleSetting("agentMemoryEnabled")}
                    class="mt-1 h-4 w-4 rounded border-[var(--color-border)] bg-[var(--color-surface-0)] text-[var(--color-accent)] focus:ring-[var(--color-accent)]"
                  />
                </label>

                <label class="flex cursor-pointer items-start justify-between gap-4 rounded-xl bg-[var(--color-surface-2)] p-4 hover:bg-[var(--color-surface-3)]">
                  <div>
                    <div class="text-sm font-medium text-[var(--color-text-primary)]">Agent Can Update Preferences</div>
                    <div class="mt-1 text-xs text-[var(--color-text-muted)]">Allow updates to `preferences.md` based on learned patterns.</div>
                  </div>
                  <input
                    type="checkbox"
                    checked={agentSettingsStore.settings.agentCanUpdatePreferences}
                    onchange={() => toggleSetting("agentCanUpdatePreferences")}
                    class="mt-1 h-4 w-4 rounded border-[var(--color-border)] bg-[var(--color-surface-0)] text-[var(--color-accent)] focus:ring-[var(--color-accent)]"
                  />
                </label>
              </div>
            </section>

            <section class="space-y-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-1)] p-5">
              <div class="flex items-center gap-2 text-[var(--color-warning)]">
                <FlaskConical size={16} />
                <h4 class="text-sm font-semibold">Experimental Research</h4>
              </div>

              <div class="space-y-3">
                <div class="rounded-xl bg-[var(--color-surface-2)] p-4">
                  <div class="flex items-start justify-between gap-4">
                    <div class="flex items-center gap-2">
                      <Globe size={14} class="mt-0.5 text-[var(--color-text-muted)]" />
                      <div>
                        <div class="text-sm font-medium text-[var(--color-text-primary)]">Local Web Search</div>
                        <div class="mt-1 text-[10px] text-[var(--color-text-muted)]">Use DuckDuckGo fallback for web search.</div>
                      </div>
                    </div>
                    <select
                      value={agentSettingsStore.settings.localWebSearch}
                      onchange={(e) => agentSettingsStore.saveSettings({ localWebSearch: e.currentTarget.value as any })}
                      class="rounded border border-[var(--color-border)] bg-[var(--color-surface-0)] px-2 py-1 text-xs text-[var(--color-text-primary)]"
                    >
                      <option value="off">Off</option>
                      <option value="on">Always On</option>
                      <option value="fallback">Fallback</option>
                    </select>
                  </div>
                </div>

                <label class="flex cursor-pointer items-start justify-between gap-4 rounded-xl bg-[var(--color-surface-2)] p-4 hover:bg-[var(--color-surface-3)]">
                  <div class="flex items-center gap-2">
                    <Layers size={14} class="mt-0.5 text-[var(--color-text-muted)]" />
                    <div>
                      <div class="text-sm font-medium text-[var(--color-text-primary)]">Multi-Source Research</div>
                      <div class="mt-1 text-[10px] text-[var(--color-text-muted)]">Force the agent to verify against 3-5 sources.</div>
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    checked={agentSettingsStore.settings.multiSourceResearch}
                    onchange={() => toggleSetting("multiSourceResearch")}
                    class="mt-1 h-4 w-4 rounded border-[var(--color-border)] bg-[var(--color-surface-0)] text-[var(--color-accent)] focus:ring-[var(--color-accent)]"
                  />
                </label>
              </div>
            </section>

            <section class="space-y-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-1)] p-5">
              <h4 class="text-sm font-semibold text-[var(--color-text-primary)]">Current Mode</h4>
              <div class="grid gap-3 sm:grid-cols-3 xl:grid-cols-1">
                <div class="rounded-xl bg-[var(--color-surface-2)] p-4">
                  <div class="text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">Enforcement</div>
                  <div class="mt-2 text-sm font-semibold text-[var(--color-text-primary)] capitalize">
                    {agentSettingsStore.settings.ruleEnforcementLevel}
                  </div>
                </div>
                <div class="rounded-xl bg-[var(--color-surface-2)] p-4">
                  <div class="text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">Critic Gate</div>
                  <div class="mt-2 text-sm font-semibold text-[var(--color-text-primary)]">
                    {agentSettingsStore.settings.criticGateEnabled ? 'Enabled' : 'Disabled'}
                  </div>
                </div>
                <div class="rounded-xl bg-[var(--color-surface-2)] p-4">
                  <div class="text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">Auto-Apply</div>
                  <div class="mt-2 text-sm font-semibold text-[var(--color-text-primary)]">
                    {agentSettingsStore.settings.autoApplySafeFixes ? 'Safe fixes only' : 'Manual'}
                  </div>
                </div>
              </div>
            </section>

            <section class="rounded-2xl border border-red-500/20 bg-red-500/5 p-5">
              <button
                onclick={() => agentSettingsStore.resetSettings()}
                class="flex items-center gap-2 rounded-lg px-4 py-2 text-sm text-red-400 transition-colors hover:bg-red-500/10"
              >
                <RotateCcw size={16} />
                Reset to Defaults
              </button>
            </section>
          </div>
        </div>
      </div>

    {:else if agentSettingsStore.activeTab === "preferences"}
      {@const prefs = agentSettingsStore.preferences}
      <div class="flex h-full min-h-0 flex-col">
        <!-- Preferences Header -->
        <div class="px-4 py-2 bg-[var(--color-surface-2)] border-b border-[var(--color-border)]">
          <div class="flex items-center justify-between">
            <div class="flex-1 min-w-0">
              {#if !prefs?.exists}
                <div class="flex items-center gap-2 text-xs text-yellow-500">
                  <AlertTriangle size={14} />
                  <span>Preferences not initialized</span>
                </div>
              {:else}
                <div class="flex items-center gap-4 text-xs text-gray-400">
                  <span class="flex items-center gap-1">
                    <CheckCircle size={12} style="color: var(--color-success);" />
                    Active
                  </span>
                  <span class="truncate max-w-[400px]" title={prefs.path}>
                    {prefs.path}
                  </span>
                </div>
              {/if}
            </div>
            <div class="flex items-center gap-2 ml-4">
              {#if !prefs?.exists}
                <button
                  onclick={() => agentSettingsStore.initializePreferences()}
                  class="flex items-center gap-1 px-2 py-1 text-xs bg-green-500/20 text-green-400 rounded hover:bg-green-500/30"
                >
                  <Plus size={12} />
                  Initialize
                </button>
              {:else}
                <button
                  onclick={handleResetPreferences}
                  disabled={!preferencesDirty}
                  class="flex items-center gap-1 px-2 py-1 text-xs rounded disabled:opacity-50
                    {preferencesDirty ? 'bg-yellow-500/20 text-yellow-400 hover:bg-yellow-500/30' : 'bg-[var(--color-surface-3)] text-[var(--color-text-muted)]'}"
                >
                  <RotateCcw size={12} />
                  Reset
                </button>
                <button
                  onclick={handleSavePreferences}
                  disabled={!preferencesDirty}
                  class="flex items-center gap-1 px-2 py-1 text-xs bg-green-500/20 text-green-400 rounded hover:bg-green-500/30 disabled:opacity-50"
                >
                  <Save size={12} />
                  Save
                </button>
              {/if}
            </div>
          </div>
        </div>

        <!-- Preferences Editor -->
        {#if !prefs?.exists}
          <div class="flex-1 flex items-center justify-center text-[var(--color-text-muted)]">
            <div class="text-center">
              <FileText size={48} class="mx-auto mb-4 opacity-50" />
              <p class="text-sm">No preferences file</p>
              <p class="text-xs mt-1 opacity-70">Initialize to define workflow rules</p>
            </div>
          </div>
        {:else}
          <textarea
            bind:value={preferencesContent}
            oninput={(e) => handlePreferencesChange(e.currentTarget.value)}
            placeholder="Define your workflow preferences and rules..."
            class="min-h-0 flex-1 w-full p-4 text-sm font-mono bg-[var(--color-surface-0)] text-[var(--color-text-primary)] resize-none focus:outline-none"
            spellcheck="false"
          ></textarea>
        {/if}
      </div>

    {:else if agentSettingsStore.activeTab === "enforcement"}
      <div class="h-full min-h-0 overflow-y-auto p-6">
        <div class="grid gap-6 xl:grid-cols-[minmax(0,1.05fr)_minmax(340px,0.95fr)]">
          <div class="space-y-6">
            <div class="rounded-2xl p-5" style="background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.2);">
              <div class="flex items-start gap-3">
                <AlertOctagon size={20} class="mt-0.5 text-red-400" />
                <div>
                  <h4 class="text-sm font-semibold text-red-400">Rules Are Always Enforced</h4>
                  <p class="mt-1 text-xs text-[var(--color-text-muted)]">
                    There is no option to disable rule enforcement. The Critic will always check code against `.koryrules` and `preferences.md`.
                    The enforcement level only changes how strictly violations are treated.
                  </p>
                </div>
              </div>
            </div>

            <section class="space-y-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-1)] p-5">
              <h4 class="text-sm font-semibold text-[var(--color-text-primary)]">Current Enforcement</h4>

              <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
                <div class="flex items-center justify-between rounded-xl bg-[var(--color-surface-2)] p-4">
                  <div class="flex items-center gap-3">
                    <Shield size={18} style="color: var(--color-success);" />
                    <div>
                      <div class="text-sm font-medium text-[var(--color-text-primary)]">.koryrules</div>
                      <div class="text-xs text-[var(--color-text-muted)]">Always enforced on all code</div>
                    </div>
                  </div>
                  <CheckCircle size={18} style="color: var(--color-success);" />
                </div>

                <div class="flex items-center justify-between rounded-xl bg-[var(--color-surface-2)] p-4">
                  <div class="flex items-center gap-3">
                    <FileText size={18} style="color: var(--color-success);" />
                    <div>
                      <div class="text-sm font-medium text-[var(--color-text-primary)]">preferences.md</div>
                      <div class="text-xs text-[var(--color-text-muted)]">
                        {agentSettingsStore.settings.preferencesEnabled ? 'Enabled and enforced' : 'Disabled'}
                      </div>
                    </div>
                  </div>
                  {#if agentSettingsStore.settings.preferencesEnabled}
                    <CheckCircle size={18} style="color: var(--color-success);" />
                  {:else}
                    <EyeOff size={18} class="text-gray-400" />
                  {/if}
                </div>

                <div class="flex items-center justify-between rounded-xl bg-[var(--color-surface-2)] p-4">
                  <div class="flex items-center gap-3">
                    <Bot size={18} style="color: var(--color-success);" />
                    <div>
                      <div class="text-sm font-medium text-[var(--color-text-primary)]">Critic Gate</div>
                      <div class="text-xs text-[var(--color-text-muted)]">
                        {agentSettingsStore.settings.criticGateEnabled ? 'Active, reviewing all changes' : 'Disabled'}
                      </div>
                    </div>
                  </div>
                  {#if agentSettingsStore.settings.criticGateEnabled}
                    <CheckCircle size={18} style="color: var(--color-success);" />
                  {:else}
                    <EyeOff size={18} class="text-gray-400" />
                  {/if}
                </div>
              </div>
            </section>

            <section class="space-y-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-1)] p-5">
              <h4 class="text-sm font-semibold text-[var(--color-text-primary)]">What Critic Checks</h4>

              <div class="grid gap-3 sm:grid-cols-2">
                <div class="flex items-center gap-2 rounded-xl bg-[var(--color-surface-2)] p-3 text-xs text-[var(--color-text-muted)]">
                  <XCircle size={12} style="color: var(--color-error);" />
                  <span>Forbidden patterns like `eval`, production `console.log`, and secrets</span>
                </div>
                <div class="flex items-center gap-2 rounded-xl bg-[var(--color-surface-2)] p-3 text-xs text-[var(--color-text-muted)]">
                  <XCircle size={12} style="color: var(--color-error);" />
                  <span>Security vulnerabilities</span>
                </div>
                <div class="flex items-center gap-2 rounded-xl bg-[var(--color-surface-2)] p-3 text-xs text-[var(--color-text-muted)]">
                  <XCircle size={12} style="color: var(--color-error);" />
                  <span>Performance regressions</span>
                </div>
                <div class="flex items-center gap-2 rounded-xl bg-[var(--color-surface-2)] p-3 text-xs text-[var(--color-text-muted)]">
                  <AlertTriangle size={12} style="color: var(--color-warning);" />
                  <span>Missing error handling</span>
                </div>
                <div class="flex items-center gap-2 rounded-xl bg-[var(--color-surface-2)] p-3 text-xs text-[var(--color-text-muted)]">
                  <AlertTriangle size={12} style="color: var(--color-warning);" />
                  <span>Missing documentation</span>
                </div>
                <div class="flex items-center gap-2 rounded-xl bg-[var(--color-surface-2)] p-3 text-xs text-[var(--color-text-muted)]">
                  <AlertTriangle size={12} style="color: var(--color-warning);" />
                  <span>Workflow violations from `preferences.md`</span>
                </div>
              </div>
            </section>
          </div>

          <div class="space-y-6">
            <section class="space-y-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-1)] p-5">
              <h4 class="text-sm font-semibold text-[var(--color-text-primary)]">Enforcement Levels</h4>

              <div class="space-y-3 text-xs">
                <div class="rounded-xl p-4" style="background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.2);">
                  <div class="mb-2 flex items-center gap-2 font-medium text-red-400">
                    <AlertOctagon size={14} />
                    Strict
                  </div>
                  <p class="text-[var(--color-text-muted)]">
                    Critic blocks any rule violation. All violations must be fixed before changes can be applied.
                  </p>
                </div>

                <div class="rounded-xl p-4" style="background: rgba(245, 158, 11, 0.1); border: 1px solid rgba(245, 158, 11, 0.2);">
                  <div class="mb-2 flex items-center gap-2 font-medium text-yellow-400">
                    <AlertTriangle size={14} />
                    Moderate
                  </div>
                  <p class="text-[var(--color-text-muted)]">
                    Critic blocks critical violations and warns on others. Non-critical issues can be overridden with confirmation.
                  </p>
                </div>

                <div class="rounded-xl p-4" style="background: rgba(59, 130, 246, 0.1); border: 1px solid rgba(59, 130, 246, 0.2);">
                  <div class="mb-2 flex items-center gap-2 font-medium text-blue-400">
                    <Eye size={14} />
                    Lenient
                  </div>
                  <p class="text-[var(--color-text-muted)]">
                    Critic only blocks critical violations. All other issues stay warnings for faster iteration.
                  </p>
                </div>
              </div>
            </section>

            <section class="space-y-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-1)] p-5">
              <h4 class="text-sm font-semibold text-[var(--color-text-primary)]">Active Profile</h4>
              <div class="grid gap-3 sm:grid-cols-3 xl:grid-cols-1">
                <div class="rounded-xl bg-[var(--color-surface-2)] p-4">
                  <div class="text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">Mode</div>
                  <div class="mt-2 text-sm font-semibold capitalize text-[var(--color-text-primary)]">
                    {agentSettingsStore.settings.ruleEnforcementLevel}
                  </div>
                </div>
                <div class="rounded-xl bg-[var(--color-surface-2)] p-4">
                  <div class="text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">Preferences</div>
                  <div class="mt-2 text-sm font-semibold text-[var(--color-text-primary)]">
                    {agentSettingsStore.settings.preferencesEnabled ? 'Included' : 'Ignored'}
                  </div>
                </div>
                <div class="rounded-xl bg-[var(--color-surface-2)] p-4">
                  <div class="text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">Gate</div>
                  <div class="mt-2 text-sm font-semibold text-[var(--color-text-primary)]">
                    {agentSettingsStore.settings.criticGateEnabled ? 'Reviewing' : 'Off'}
                  </div>
                </div>
              </div>
            </section>
          </div>
        </div>
      </div>
    {/if}
  </div>
</div>
