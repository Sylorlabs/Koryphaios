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
    AlertOctagon
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

  // Tab configuration
  const tabs = [
    { id: "settings" as const, label: "Agent Settings", icon: Bot, color: "text-blue-400" },
    { id: "preferences" as const, label: "Preferences.md", icon: FileText, color: "text-green-400" },
    { id: "enforcement" as const, label: "Rule Enforcement", icon: Gavel, color: "text-red-400" },
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

  // Enforcement level options
  const enforcementLevels = [
    { 
      value: "strict", 
      label: "Strict", 
      description: "Critic blocks ANY rule violation",
      icon: AlertOctagon,
      color: "text-red-400",
      bgColor: "bg-red-500/20"
    },
    { 
      value: "moderate", 
      label: "Moderate", 
      description: "Critic blocks critical violations, warns on others",
      icon: AlertTriangle,
      color: "text-yellow-400",
      bgColor: "bg-yellow-500/20"
    },
    { 
      value: "lenient", 
      label: "Lenient", 
      description: "Critic only blocks critical violations",
      icon: Eye,
      color: "text-blue-400",
      bgColor: "bg-blue-500/20"
    },
  ] as const;
</script>

<div class="flex flex-col h-full">
  <!-- Header -->
  <div class="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border)]">
    <div class="flex items-center gap-2">
      <Bot size={18} class="text-blue-400" />
      <h3 class="text-sm font-semibold text-[var(--color-text-primary)]">Agent Configuration</h3>
    </div>
    <div class="flex items-center gap-2">
      <!-- Always Enforced Badge -->
      <span class="flex items-center gap-1 px-2 py-1 text-xs font-medium bg-red-500/20 text-red-400 rounded-full">
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
  <div class="flex border-b border-[var(--color-border)]">
    {#each tabs as tab}
      <button
        onclick={() => agentSettingsStore.setActiveTab(tab.id)}
        class="flex items-center gap-1.5 px-3 py-2 text-xs font-medium transition-colors border-b-2
          {agentSettingsStore.activeTab === tab.id 
            ? `border-[var(--color-accent)] ${tab.color} bg-[var(--color-surface-2)]` 
            : 'border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-1)]'}"
      >
        <tab.icon size={14} />
        {tab.label}
      </button>
    {/each}
  </div>

  <!-- Content -->
  <div class="flex-1 overflow-hidden">
    {#if agentSettingsStore.isLoading}
      <div class="flex items-center justify-center h-full">
        <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-[var(--color-accent)]"></div>
      </div>

    {:else if agentSettingsStore.activeTab === "settings"}
      <div class="h-full overflow-y-auto p-6 space-y-6">
        <!-- Rule Enforcement Level -->
        <div class="space-y-3">
          <h4 class="text-sm font-semibold text-[var(--color-text-primary)] flex items-center gap-2">
            <Gavel size={16} class="text-red-400" />
            Rule Enforcement Level
          </h4>
          <p class="text-xs text-[var(--color-text-muted)]">
            How strictly the Critic enforces rules. Rules are ALWAYS applied.
          </p>
          
          <div class="grid gap-2">
            {#each enforcementLevels as level}
              <button
                onclick={() => agentSettingsStore.saveSettings({ ruleEnforcementLevel: level.value })}
                class="flex items-start gap-3 p-3 rounded-lg border transition-all text-left
                  {agentSettingsStore.settings.ruleEnforcementLevel === level.value 
                    ? `border-[var(--color-accent)] ${level.bgColor}` 
                    : 'border-[var(--color-border)] bg-[var(--color-surface-2)] hover:bg-[var(--color-surface-3)]'}"
              >
                <div class="mt-0.5 {level.color}">
                  <level.icon size={18} />
                </div>
                <div class="flex-1">
                  <div class="flex items-center gap-2">
                    <span class="text-sm font-medium text-[var(--color-text-primary)]">
                      {level.label}
                    </span>
                    {#if agentSettingsStore.settings.ruleEnforcementLevel === level.value}
                      <CheckCircle size={14} class="text-green-400" />
                    {/if}
                  </div>
                  <p class="text-xs text-[var(--color-text-muted)] mt-1">
                    {level.description}
                  </p>
                </div>
              </button>
            {/each}
          </div>
        </div>

        <!-- Critic Gate -->
        <div class="space-y-3 pt-4 border-t border-[var(--color-border)]">
          <h4 class="text-sm font-semibold text-[var(--color-text-primary)] flex items-center gap-2">
            <Shield size={16} class="text-purple-400" />
            Critic Gate
          </h4>
          
          <label class="flex items-center justify-between p-3 bg-[var(--color-surface-2)] rounded-lg cursor-pointer hover:bg-[var(--color-surface-3)]">
            <div>
              <div class="text-sm font-medium text-[var(--color-text-primary)]">Enable Critic Gate</div>
              <div class="text-xs text-[var(--color-text-muted)]">Critic reviews all changes before application</div>
            </div>
            <input
              type="checkbox"
              checked={agentSettingsStore.settings.criticGateEnabled}
              onchange={() => toggleSetting("criticGateEnabled")}
              class="w-4 h-4 rounded border-[var(--color-border)] bg-[var(--color-surface-0)] text-[var(--color-accent)] focus:ring-[var(--color-accent)]"
            />
          </label>

          <label class="flex items-center justify-between p-3 bg-[var(--color-surface-2)] rounded-lg cursor-pointer hover:bg-[var(--color-surface-3)]">
            <div>
              <div class="text-sm font-medium text-[var(--color-text-primary)]">Critic Enforces Preferences</div>
              <div class="text-xs text-[var(--color-text-muted)]">Critic strictly enforces workflow from preferences.md</div>
            </div>
            <input
              type="checkbox"
              checked={agentSettingsStore.settings.criticEnforcesPreferences}
              onchange={() => toggleSetting("criticEnforcesPreferences")}
              class="w-4 h-4 rounded border-[var(--color-border)] bg-[var(--color-surface-0)] text-[var(--color-accent)] focus:ring-[var(--color-accent)]"
            />
          </label>
        </div>

        <!-- Auto-Apply -->
        <div class="space-y-3 pt-4 border-t border-[var(--color-border)]">
          <h4 class="text-sm font-semibold text-[var(--color-text-primary)]">Auto-Apply</h4>
          
          <label class="flex items-center justify-between p-3 bg-[var(--color-surface-2)] rounded-lg cursor-pointer hover:bg-[var(--color-surface-3)]">
            <div>
              <div class="text-sm font-medium text-[var(--color-text-primary)]">Auto-Apply Safe Fixes</div>
              <div class="text-xs text-[var(--color-text-muted)]">Automatically apply changes that don't violate rules</div>
            </div>
            <input
              type="checkbox"
              checked={agentSettingsStore.settings.autoApplySafeFixes}
              onchange={() => toggleSetting("autoApplySafeFixes")}
              class="w-4 h-4 rounded border-[var(--color-border)] bg-[var(--color-surface-0)] text-[var(--color-accent)] focus:ring-[var(--color-accent)]"
            />
          </label>

          <label class="flex items-center justify-between p-3 bg-[var(--color-surface-2)] rounded-lg cursor-pointer hover:bg-[var(--color-surface-3)]">
            <div>
              <div class="text-sm font-medium text-[var(--color-text-primary)]">Confirm Rule Violations</div>
              <div class="text-xs text-[var(--color-text-muted)]">Require human confirmation for changes that violate rules</div>
            </div>
            <input
              type="checkbox"
              checked={agentSettingsStore.settings.confirmRuleViolations}
              onchange={() => toggleSetting("confirmRuleViolations")}
              class="w-4 h-4 rounded border-[var(--color-border)] bg-[var(--color-surface-0)] text-[var(--color-accent)] focus:ring-[var(--color-accent)]"
            />
          </label>
        </div>

        <!-- Agent Memory -->
        <div class="space-y-3 pt-4 border-t border-[var(--color-border)]">
          <h4 class="text-sm font-semibold text-[var(--color-text-primary)]">Agent Memory</h4>
          
          <label class="flex items-center justify-between p-3 bg-[var(--color-surface-2)] rounded-lg cursor-pointer hover:bg-[var(--color-surface-3)]">
            <div>
              <div class="text-sm font-medium text-[var(--color-text-primary)]">Agent Can Update Memory</div>
              <div class="text-xs text-[var(--color-text-muted)]">Allow agents to update memory files</div>
            </div>
            <input
              type="checkbox"
              checked={agentSettingsStore.settings.agentMemoryEnabled}
              onchange={() => toggleSetting("agentMemoryEnabled")}
              class="w-4 h-4 rounded border-[var(--color-border)] bg-[var(--color-surface-0)] text-[var(--color-accent)] focus:ring-[var(--color-accent)]"
            />
          </label>

          <label class="flex items-center justify-between p-3 bg-[var(--color-surface-2)] rounded-lg cursor-pointer hover:bg-[var(--color-surface-3)]">
            <div>
              <div class="text-sm font-medium text-[var(--color-text-primary)]">Agent Can Update Preferences</div>
              <div class="text-xs text-[var(--color-text-muted)]">Allow agents to update preferences.md based on learned patterns</div>
            </div>
            <input
              type="checkbox"
              checked={agentSettingsStore.settings.agentCanUpdatePreferences}
              onchange={() => toggleSetting("agentCanUpdatePreferences")}
              class="w-4 h-4 rounded border-[var(--color-border)] bg-[var(--color-surface-0)] text-[var(--color-accent)] focus:ring-[var(--color-accent)]"
            />
          </label>
        </div>

        <!-- Thresholds -->
        <div class="space-y-3 pt-4 border-t border-[var(--color-border)]">
          <h4 class="text-sm font-semibold text-[var(--color-text-primary)]">Approval Thresholds</h4>
          
          <div class="grid grid-cols-2 gap-3">
            <div class="p-3 bg-[var(--color-surface-2)] rounded-lg">
              <label for="max-files" class="text-xs text-[var(--color-text-muted)] block mb-2">Max Files Changed</label>
              <input id="max-files"
                type="number"
                min="1"
                max="50"
                value={agentSettingsStore.settings.approvalThresholdFiles}
                onchange={(e) => agentSettingsStore.saveSettings({ approvalThresholdFiles: parseInt(e.currentTarget.value) })}
                class="w-full px-2 py-1 text-sm bg-[var(--color-surface-0)] border border-[var(--color-border)] rounded text-[var(--color-text-primary)]"
              />
              <p class="text-[10px] text-[var(--color-text-muted)] mt-1">
                Require approval if &gt;N files changed
              </p>
            </div>
            
            <div class="p-3 bg-[var(--color-surface-2)] rounded-lg">
              <label for="max-lines" class="text-xs text-[var(--color-text-muted)] block mb-2">Max Lines Changed</label>
              <input id="max-lines"
                type="number"
                min="10"
                max="1000"
                step="10"
                value={agentSettingsStore.settings.approvalThresholdLines}
                onchange={(e) => agentSettingsStore.saveSettings({ approvalThresholdLines: parseInt(e.currentTarget.value) })}
                class="w-full px-2 py-1 text-sm bg-[var(--color-surface-0)] border border-[var(--color-border)] rounded text-[var(--color-text-primary)]"
              />
              <p class="text-[10px] text-[var(--color-text-muted)] mt-1">
                Require approval if &gt;N lines changed
              </p>
            </div>
          </div>
        </div>

        <!-- Reset -->
        <div class="pt-4 border-t border-[var(--color-border)]">
          <button
            onclick={() => agentSettingsStore.resetSettings()}
            class="flex items-center gap-2 px-4 py-2 text-sm text-red-400 bg-red-500/10 rounded-lg hover:bg-red-500/20"
          >
            <RotateCcw size={16} />
            Reset to Defaults
          </button>
        </div>
      </div>

    {:else if agentSettingsStore.activeTab === "preferences"}
      {@const prefs = agentSettingsStore.preferences}
      <div class="flex flex-col h-full">
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
                    <CheckCircle size={12} class="text-green-500" />
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
            class="flex-1 w-full p-4 text-sm font-mono bg-[var(--color-surface-0)] text-[var(--color-text-primary)] resize-none focus:outline-none"
            spellcheck="false"
          ></textarea>
        {/if}
      </div>

    {:else if agentSettingsStore.activeTab === "enforcement"}
      <div class="h-full overflow-y-auto p-6 space-y-6">
        <!-- Always Enforced Banner -->
        <div class="p-4 bg-red-500/10 border border-red-500/30 rounded-lg">
          <div class="flex items-start gap-3">
            <AlertOctagon size={20} class="text-red-400 mt-0.5" />
            <div>
              <h4 class="text-sm font-semibold text-red-400">Rules Are Always Enforced</h4>
              <p class="text-xs text-[var(--color-text-muted)] mt-1">
                There is no option to disable rule enforcement. The Critic will always check 
                code against .cursorrules and preferences.md. The enforcement level only 
                affects how strictly violations are treated.
              </p>
            </div>
          </div>
        </div>

        <!-- Current Enforcement Status -->
        <div class="space-y-3">
          <h4 class="text-sm font-semibold text-[var(--color-text-primary)]">Current Enforcement</h4>
          
          <div class="space-y-2">
            <div class="flex items-center justify-between p-3 bg-[var(--color-surface-2)] rounded-lg">
              <div class="flex items-center gap-3">
                <Shield size={18} class="text-green-400" />
                <div>
                  <div class="text-sm font-medium text-[var(--color-text-primary)]">.cursorrules</div>
                  <div class="text-xs text-[var(--color-text-muted)]">Always enforced on all code</div>
                </div>
              </div>
              <CheckCircle size={18} class="text-green-400" />
            </div>

            <div class="flex items-center justify-between p-3 bg-[var(--color-surface-2)] rounded-lg">
              <div class="flex items-center gap-3">
                <FileText size={18} class="text-green-400" />
                <div>
                  <div class="text-sm font-medium text-[var(--color-text-primary)]">preferences.md</div>
                  <div class="text-xs text-[var(--color-text-muted)]">
                    {agentSettingsStore.settings.preferencesEnabled ? 'Enabled and enforced' : 'Disabled'}
                  </div>
                </div>
              </div>
              {#if agentSettingsStore.settings.preferencesEnabled}
                <CheckCircle size={18} class="text-green-400" />
              {:else}
                <EyeOff size={18} class="text-gray-400" />
              {/if}
            </div>

            <div class="flex items-center justify-between p-3 bg-[var(--color-surface-2)] rounded-lg">
              <div class="flex items-center gap-3">
                <Bot size={18} class="text-green-400" />
                <div>
                  <div class="text-sm font-medium text-[var(--color-text-primary)]">Critic Gate</div>
                  <div class="text-xs text-[var(--color-text-muted)]">
                    {agentSettingsStore.settings.criticGateEnabled ? 'Active - reviewing all changes' : 'Disabled'}
                  </div>
                </div>
              </div>
              {#if agentSettingsStore.settings.criticGateEnabled}
                <CheckCircle size={18} class="text-green-400" />
              {:else}
                <EyeOff size={18} class="text-gray-400" />
              {/if}
            </div>
          </div>
        </div>

        <!-- Enforcement Levels Explained -->
        <div class="space-y-3 pt-4 border-t border-[var(--color-border)]">
          <h4 class="text-sm font-semibold text-[var(--color-text-primary)]">Enforcement Levels</h4>
          
          <div class="space-y-2 text-xs">
            <div class="p-3 bg-red-500/10 border border-red-500/30 rounded-lg">
              <div class="flex items-center gap-2 font-medium text-red-400 mb-1">
                <AlertOctagon size={14} />
                Strict
              </div>
              <p class="text-[var(--color-text-muted)]">
                Critic blocks ANY rule violation. All violations must be fixed before changes 
                can be applied. Use this for critical production code.
              </p>
            </div>

            <div class="p-3 bg-yellow-500/10 border border-yellow-500/30 rounded-lg">
              <div class="flex items-center gap-2 font-medium text-yellow-400 mb-1">
                <AlertTriangle size={14} />
                Moderate
              </div>
              <p class="text-[var(--color-text-muted)]">
                Critic blocks critical violations (security, performance) and warns on others. 
                Non-critical violations can be overridden with confirmation.
              </p>
            </div>

            <div class="p-3 bg-blue-500/10 border border-blue-500/30 rounded-lg">
              <div class="flex items-center gap-2 font-medium text-blue-400 mb-1">
                <Eye size={14} />
                Lenient
              </div>
              <p class="text-[var(--color-text-muted)]">
                Critic only blocks critical violations. All other issues are warnings. 
                Use this for prototyping or when you want more flexibility.
              </p>
            </div>
          </div>
        </div>

        <!-- What Critic Checks -->
        <div class="space-y-3 pt-4 border-t border-[var(--color-border)]">
          <h4 class="text-sm font-semibold text-[var(--color-text-primary)]">What Critic Checks</h4>
          
          <ul class="space-y-2 text-xs text-[var(--color-text-muted)]">
            <li class="flex items-center gap-2">
              <XCircle size={12} class="text-red-400" />
              <span>Forbidden patterns (eval, console.log in prod, secrets)</span>
            </li>
            <li class="flex items-center gap-2">
              <XCircle size={12} class="text-red-400" />
              <span>Security vulnerabilities</span>
            </li>
            <li class="flex items-center gap-2">
              <XCircle size={12} class="text-red-400" />
              <span>Performance regressions</span>
            </li>
            <li class="flex items-center gap-2">
              <AlertTriangle size={12} class="text-yellow-400" />
              <span>Missing error handling</span>
            </li>
            <li class="flex items-center gap-2">
              <AlertTriangle size={12} class="text-yellow-400" />
              <span>Missing documentation</span>
            </li>
            <li class="flex items-center gap-2">
              <AlertTriangle size={12} class="text-yellow-400" />
              <span>Workflow violations (from preferences.md)</span>
            </li>
          </ul>
        </div>
      </div>
    {/if}
  </div>
</div>
