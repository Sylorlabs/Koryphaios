<script lang="ts">
  import { memoryStore, type MemoryFile, DEFAULT_SETTINGS } from "$lib/stores/memory.svelte";
  import { agentSettingsStore } from "$lib/stores/agent-settings.svelte";
  import { sessionStore } from "$lib/stores/sessions.svelte";
  import SettingsToggle from "$lib/components/SettingsToggle.svelte";
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
  let newDocumentName = $state("");
  let newDocumentKind = $state<'memory' | 'rules'>('memory');
  let showNewDocument = $state(false);
  
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

  async function createDocument() {
    if (!newDocumentName.trim()) return;
    if (await memoryStore.createDocument(newDocumentName, newDocumentKind)) {
      newDocumentName = '';
      showNewDocument = false;
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
    { id: "rules" as const, label: "Project Rules", icon: BookOpen, color: "text-orange-400" },
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

<div class="flex h-full min-h-0 min-w-0 flex-col">
  <!-- Header -->
  <div class="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border)]">
    <div class="flex items-center gap-2">
      <Brain size={18} class="text-purple-400" />
      <h3 class="text-sm font-semibold text-[var(--color-text-primary)]">Memory & Rules</h3>
    </div>
    <div class="flex items-center gap-2">
      <span class="text-[10px]" style="color: var(--color-text-muted);">{memoryStore.documents.length} project documents</span>
      <button type="button" class="flex items-center gap-1 rounded-lg border px-2 py-1 text-xs" style="border-color: var(--color-border); color: var(--color-accent);" onclick={() => showNewDocument = !showNewDocument}><Plus size={12} /> New .md</button>
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

  {#if showNewDocument}
    <div class="flex items-center gap-2 border-b px-4 py-2" style="border-color: var(--color-border); background: var(--color-surface-2);">
      <input class="input h-8 flex-1 text-xs" placeholder="document-name" bind:value={newDocumentName} onkeydown={(event) => { if (event.key === 'Enter') void createDocument(); }} />
      <div class="flex rounded-lg border p-0.5" style="border-color: var(--color-border);">
        {#each ['memory', 'rules'] as kind (kind)}
          <button type="button" class="rounded-md px-2 py-1 text-[10px]" style="background: {newDocumentKind === kind ? 'var(--color-surface-4)' : 'transparent'}; color: var(--color-text-primary);" onclick={() => newDocumentKind = kind as 'memory' | 'rules'}>{kind}</button>
        {/each}
      </div>
      <button type="button" class="btn btn-primary h-8 px-3 text-xs" onclick={() => void createDocument()}>Create</button>
    </div>
  {/if}

  <!-- Tabs -->
  <div class="flex shrink-0 overflow-x-auto border-b border-[var(--color-border)]">
    {#each tabs as tab}
      <button
        onclick={() => memoryStore.setActiveTab(tab.id)}
        class="shrink-0 whitespace-nowrap flex items-center gap-1.5 px-3 py-2 text-xs font-medium transition-colors border-b-2
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
  <div class="flex-1 min-h-0 overflow-hidden">
    {#if memoryStore.isLoading}
      <div class="flex items-center justify-center h-full">
        <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-[var(--color-accent)]"></div>
      </div>
    {:else if memoryStore.activeTab === "universal"}
      {@const info = getFileInfo(memoryStore.universal)}
      <div class="flex h-full min-h-0 flex-col">
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
          class="min-h-0 flex-1 w-full p-4 text-sm font-mono bg-[var(--color-surface-0)] text-[var(--color-text-primary)] resize-none focus:outline-none disabled:opacity-50"
          spellcheck="false"
        ></textarea>
      </div>

    {:else if memoryStore.activeTab === "project"}
      {@const info = getFileInfo(memoryStore.project)}
      <div class="flex h-full min-h-0 flex-col">
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
          class="min-h-0 flex-1 w-full p-4 text-sm font-mono bg-[var(--color-surface-0)] text-[var(--color-text-primary)] resize-none focus:outline-none disabled:opacity-50"
          spellcheck="false"
        ></textarea>
      </div>

    {:else if memoryStore.activeTab === "session"}
      {@const info = getFileInfo(memoryStore.session)}
      <div class="flex h-full min-h-0 flex-col">
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
            class="min-h-0 flex-1 w-full p-4 text-sm font-mono bg-[var(--color-surface-0)] text-[var(--color-text-primary)] resize-none focus:outline-none disabled:opacity-50"
            spellcheck="false"
          ></textarea>
        {/if}
      </div>

    {:else if memoryStore.activeTab === "rules"}
      {@const info = getFileInfo(memoryStore.rules)}
      <div class="flex h-full min-h-0 flex-col">
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
          class="min-h-0 flex-1 w-full p-4 text-sm font-mono bg-[var(--color-surface-0)] text-[var(--color-text-primary)] resize-none focus:outline-none disabled:opacity-50"
          spellcheck="false"
        ></textarea>
      </div>

    {:else if memoryStore.activeTab === "settings"}
      <div class="h-full overflow-y-auto p-6">
        <div class="grid gap-6 xl:grid-cols-[minmax(0,1.15fr)_minmax(320px,0.85fr)]">
          <div class="space-y-6">
            <section class="space-y-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-1)] p-5">
              <div class="space-y-1">
                <h4 class="flex items-center gap-2 text-sm font-semibold text-[var(--color-text-primary)]">
                  <Settings2 size={16} />
                  Memory Sources
                </h4>
                <p class="text-xs text-[var(--color-text-muted)]">
                  Choose which memory sources are included in the AI context.
                </p>
              </div>

              <div class="grid gap-3 sm:grid-cols-2">
                <label class="flex h-full cursor-pointer items-center justify-between gap-4 rounded-xl bg-[var(--color-surface-2)] p-4 hover:bg-[var(--color-surface-3)]">
                  <div class="flex items-start gap-3">
                    <Brain size={18} class="mt-0.5 text-purple-400" />
                    <div>
                      <div class="text-sm font-medium text-[var(--color-text-primary)]">Universal Memory</div>
                      <div class="mt-1 text-xs text-[var(--color-text-muted)]">Global across all projects in `~/.koryphaios/`.</div>
                    </div>
                  </div>
                  <SettingsToggle
                    checked={memoryStore.settings?.universalMemoryEnabled ?? true}
                    onchange={() => toggleSetting("universalMemoryEnabled")}
                  />
                </label>

                <label class="flex h-full cursor-pointer items-center justify-between gap-4 rounded-xl bg-[var(--color-surface-2)] p-4 hover:bg-[var(--color-surface-3)]">
                  <div class="flex items-start gap-3">
                    <FileText size={18} class="mt-0.5 text-blue-400" />
                    <div>
                      <div class="text-sm font-medium text-[var(--color-text-primary)]">Project Memory</div>
                      <div class="mt-1 text-xs text-[var(--color-text-muted)]">Project-specific context in `.koryphaios/memory/`.</div>
                    </div>
                  </div>
                  <SettingsToggle
                    checked={memoryStore.settings?.projectMemoryEnabled ?? true}
                    onchange={() => toggleSetting("projectMemoryEnabled")}
                  />
                </label>

                <label class="flex h-full cursor-pointer items-center justify-between gap-4 rounded-xl bg-[var(--color-surface-2)] p-4 hover:bg-[var(--color-surface-3)]">
                  <div class="flex items-start gap-3">
                    <MessageSquare size={18} class="mt-0.5 text-green-400" />
                    <div>
                      <div class="text-sm font-medium text-[var(--color-text-primary)]">Session Memory</div>
                      <div class="mt-1 text-xs text-[var(--color-text-muted)]">Persistent storage scoped to the active chat.</div>
                    </div>
                  </div>
                  <SettingsToggle
                    checked={memoryStore.settings?.sessionMemoryEnabled ?? true}
                    onchange={() => toggleSetting("sessionMemoryEnabled")}
                  />
                </label>

                <label class="flex h-full cursor-pointer items-center justify-between gap-4 rounded-xl bg-[var(--color-surface-2)] p-4 hover:bg-[var(--color-surface-3)]">
                  <div class="flex items-start gap-3">
                    <BookOpen size={18} class="mt-0.5 text-orange-400" />
                    <div>
                      <div class="text-sm font-medium text-[var(--color-text-primary)]">Project Rules</div>
                      <div class="mt-1 text-xs text-[var(--color-text-muted)]">Behavior rules and conventions added to context.</div>
                    </div>
                  </div>
                  <SettingsToggle
                    checked={memoryStore.settings?.rulesEnabled ?? true}
                    onchange={() => toggleSetting("rulesEnabled")}
                  />
                </label>
              </div>
            </section>

            <section class="space-y-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-1)] p-5">
              <div class="space-y-1">
                <h4 class="text-sm font-semibold text-[var(--color-text-primary)]">Agent Behavior</h4>
                <p class="text-xs text-[var(--color-text-muted)]">
                  Configure how the agent writes and consumes memory.
                </p>
              </div>

              <div class="grid gap-3 sm:grid-cols-2">
                <!-- Same setting as "Agent Can Update Memory" in the Agent tab —
                     one source of truth (agent settings), mirrored here so the
                     two tabs can never disagree. -->
                <label class="flex h-full cursor-pointer items-center justify-between gap-4 rounded-xl bg-[var(--color-surface-2)] p-4 hover:bg-[var(--color-surface-3)]">
                  <div>
                    <div class="text-sm font-medium text-[var(--color-text-primary)]">Allow Agent to Add Memories</div>
                    <div class="mt-1 text-xs text-[var(--color-text-muted)]">AI can automatically update memory files. Also shown in Agent settings.</div>
                  </div>
                  <SettingsToggle
                    checked={agentSettingsStore.settings.agentMemoryEnabled}
                    onchange={() => agentSettingsStore.saveSettings(
                      { agentMemoryEnabled: !agentSettingsStore.settings.agentMemoryEnabled },
                      { quietSuccess: true },
                    )}
                  />
                </label>

                <label class="flex h-full cursor-pointer items-center justify-between gap-4 rounded-xl bg-[var(--color-surface-2)] p-4 hover:bg-[var(--color-surface-3)]">
                  <div>
                    <div class="text-sm font-medium text-[var(--color-text-primary)]">Auto-include in Context</div>
                    <div class="mt-1 text-xs text-[var(--color-text-muted)]">Automatically add selected memories to the AI context window.</div>
                  </div>
                  <SettingsToggle
                    checked={memoryStore.settings?.autoIncludeInContext ?? true}
                    onchange={() => toggleSetting("autoIncludeInContext")}
                  />
                </label>
              </div>
            </section>
          </div>

          <div class="space-y-6">
            <section class="space-y-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-1)] p-5">
              <div class="space-y-1">
                <h4 class="text-sm font-semibold text-[var(--color-text-primary)]">Context Limits</h4>
                <p class="text-xs text-[var(--color-text-muted)]">
                  Cap how much memory content is injected into prompts.
                </p>
              </div>

              <div class="rounded-xl bg-[var(--color-surface-2)] p-4">
                <div class="mb-3 flex items-center justify-between gap-3">
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
                  class="h-2 w-full cursor-pointer appearance-none rounded-lg bg-[var(--color-surface-3)] accent-[var(--color-accent)]"
                />
                <div class="mt-2 flex justify-between text-xs text-[var(--color-text-muted)]">
                  <span>500</span>
                  <span>8000</span>
                </div>
              </div>
            </section>

            <section class="space-y-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-1)] p-5">
              <h4 class="text-sm font-semibold text-[var(--color-text-primary)]">Active Context</h4>
              <div class="grid gap-3 sm:grid-cols-3 xl:grid-cols-1">
                <div class="rounded-xl bg-[var(--color-surface-2)] p-4">
                  <div class="text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">Sources Enabled</div>
                  <div class="mt-2 text-sm font-semibold text-[var(--color-text-primary)]">
                    {[
                      memoryStore.settings?.universalMemoryEnabled ?? true,
                      memoryStore.settings?.projectMemoryEnabled ?? true,
                      memoryStore.settings?.sessionMemoryEnabled ?? true,
                      memoryStore.settings?.rulesEnabled ?? true,
                    ].filter(Boolean).length}
                    / 4
                  </div>
                </div>
                <div class="rounded-xl bg-[var(--color-surface-2)] p-4">
                  <div class="text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">Agent Writes</div>
                  <div class="mt-2 text-sm font-semibold text-[var(--color-text-primary)]">
                    {agentSettingsStore.settings.agentMemoryEnabled ? 'Allowed' : 'Blocked'}
                  </div>
                </div>
                <div class="rounded-xl bg-[var(--color-surface-2)] p-4">
                  <div class="text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">Auto Include</div>
                  <div class="mt-2 text-sm font-semibold text-[var(--color-text-primary)]">
                    {memoryStore.settings?.autoIncludeInContext ?? true ? 'Enabled' : 'Manual'}
                  </div>
                </div>
              </div>
            </section>

            <section class="rounded-2xl border border-red-500/20 bg-red-500/5 p-5">
              <button
                onclick={() => memoryStore.resetSettings()}
                class="flex items-center gap-2 rounded-lg px-4 py-2 text-sm text-red-400 transition-colors hover:bg-red-500/10"
              >
                <RotateCcw size={16} />
                Reset to Defaults
              </button>
            </section>
          </div>
        </div>
      </div>
    {/if}
  </div>
</div>
