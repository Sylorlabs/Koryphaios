<script lang="ts">
  import { memoryStore, type MemoryFile, DEFAULT_SETTINGS } from "$lib/stores/memory.svelte";
  import { sessionStore } from "$lib/stores/sessions.svelte";
  import { 
    Brain, 
    FileText, 
    MessageSquare, 
    Settings2, 
    BookOpen,
    Save,
    RotateCcw,
    Plus,
    AlertCircle,
    Check,
    X
  } from "lucide-svelte";

  // Props
  interface Props {
    onClose?: () => void;
  }

  let { onClose }: Props = $props();

  // Local state for editing
  let universalContent = $state(memoryStore.universal?.content ?? "");
  let projectContent = $state(memoryStore.project?.content ?? "");
  let sessionContent = $state(memoryStore.session?.content ?? "");
  let rulesContent = $state(memoryStore.rules?.content ?? "");
  
  // Track dirty state
  let dirty = $state({
    universal: false,
    project: false,
    session: false,
    rules: false,
  });

  // Sync local state when store updates
  $effect(() => {
    if (memoryStore.universal && !dirty.universal) {
      universalContent = memoryStore.universal.content;
    }
  });

  $effect(() => {
    if (memoryStore.project && !dirty.project) {
      projectContent = memoryStore.project.content;
    }
  });

  $effect(() => {
    if (memoryStore.session && !dirty.session) {
      sessionContent = memoryStore.session.content;
    }
  });

  $effect(() => {
    if (memoryStore.rules && !dirty.rules) {
      rulesContent = memoryStore.rules.content;
    }
  });

  // Handlers
  async function handleSaveUniversal() {
    if (await memoryStore.saveUniversalMemory(universalContent)) {
      dirty.universal = false;
    }
  }

  async function handleSaveProject() {
    if (await memoryStore.saveProjectMemory(projectContent)) {
      dirty.project = false;
    }
  }

  async function handleSaveSession() {
    const sessionId = sessionStore.activeSessionId;
    if (!sessionId) return;
    if (await memoryStore.saveSessionMemory(sessionId, sessionContent)) {
      dirty.session = false;
    }
  }

  async function handleSaveRules() {
    if (await memoryStore.saveRules(rulesContent)) {
      dirty.rules = false;
    }
  }

  function handleContentChange(type: keyof typeof dirty, value: string) {
    switch (type) {
      case "universal":
        universalContent = value;
        break;
      case "project":
        projectContent = value;
        break;
      case "session":
        sessionContent = value;
        break;
      case "rules":
        rulesContent = value;
        break;
    }
    dirty[type] = true;
  }

  async function handleReset(type: keyof typeof dirty) {
    switch (type) {
      case "universal":
        universalContent = memoryStore.universal?.content ?? "";
        break;
      case "project":
        projectContent = memoryStore.project?.content ?? "";
        break;
      case "session":
        sessionContent = memoryStore.session?.content ?? "";
        break;
      case "rules":
        rulesContent = memoryStore.rules?.content ?? "";
        break;
    }
    dirty[type] = false;
  }

  // Settings handlers
  async function toggleSetting(key: keyof typeof DEFAULT_SETTINGS) {
    if (!memoryStore.settings) return;
    const current = memoryStore.settings[key];
    await memoryStore.saveSettings({ [key]: !current });
  }

  async function handleMaxTokensChange(value: string) {
    const num = parseInt(value, 10);
    if (!isNaN(num) && num > 0) {
      await memoryStore.saveSettings({ maxContextTokens: num });
    }
  }

  // Tab configuration
  const tabs = [
    { id: "project" as const, label: "Project Memory", icon: FileText, color: "text-blue-400" },
    { id: "universal" as const, label: "Universal Memory", icon: Brain, color: "text-purple-400" },
    { id: "session" as const, label: "Session Memory", icon: MessageSquare, color: "text-green-400" },
    { id: "rules" as const, label: "Rules (.cursorrules)", icon: BookOpen, color: "text-orange-400" },
    { id: "settings" as const, label: "Settings", icon: Settings2, color: "text-gray-400" },
  ];

  // Helper to format file info
  function getFileInfo(file: MemoryFile | null) {
    if (!file?.exists) {
      return { exists: false, sizeKb: 0, date: "", path: file?.path ?? "" };
    }
    return {
      exists: true,
      sizeKb: (file.size / 1024).toFixed(1),
      date: file.lastModified ? new Date(file.lastModified).toLocaleDateString() : "Unknown",
      path: file.path,
    };
  }
