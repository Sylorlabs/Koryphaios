<script lang="ts">
  import { marked } from 'marked';
  import DOMPurify from 'dompurify';
  import {
    Brain,
    BookOpen,
    ChevronDown,
    ChevronRight,
    FilePlus2,
    FileText,
    FolderOpen,
    MessageSquare,
    Pencil,
    Plus,
    RotateCcw,
    Save,
    Search,
    SlidersHorizontal,
    Sparkles,
    X,
  } from 'lucide-svelte';
  import { memoryStore, type MemoryFile, type ProjectMemoryDocument } from '$lib/stores/memory.svelte';
  import { agentSettingsStore } from '$lib/stores/agent-settings.svelte';
  import { sessionStore } from '$lib/stores/sessions.svelte';
  import SettingsSwitch from '$lib/components/SettingsSwitch.svelte';
  import NumberStepper from '$lib/components/NumberStepper.svelte';

  type BuiltInId = 'universal' | 'project' | 'session' | 'rules';
  type CustomDocument = ProjectMemoryDocument;

  const builtInDocuments: Array<{
    id: BuiltInId;
    title: string;
    description: string;
    icon: typeof Brain;
  }> = [
    { id: 'project', title: 'Project memory', description: 'Shared memory for this workspace', icon: FolderOpen },
    { id: 'rules', title: 'Project rules', description: 'Instructions and conventions', icon: BookOpen },
    { id: 'session', title: 'Session memory', description: 'Memory for this conversation', icon: MessageSquare },
    { id: 'universal', title: 'Universal memory', description: 'Memory shared across workspaces', icon: Brain },
  ];

  let selectedBuiltIn = $state<BuiltInId>('project');
  let selectedCustom = $state<CustomDocument | null>(null);
  let customFile = $state<MemoryFile | null>(null);
  let content = $state('');
  let savedContent = $state('');
  let editMode = $state(false);
  let loadingDocument = $state(false);
  let query = $state('');
  let showPolicy = $state(false);
  let showNewDocument = $state(false);
  let newDocumentName = $state('');
  let newDocumentKind = $state<'memory' | 'rules'>('memory');
  let memoryGroupOpen = $state(true);
  let rulesGroupOpen = $state(true);
  let isDirty = $derived(content !== savedContent);
  let renderedContent = $derived(DOMPurify.sanitize(marked.parse(content || '*Nothing has been written here yet.*', { async: false }) as string));
  let customMemoryDocuments = $derived(memoryStore.documents.filter((document) => document.kind === 'memory' && document.name !== 'project.md'));
  let customRuleDocuments = $derived(memoryStore.documents.filter((document) => document.kind === 'rules' && document.name !== 'rules.md'));

  function getBuiltInFile(id: BuiltInId): MemoryFile | null {
    if (id === 'universal') return memoryStore.universal;
    if (id === 'project') return memoryStore.project;
    if (id === 'session') return memoryStore.session;
    return memoryStore.rules;
  }

  function getBuiltInDefinition(id: BuiltInId) {
    return builtInDocuments.find((document) => document.id === id)!;
  }

  function currentFile(): MemoryFile | null {
    return selectedCustom ? customFile : getBuiltInFile(selectedBuiltIn);
  }

  function currentTitle(): string {
    return selectedCustom?.name.replace(/\.md$/i, '') ?? getBuiltInDefinition(selectedBuiltIn).title;
  }

  function currentDescription(): string {
    return selectedCustom
      ? selectedCustom.kind === 'memory' ? 'Project memory document' : 'Project rules document'
      : getBuiltInDefinition(selectedBuiltIn).description;
  }

  function isSelectedBuiltIn(id: BuiltInId) {
    return !selectedCustom && selectedBuiltIn === id;
  }

  function matches(document: { name?: string; title?: string; description?: string }) {
    const term = query.trim().toLowerCase();
    if (!term) return true;
    return [document.name, document.title, document.description].filter(Boolean).some((value) => value!.toLowerCase().includes(term));
  }

  function applyBuiltInDocument(id: BuiltInId) {
    const file = getBuiltInFile(id);
    selectedBuiltIn = id;
    selectedCustom = null;
    customFile = null;
    content = file?.content ?? '';
    savedContent = file?.content ?? '';
    editMode = false;
    memoryStore.setActiveTab(id);
  }

  async function selectCustomDocument(document: CustomDocument) {
    if (selectedCustom?.name === document.name && selectedCustom.kind === document.kind) return;
    loadingDocument = true;
    const file = await memoryStore.loadDocument(document.name, document.kind);
    loadingDocument = false;
    if (!file) return;
    selectedCustom = document;
    customFile = file;
    content = file.content;
    savedContent = file.content;
    editMode = false;
  }

  async function initializeCurrentDocument() {
    if (selectedCustom) return;
    if (selectedBuiltIn === 'universal') await memoryStore.initializeUniversalMemory();
    if (selectedBuiltIn === 'project') await memoryStore.initializeProjectMemory();
    if (selectedBuiltIn === 'rules') await memoryStore.initializeRules();
    if (selectedBuiltIn === 'session' && sessionStore.activeSessionId) await memoryStore.initializeSessionMemory(sessionStore.activeSessionId);
    const file = getBuiltInFile(selectedBuiltIn);
    content = file?.content ?? '';
    savedContent = file?.content ?? '';
  }

  async function saveCurrentDocument() {
    let success = false;
    if (selectedCustom) {
      const file = await memoryStore.saveDocument(selectedCustom.name, selectedCustom.kind, content);
      if (file) {
        customFile = file;
        success = true;
      }
    } else if (selectedBuiltIn === 'universal') {
      success = await memoryStore.saveUniversalMemory(content);
    } else if (selectedBuiltIn === 'project') {
      success = await memoryStore.saveProjectMemory(content);
    } else if (selectedBuiltIn === 'rules') {
      success = await memoryStore.saveRules(content);
    } else if (sessionStore.activeSessionId) {
      success = await memoryStore.saveSessionMemory(sessionStore.activeSessionId, content);
    }
    if (success) {
      savedContent = content;
      editMode = false;
    }
  }

  function discardChanges() {
    content = savedContent;
    editMode = false;
  }

  async function createDocument() {
    if (!newDocumentName.trim()) return;
    const name = newDocumentName.trim().replace(/\.md$/i, '') + '.md';
    if (await memoryStore.createDocument(newDocumentName, newDocumentKind)) {
      const document = memoryStore.documents.find((item) => item.name === name && item.kind === newDocumentKind);
      newDocumentName = '';
      showNewDocument = false;
      if (document) await selectCustomDocument(document);
    }
  }

  function toggleSetting(key: 'universalMemoryEnabled' | 'projectMemoryEnabled' | 'sessionMemoryEnabled' | 'rulesEnabled' | 'autoIncludeInContext') {
    if (!memoryStore.settings) return;
    void memoryStore.saveSettings({ [key]: !memoryStore.settings[key] });
  }

  function formatDate(value: number | null | undefined) {
    if (!value) return 'Not saved yet';
    return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(value);
  }

  $effect(() => {
    if (!selectedCustom && !isDirty) {
      const file = getBuiltInFile(selectedBuiltIn);
      if (file) {
        content = file.content;
        savedContent = file.content;
      }
    }
  });