</script>

<div class="flex flex-col h-full">
  <!-- Header -->
  <div class="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border)]">
    <div class="flex items-center gap-2">
      <Brain size={18} class="text-purple-400" />
      <h3 class="text-sm font-semibold text-[var(--color-text-primary)]">Memory & Rules</h3>
    </div>
    {#if onClose}
      <button
        onclick={onClose}
        class="p-1.5 rounded-lg hover:bg-[var(--color-surface-3)] text-[var(--color-text-muted)]"
      >
        <X size={16} />
      </button>
    {/if}
  </div>

  <!-- Tabs -->
  <div class="flex border-b border-[var(--color-border)]">
    {#each tabs as tab}
      <button
        onclick={() => memoryStore.setActiveTab(tab.id)}
        class="flex items-center gap-1.5 px-3 py-2 text-xs font-medium transition-colors border-b-2
          {memoryStore.activeTab === tab.id 
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
    {#if memoryStore.isLoading}
      <div class="flex items-center justify-center h-full">
        <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-[var(--color-accent)]"></div>
      </div>
    {:else if memoryStore.activeTab === "universal"}
      {@const info = getFileInfo(memoryStore.universal)}
      <div class="flex flex-col h-full">
        <div class="px-4 py-2 bg-[var(--color-surface-2)] border-b border-[var(--color-border)]">
          <div class="flex items-center justify-between">
            <div class="flex-1 min-w-0">
              {#if !info.exists}
                <div class="flex items-center gap-2 text-xs text-yellow-500">
                  <AlertCircle size={14} />
                  <span>Universal memory not initialized</span>
                </div>
              {:else}
                <div class="flex items-center gap-4 text-xs text-gray-400">
                  <span class="flex items-center gap-1">
                    <Check size={12} class="text-green-500" />
                    {info.sizeKb} KB
                  </span>
                  <span>Modified: {info.date}</span>
                  <span class="text-gray-600 truncate max-w-[300px]" title={info.path}>
                    {info.path}
                  </span>
                </div>
              {/if}
            </div>
            <div class="flex items-center gap-2 ml-4">
              {#if !info.exists}
                <button
                  onclick={() => memoryStore.initializeUniversalMemory()}
                  class="flex items-center gap-1 px-2 py-1 text-xs bg-purple-500/20 text-purple-400 rounded hover:bg-purple-500/30"
                >
                  <Plus size={12} />
                  Initialize
                </button>
              {:else}
                <button
                  onclick={() => handleReset("universal")}
                  disabled={!dirty.universal}
                  class="flex items-center gap-1 px-2 py-1 text-xs rounded disabled:opacity-50
                    {dirty.universal ? 'bg-yellow-500/20 text-yellow-400 hover:bg-yellow-500/30' : 'bg-[var(--color-surface-3)] text-[var(--color-text-muted)]'}"
                >
                  <RotateCcw size={12} />
                  Reset
                </button>
                <button
                  onclick={handleSaveUniversal}
                  disabled={!dirty.universal}
                  class="flex items-center gap-1 px-2 py-1 text-xs bg-green-500/20 text-green-400 rounded hover:bg-green-500/30 disabled:opacity-50"
                >
                  <Save size={12} />
                  Save
                </button>
              {/if}
            </div>
          </div>
        </div>
        <textarea
          bind:value={universalContent}
          oninput={(e) => handleContentChange("universal", e.currentTarget.value)}
          disabled={!info.exists}
          placeholder={info.exists ? "Enter universal memory..." : "Initialize universal memory to start editing..."}
          class="flex-1 w-full p-4 text-sm font-mono bg-[var(--color-surface-0)] text-[var(--color-text-primary)] resize-none focus:outline-none disabled:opacity-50"
          spellcheck="false"
        ></textarea>
      </div>

    {:else if memoryStore.activeTab === "project"}
      {@const info = getFileInfo(memoryStore.project)}
      <div class="flex flex-col h-full">
        <div class="px-4 py-2 bg-[var(--color-surface-2)] border-b border-[var(--color-border)]">
          <div class="flex items-center justify-between">
            <div class="flex-1 min-w-0">
              {#if !info.exists}
                <div class="flex items-center gap-2 text-xs text-yellow-500">
                  <AlertCircle size={14} />
                  <span>Project memory not initialized</span>
                </div>
              {:else}
                <div class="flex items-center gap-4 text-xs text-gray-400">
                  <span class="flex items-center gap-1">
                    <Check size={12} class="text-green-500" />
                    {info.sizeKb} KB
                  </span>
                  <span>Modified: {info.date}</span>
                  <span class="text-gray-600 truncate max-w-[300px]" title={info.path}>
                    {info.path}
                  </span>
                </div>
              {/if}
            </div>
            <div class="flex items-center gap-2 ml-4">
              {#if !info.exists}
                <button
                  onclick={() => memoryStore.initializeProjectMemory()}
                  class="flex items-center gap-1 px-2 py-1 text-xs bg-blue-500/20 text-blue-400 rounded hover:bg-blue-500/30"
                >
                  <Plus size={12} />
                  Initialize
                </button>
              {:else}
                <button
                  onclick={() => handleReset("project")}
                  disabled={!dirty.project}
                  class="flex items-center gap-1 px-2 py-1 text-xs rounded disabled:opacity-50
                    {dirty.project ? 'bg-yellow-500/20 text-yellow-400 hover:bg-yellow-500/30' : 'bg-[var(--color-surface-3)] text-[var(--color-text-muted)]'}"
                >
                  <RotateCcw size={12} />
                  Reset
                </button>
                <button
                  onclick={handleSaveProject}
                  disabled={!dirty.project}
                  class="flex items-center gap-1 px-2 py-1 text-xs bg-green-500/20 text-green-400 rounded hover:bg-green-500/30 disabled:opacity-50"
                >
                  <Save size={12} />
                  Save
                </button>
              {/if}
            </div>
          </div>
        </div>
        <textarea
          bind:value={projectContent}
          oninput={(e) => handleContentChange("project", e.currentTarget.value)}
          disabled={!info.exists}
          placeholder={info.exists ? "Enter project memory..." : "Initialize project memory to start editing..."}
          class="flex-1 w-full p-4 text-sm font-mono bg-[var(--color-surface-0)] text-[var(--color-text-primary)] resize-none focus:outline-none disabled:opacity-50"
          spellcheck="false"
        ></textarea>
      </div>

    {:else if memoryStore.activeTab === "session"}
      {@const info = getFileInfo(memoryStore.session)}
      <div class="flex flex-col h-full">
        <div class="px-4 py-2 bg-[var(--color-surface-2)] border-b border-[var(--color-border)]">
          <div class="flex items-center justify-between">
            <div class="flex-1 min-w-0">
              {#if !info.exists}
                <div class="flex items-center gap-2 text-xs text-yellow-500">
                  <AlertCircle size={14} />
                  <span>Session memory not initialized</span>
                </div>
              {:else}
                <div class="flex items-center gap-4 text-xs text-gray-400">
                  <span class="flex items-center gap-1">
                    <Check size={12} class="text-green-500" />
                    {info.sizeKb} KB
                  </span>
                  <span>Modified: {info.date}</span>
                  <span class="text-gray-600 truncate max-w-[300px]" title={info.path}>
                    {info.path}
                  </span>
                </div>
              {/if}
            </div>
            <div class="flex items-center gap-2 ml-4">
              {#if !info.exists}
                <button
                  onclick={() => {
                    const sessionId = sessionStore.activeSessionId;
                    if (sessionId) memoryStore.initializeSessionMemory(sessionId);
                  }}
                  disabled={!sessionStore.activeSessionId}
                  class="flex items-center gap-1 px-2 py-1 text-xs bg-green-500/20 text-green-400 rounded hover:bg-green-500/30 disabled:opacity-50"
                >
                  <Plus size={12} />
                  Initialize
                </button>
              {:else}
                <button
                  onclick={() => handleReset("session")}
                  disabled={!dirty.session}
                  class="flex items-center gap-1 px-2 py-1 text-xs rounded disabled:opacity-50
                    {dirty.session ? 'bg-yellow-500/20 text-yellow-400 hover:bg-yellow-500/30' : 'bg-[var(--color-surface-3)] text-[var(--color-text-muted)]'}"
                >
                  <RotateCcw size={12} />
                  Reset
                </button>
                <button
                  onclick={handleSaveSession}
                  disabled={!dirty.session}
                  class="flex items-center gap-1 px-2 py-1 text-xs bg-green-500/20 text-green-400 rounded hover:bg-green-500/30 disabled:opacity-50"
                >
                  <Save size={12} />
                  Save
                </button>
              {/if}
            </div>
          </div>
        </div>
        {#if !sessionStore.activeSessionId}
          <div class="flex-1 flex items-center justify-center text-[var(--color-text-muted)]">
            <div class="text-center">
              <MessageSquare size={48} class="mx-auto mb-4 opacity-50" />
              <p class="text-sm">No active session</p>
              <p class="text-xs mt-1 opacity-70">Start a chat to manage session memory</p>
            </div>
          </div>
        {:else}
          <textarea
            bind:value={sessionContent}
            oninput={(e) => handleContentChange("session", e.currentTarget.value)}
            disabled={!info.exists}
            placeholder={info.exists ? "Enter session memory..." : "Initialize session memory to start editing..."}
            class="flex-1 w-full p-4 text-sm font-mono bg-[var(--color-surface-0)] text-[var(--color-text-primary)] resize-none focus:outline-none disabled:opacity-50"
            spellcheck="false"
          ></textarea>
        {/if}
      </div>

    {:else if memoryStore.activeTab === "rules"}
      {@const info = getFileInfo(memoryStore.rules)}
      <div class="flex flex-col h-full">
        <div class="px-4 py-2 bg-[var(--color-surface-2)] border-b border-[var(--color-border)]">
          <div class="flex items-center justify-between">
            <div class="flex-1 min-w-0">
              {#if !info.exists}
                <div class="flex items-center gap-2 text-xs text-yellow-500">
                  <AlertCircle size={14} />
                  <span>Rules file not initialized</span>
                </div>
              {:else}
                <div class="flex items-center gap-4 text-xs text-gray-400">
                  <span class="flex items-center gap-1">
                    <Check size={12} class="text-green-500" />
                    {info.sizeKb} KB
                  </span>
                  <span>Modified: {info.date}</span>
                  <span class="text-gray-600 truncate max-w-[300px]" title={info.path}>
                    {info.path}
                  </span>
                </div>
              {/if}
            </div>
            <div class="flex items-center gap-2 ml-4">
              {#if !info.exists}
                <button
                  onclick={() => memoryStore.initializeRules()}
                  class="flex items-center gap-1 px-2 py-1 text-xs bg-orange-500/20 text-orange-400 rounded hover:bg-orange-500/30"
                >
                  <Plus size={12} />
                  Initialize
                </button>
              {:else}
                <button
                  onclick={() => handleReset("rules")}
                  disabled={!dirty.rules}
                  class="flex items-center gap-1 px-2 py-1 text-xs rounded disabled:opacity-50
                    {dirty.rules ? 'bg-yellow-500/20 text-yellow-400 hover:bg-yellow-500/30' : 'bg-[var(--color-surface-3)] text-[var(--color-text-muted)]'}"
                >
                  <RotateCcw size={12} />
                  Reset
                </button>
                <button
                  onclick={handleSaveRules}
                  disabled={!dirty.rules}
                  class="flex items-center gap-1 px-2 py-1 text-xs bg-green-500/20 text-green-400 rounded hover:bg-green-500/30 disabled:opacity-50"
                >
                  <Save size={12} />
                  Save
                </button>
              {/if}
            </div>
          </div>
        </div>
        <textarea
          bind:value={rulesContent}
          oninput={(e) => handleContentChange("rules", e.currentTarget.value)}
          disabled={!info.exists}
          placeholder={info.exists ? "Enter rules..." : "Initialize rules to start editing..."}
          class="flex-1 w-full p-4 text-sm font-mono bg-[var(--color-surface-0)] text-[var(--color-text-primary)] resize-none focus:outline-none disabled:opacity-50"
          spellcheck="false"
        ></textarea>
      </div>

    {:else if memoryStore.activeTab === "settings"}
      <div class="p-6 space-y-6 overflow-y-auto">
        <!-- Enable/Disable Section -->
        <div class="space-y-4">
          <h4 class="text-sm font-semibold text-[var(--color-text-primary)] flex items-center gap-2">
            <Settings2 size={16} />
            Memory Sources
          </h4>
          <p class="text-xs text-[var(--color-text-muted)]">
            Choose which memory sources are included in the AI context
          </p>
          
          <div class="space-y-3">
            <label class="flex items-center justify-between p-3 bg-[var(--color-surface-2)] rounded-lg cursor-pointer hover:bg-[var(--color-surface-3)]">
              <div class="flex items-center gap-3">
                <Brain size={18} class="text-purple-400" />
                <div>
                  <div class="text-sm font-medium text-[var(--color-text-primary)]">Universal Memory</div>
                  <div class="text-xs text-[var(--color-text-muted)]">Global across all projects (~/.koryphaios/)</div>
                </div>
              </div>
              <input
                type="checkbox"
                checked={memoryStore.settings?.universalMemoryEnabled ?? true}
                onchange={() => toggleSetting("universalMemoryEnabled")}
                class="w-4 h-4 rounded border-[var(--color-border)] bg-[var(--color-surface-0)] text-[var(--color-accent)] focus:ring-[var(--color-accent)]"
              />
            </label>

            <label class="flex items-center justify-between p-3 bg-[var(--color-surface-2)] rounded-lg cursor-pointer hover:bg-[var(--color-surface-3)]">
              <div class="flex items-center gap-3">
                <FileText size={18} class="text-blue-400" />
                <div>
                  <div class="text-sm font-medium text-[var(--color-text-primary)]">Project Memory</div>
                  <div class="text-xs text-[var(--color-text-muted)]">Project-specific context (.koryphaios/project-memory/)</div>
                </div>
              </div>
              <input
                type="checkbox"
                checked={memoryStore.settings?.projectMemoryEnabled ?? true}
                onchange={() => toggleSetting("projectMemoryEnabled")}
                class="w-4 h-4 rounded border-[var(--color-border)] bg-[var(--color-surface-0)] text-[var(--color-accent)] focus:ring-[var(--color-accent)]"
              />
            </label>

            <label class="flex items-center justify-between p-3 bg-[var(--color-surface-2)] rounded-lg cursor-pointer hover:bg-[var(--color-surface-3)]">
              <div class="flex items-center gap-3">
                <MessageSquare size={18} class="text-green-400" />
                <div>
                  <div class="text-sm font-medium text-[var(--color-text-primary)]">Session Memory</div>
                  <div class="text-xs text-[var(--color-text-muted)]">Per-chat persistent storage</div>
                </div>
              </div>
              <input
                type="checkbox"
                checked={memoryStore.settings?.sessionMemoryEnabled ?? true}
                onchange={() => toggleSetting("sessionMemoryEnabled")}
                class="w-4 h-4 rounded border-[var(--color-border)] bg-[var(--color-surface-0)] text-[var(--color-accent)] focus:ring-[var(--color-accent)]"
              />
            </label>

            <label class="flex items-center justify-between p-3 bg-[var(--color-surface-2)] rounded-lg cursor-pointer hover:bg-[var(--color-surface-3)]">
              <div class="flex items-center gap-3">
                <BookOpen size={18} class="text-orange-400" />
                <div>
                  <div class="text-sm font-medium text-[var(--color-text-primary)]">Rules (.cursorrules)</div>
                  <div class="text-xs text-[var(--color-text-muted)]">AI behavior rules and conventions</div>
                </div>
              </div>
              <input
                type="checkbox"
                checked={memoryStore.settings?.rulesEnabled ?? true}
                onchange={() => toggleSetting("rulesEnabled")}
                class="w-4 h-4 rounded border-[var(--color-border)] bg-[var(--color-surface-0)] text-[var(--color-accent)] focus:ring-[var(--color-accent)]"
              />
            </label>
          </div>
        </div>

        <!-- Agent Memory -->
        <div class="space-y-4 pt-4 border-t border-[var(--color-border)]">
          <h4 class="text-sm font-semibold text-[var(--color-text-primary)]">Agent Behavior</h4>
          
          <label class="flex items-center justify-between p-3 bg-[var(--color-surface-2)] rounded-lg cursor-pointer hover:bg-[var(--color-surface-3)]">
            <div>
              <div class="text-sm font-medium text-[var(--color-text-primary)]">Allow Agent to Add Memories</div>
              <div class="text-xs text-[var(--color-text-muted)]">AI can automatically update memory files during compaction</div>
            </div>
            <input
              type="checkbox"
              checked={memoryStore.settings?.agentMemoryEnabled ?? true}
              onchange={() => toggleSetting("agentMemoryEnabled")}
              class="w-4 h-4 rounded border-[var(--color-border)] bg-[var(--color-surface-0)] text-[var(--color-accent)] focus:ring-[var(--color-accent)]"
            />
          </label>

          <label class="flex items-center justify-between p-3 bg-[var(--color-surface-2)] rounded-lg cursor-pointer hover:bg-[var(--color-surface-3)]">
            <div>
              <div class="text-sm font-medium text-[var(--color-text-primary)]">Auto-include in Context</div>
              <div class="text-xs text-[var(--color-text-muted)]">Automatically add memories to AI context</div>
            </div>
            <input
              type="checkbox"
              checked={memoryStore.settings?.autoIncludeInContext ?? true}
              onchange={() => toggleSetting("autoIncludeInContext")}
              class="w-4 h-4 rounded border-[var(--color-border)] bg-[var(--color-surface-0)] text-[var(--color-accent)] focus:ring-[var(--color-accent)]"
            />
          </label>
        </div>

        <!-- Context Limits -->
        <div class="space-y-4 pt-4 border-t border-[var(--color-border)]">
          <h4 class="text-sm font-semibold text-[var(--color-text-primary)]">Context Limits</h4>
          
          <div class="p-3 bg-[var(--color-surface-2)] rounded-lg">
            <div class="flex items-center justify-between mb-2">
              <label for="max-tokens" class="text-sm text-[var(--color-text-primary)]">Max Context Tokens</label>
              <span class="text-xs text-[var(--color-text-muted)]">
                {memoryStore.settings?.maxContextTokens ?? 2000} tokens
              </span>
            </div>
            <input
              id="max-tokens"
              type="range"
              min="500"
              max="8000"
              step="100"
              value={memoryStore.settings?.maxContextTokens ?? 2000}
              onchange={(e) => handleMaxTokensChange(e.currentTarget.value)}
              class="w-full h-2 bg-[var(--color-surface-3)] rounded-lg appearance-none cursor-pointer accent-[var(--color-accent)]"
            />
            <div class="flex justify-between text-xs text-[var(--color-text-muted)] mt-1">
              <span>500</span>
              <span>8000</span>
            </div>
          </div>
        </div>

        <!-- Reset Button -->
        <div class="pt-4 border-t border-[var(--color-border)]">
          <button
            onclick={() => memoryStore.resetSettings()}
            class="flex items-center gap-2 px-4 py-2 text-sm text-red-400 bg-red-500/10 rounded-lg hover:bg-red-500/20"
          >
            <RotateCcw size={16} />
            Reset to Defaults
          </button>
        </div>
      </div>
    {/if}
  </div>
</div>