</script>

<div class="flex h-full min-h-0 min-w-0 flex-col bg-[var(--color-surface-0)]">
  <header class="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-[var(--color-border)] px-5 py-3.5">
    <div>
      <div class="flex items-center gap-2">
        <Brain size={18} class="text-[var(--color-accent)]" />
        <h3 class="text-base font-semibold text-[var(--color-text-primary)]">Memory</h3>
      </div>
      <p class="mt-0.5 text-sm text-[var(--color-text-muted)]">Your memories, rules, and working context in one place.</p>
    </div>
    <div class="flex items-center gap-2">
      <span class="hidden text-xs text-[var(--color-text-muted)] sm:inline">{[memoryStore.settings?.universalMemoryEnabled, memoryStore.settings?.projectMemoryEnabled, memoryStore.settings?.sessionMemoryEnabled, memoryStore.settings?.rulesEnabled].filter(Boolean).length} sources active</span>
      <button type="button" class:!bg-[var(--color-surface-3)]={showPolicy} class="inline-flex items-center gap-2 rounded-lg border border-[var(--color-border)] px-3 py-2 text-xs font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-2)]" onclick={() => showPolicy = !showPolicy} aria-expanded={showPolicy}>
        <SlidersHorizontal size={14} /> Context policy
      </button>
      <button type="button" class="btn btn-primary inline-flex items-center gap-2 px-3 py-2 text-xs" onclick={() => showNewDocument = !showNewDocument}>
        <Plus size={15} /> New document
      </button>
    </div>
  </header>

  <div class="flex min-h-0 flex-1">
    <aside class="flex w-64 shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-surface-1)]">
      <div class="p-3">
        <label class="relative block">
          <Search size={14} class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]" />
          <input class="input h-9 w-full text-sm" style="padding-left: 2.5rem;" placeholder="Search memory" bind:value={query} aria-label="Search memory" />
        </label>
      </div>

      <nav class="min-h-0 flex-1 overflow-y-auto px-2 pb-4" aria-label="Memory documents">
        <p class="px-2 pb-2 pt-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-muted)]">Memory sources</p>
        {#each builtInDocuments.filter(matches) as document (document.id)}
          {@const Icon = document.icon}
          <button type="button" class="mb-1 flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2.5 text-left transition-colors {isSelectedBuiltIn(document.id) ? 'bg-[var(--color-surface-3)] text-[var(--color-text-primary)]' : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-2)]'}" onclick={() => applyBuiltInDocument(document.id)}>
            <Icon size={16} class="mt-0.5 shrink-0 {isSelectedBuiltIn(document.id) ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-muted)]'}" />
            <span class="min-w-0 flex-1"><span class="block truncate text-sm font-medium">{document.title}</span><span class="mt-0.5 block truncate text-xs text-[var(--color-text-muted)]">{document.description}</span></span>
          </button>
        {/each}

        <div class="mt-4">
          <button type="button" class="flex w-full items-center gap-1.5 px-2 py-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]" onclick={() => memoryGroupOpen = !memoryGroupOpen} aria-expanded={memoryGroupOpen}>
            {#if memoryGroupOpen}<ChevronDown size={14} />{:else}<ChevronRight size={14} />{/if} Memory documents <span class="ml-auto normal-case tracking-normal">{customMemoryDocuments.length}</span>
          </button>
          {#if memoryGroupOpen}
            {#if customMemoryDocuments.filter(matches).length}
              {#each customMemoryDocuments.filter(matches) as document (document.path)}
                <button type="button" class="mb-1 flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors {selectedCustom?.path === document.path ? 'bg-[var(--color-surface-3)] text-[var(--color-text-primary)]' : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-2)]'}" onclick={() => void selectCustomDocument(document)}>
                  <FileText size={15} class="shrink-0 text-[var(--color-text-muted)]" /><span class="truncate">{document.name.replace(/\.md$/i, '')}</span>
                </button>
              {/each}
            {:else if !query}
              <p class="px-2.5 py-1 text-xs text-[var(--color-text-muted)]">No extra memory documents</p>
            {/if}
          {/if}
        </div>

        <div class="mt-3">
          <button type="button" class="flex w-full items-center gap-1.5 px-2 py-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]" onclick={() => rulesGroupOpen = !rulesGroupOpen} aria-expanded={rulesGroupOpen}>
            {#if rulesGroupOpen}<ChevronDown size={14} />{:else}<ChevronRight size={14} />{/if} Rule documents <span class="ml-auto normal-case tracking-normal">{customRuleDocuments.length}</span>
          </button>
          {#if rulesGroupOpen}
            {#if customRuleDocuments.filter(matches).length}
              {#each customRuleDocuments.filter(matches) as document (document.path)}
                <button type="button" class="mb-1 flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors {selectedCustom?.path === document.path ? 'bg-[var(--color-surface-3)] text-[var(--color-text-primary)]' : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-2)]'}" onclick={() => void selectCustomDocument(document)}>
                  <FileText size={15} class="shrink-0 text-[var(--color-text-muted)]" /><span class="truncate">{document.name.replace(/\.md$/i, '')}</span>
                </button>
              {/each}
            {:else if !query}
              <p class="px-2.5 py-1 text-xs text-[var(--color-text-muted)]">No extra rule documents</p>
            {/if}
          {/if}
        </div>
      </nav>
    </aside>

    <main class="flex min-w-0 flex-1 flex-col">
      {#if showNewDocument}
        <div class="border-b border-[var(--color-border)] bg-[var(--color-surface-1)] px-5 py-3">
          <div class="mx-auto flex max-w-4xl flex-wrap items-center gap-2">
            <FilePlus2 size={16} class="text-[var(--color-accent)]" />
            <input class="input h-9 min-w-48 flex-1 text-sm" placeholder="Name this document" bind:value={newDocumentName} onkeydown={(event) => { if (event.key === 'Enter') void createDocument(); }} />
            <div class="flex rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-0)] p-0.5" aria-label="Document type">
              {#each ['memory', 'rules'] as kind (kind)}
                <button type="button" class="rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors {newDocumentKind === kind ? 'bg-[var(--color-surface-3)] text-[var(--color-text-primary)]' : 'text-[var(--color-text-muted)]'}" onclick={() => newDocumentKind = kind as 'memory' | 'rules'}>{kind === 'memory' ? 'Memory' : 'Rule'}</button>
              {/each}
            </div>
            <button type="button" class="btn btn-primary h-9 px-3 text-xs" onclick={() => void createDocument()}>Create</button>
            <button type="button" class="rounded-lg p-2 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-3)]" onclick={() => showNewDocument = false} aria-label="Close new document"><X size={16} /></button>
          </div>
        </div>
      {/if}

      <div class="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--color-border)] px-5 py-3">
        <div class="min-w-0">
          <div class="flex items-center gap-2"><h4 class="truncate text-base font-semibold text-[var(--color-text-primary)]">{currentTitle()}</h4>{#if selectedCustom}<span class="rounded-md bg-[var(--color-surface-3)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-text-muted)]">{selectedCustom.kind}</span>{/if}</div>
          <p class="mt-0.5 truncate text-xs text-[var(--color-text-muted)]">{currentDescription()} · {formatDate(currentFile()?.lastModified)}</p>
        </div>
        <div class="flex shrink-0 items-center gap-2">
          {#if isDirty}<span class="hidden text-xs text-amber-400 sm:inline">Unsaved changes</span>{/if}
          {#if editMode}
            <button type="button" class="rounded-lg px-3 py-2 text-xs font-medium text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]" onclick={discardChanges}>Cancel</button>
            <button type="button" class="btn btn-primary inline-flex items-center gap-1.5 px-3 py-2 text-xs" onclick={() => void saveCurrentDocument()}><Save size={14} /> Save</button>
          {:else}
            <button type="button" class="inline-flex items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-3 py-2 text-xs font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-2)]" onclick={() => editMode = true} disabled={!currentFile()?.exists && !selectedCustom}><Pencil size={14} /> Edit</button>
          {/if}
        </div>
      </div>

      {#if loadingDocument}
        <div class="flex flex-1 items-center justify-center text-sm text-[var(--color-text-muted)]">Opening document…</div>
      {:else if !currentFile()?.exists && !selectedCustom}
        <div class="flex flex-1 items-center justify-center p-8">
          <div class="max-w-sm text-center"><Sparkles size={28} class="mx-auto mb-3 text-[var(--color-accent)]" /><h5 class="text-base font-semibold text-[var(--color-text-primary)]">Start this memory</h5><p class="mt-2 text-sm leading-6 text-[var(--color-text-muted)]">Create a guided Markdown file, then make it your own.</p><button type="button" class="btn btn-primary mt-5 inline-flex items-center gap-2 px-4 py-2 text-sm" onclick={() => void initializeCurrentDocument()} disabled={selectedBuiltIn === 'session' && !sessionStore.activeSessionId}><Plus size={15} /> Initialize</button></div>
        </div>
      {:else if editMode}
        <textarea bind:value={content} class="min-h-0 flex-1 resize-none bg-[var(--color-surface-0)] px-6 py-5 font-mono text-sm leading-6 text-[var(--color-text-primary)] outline-none" spellcheck="false" aria-label={`Edit ${currentTitle()}`}></textarea>
      {:else}
        <article class="min-h-0 flex-1 overflow-y-auto px-6 py-7">
          <div class="kory-markdown max-w-5xl text-[15px] leading-7 text-[var(--color-text-secondary)]">{@html renderedContent}</div>
        </article>
      {/if}
    </main>

    {#if showPolicy}
      <aside class="w-80 shrink-0 overflow-y-auto border-l border-[var(--color-border)] bg-[var(--color-surface-1)] p-4">
        <div class="flex items-start justify-between gap-3"><div><h4 class="text-sm font-semibold text-[var(--color-text-primary)]">Context policy</h4><p class="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">Choose what agents receive automatically.</p></div><button type="button" class="rounded-lg p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-3)]" onclick={() => showPolicy = false} aria-label="Close context policy"><X size={16} /></button></div>
        <div class="mt-5 divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
          <SettingsSwitch checked={memoryStore.settings?.projectMemoryEnabled ?? true} label="Project memory" description="Shared workspace context" onchange={() => toggleSetting('projectMemoryEnabled')} flat />
          <SettingsSwitch checked={memoryStore.settings?.rulesEnabled ?? true} label="Project rules" description="Instructions and conventions" onchange={() => toggleSetting('rulesEnabled')} flat />
          <SettingsSwitch checked={memoryStore.settings?.sessionMemoryEnabled ?? true} label="Session memory" description="This conversation only" onchange={() => toggleSetting('sessionMemoryEnabled')} flat />
          <SettingsSwitch checked={memoryStore.settings?.universalMemoryEnabled ?? true} label="Universal memory" description="Across all workspaces" onchange={() => toggleSetting('universalMemoryEnabled')} flat />
          <SettingsSwitch checked={memoryStore.settings?.autoIncludeInContext ?? true} label="Include automatically" description="Add enabled sources to agent context" onchange={() => toggleSetting('autoIncludeInContext')} flat />
        </div>
        <section class="mt-5 border-b border-[var(--color-border)] pb-5">
          <h5 class="text-sm font-medium text-[var(--color-text-primary)]">Memory token budget</h5>
          <p class="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">Leave room for the task while retaining useful memory.</p>
          <div class="mt-3"><NumberStepper value={memoryStore.settings?.maxContextTokens ?? 2000} min={500} max={8000} step={100} label="Memory token budget" onchange={(value) => void memoryStore.saveSettings({ maxContextTokens: value })} /></div>
        </section>
        <div class="border-b border-[var(--color-border)]"><SettingsSwitch checked={agentSettingsStore.settings.agentMemoryEnabled} label="Agent can update memory" description="Shared with Agent settings" onchange={() => void agentSettingsStore.saveSettings({ agentMemoryEnabled: !agentSettingsStore.settings.agentMemoryEnabled }, { quietSuccess: true })} flat /></div>
        <button type="button" class="mt-4 inline-flex items-center gap-2 rounded-lg px-2 py-2 text-xs text-[var(--color-text-muted)] hover:bg-red-500/10 hover:text-red-400" onclick={() => void memoryStore.resetSettings()}><RotateCcw size={14} /> Reset policy</button>
      </aside>
    {/if}
  </div>
</div>
