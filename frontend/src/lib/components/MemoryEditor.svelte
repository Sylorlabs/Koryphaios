<script lang="ts">
  import { marked } from 'marked';
  import DOMPurify from 'dompurify';
  import { onMount, tick } from 'svelte';
  import AlertTriangle from 'lucide-svelte/icons/alert-triangle';
  import Brain from 'lucide-svelte/icons/brain';
  import BookOpen from 'lucide-svelte/icons/book-open';
  import Check from 'lucide-svelte/icons/check';
  import ChevronDown from 'lucide-svelte/icons/chevron-down';
  import ChevronRight from 'lucide-svelte/icons/chevron-right';
  import FilePlus2 from 'lucide-svelte/icons/file-plus-2';
  import FileText from 'lucide-svelte/icons/file-text';
  import FolderOpen from 'lucide-svelte/icons/folder-open';
  import LoaderCircle from 'lucide-svelte/icons/loader-circle';
  import MessageSquare from 'lucide-svelte/icons/message-square';
  import Pencil from 'lucide-svelte/icons/pencil';
  import Plus from 'lucide-svelte/icons/plus';
  import RefreshCw from 'lucide-svelte/icons/refresh-cw';
  import RotateCcw from 'lucide-svelte/icons/rotate-ccw';
  import Save from 'lucide-svelte/icons/save';
  import Search from 'lucide-svelte/icons/search';
  import SlidersHorizontal from 'lucide-svelte/icons/sliders-horizontal';
  import Sparkles from 'lucide-svelte/icons/sparkles';
  import X from 'lucide-svelte/icons/x';
  import ArrowLeft from 'lucide-svelte/icons/arrow-left';
  import KnowledgeScope from './KnowledgeScope.svelte';
  import DocumentEditor from './DocumentEditor.svelte';
  import '$lib/styles/document.css';
  import {
    memoryStore,
    type MemoryFile,
    type MemorySourceKey,
    type ProjectMemoryDocument,
  } from '$lib/stores/memory.svelte';
  import { sessionStore } from '$lib/stores/sessions.svelte';
  import { projectDisplayName, projectStore } from '$lib/stores/project.svelte';
  import { selectProjectNavigation } from '$lib/utils/project-navigation';
  import { toastStore } from '$lib/stores/toast.svelte';
  import SettingsSwitch from '$lib/components/SettingsSwitch.svelte';
  import NumberStepper from '$lib/components/NumberStepper.svelte';
  import KorySelect from '$lib/components/KorySelect.svelte';
  import { apiFetch } from '$lib/api.svelte';
  import { apiUrl } from '$lib/utils/api-url';
  import {
    autosaveDelayForDraft,
    createDraftRegistry,
    draftExitAction,
    isCurrentDraftVersion,
    utf8DraftBytes,
  } from '$lib/utils/draft-save';
  import { formatShortcut } from '$lib/utils/platform';

  type BuiltInId = 'universal' | 'project' | 'session' | 'rules';
  type CustomDocument = ProjectMemoryDocument;
  type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error' | 'conflict';
  interface StrandedMemoryDraft {
    projectPath: string;
    sessionId: string | null;
    builtIn: BuiltInId;
    custom: CustomDocument | null;
    title: string;
    content: string;
    revision: string | null;
  }

  const builtInDocuments: Array<{
    id: BuiltInId;
    title: string;
    description: string;
    icon: typeof Brain;
  }> = [
    {
      id: 'project',
      title: 'Project memory',
      description: 'Durable project facts & decisions',
      icon: FolderOpen,
    },
    {
      id: 'rules',
      title: 'Project rules',
      description: 'Instructions and conventions',
      icon: BookOpen,
    },
    {
      id: 'session',
      title: 'Session memory',
      description: 'Continuity for the current chat',
      icon: MessageSquare,
    },
    {
      id: 'universal',
      title: 'Universal memory',
      description: 'Preferences across your projects',
      icon: Brain,
    },
  ];
  const autosaveOptions = [
    { value: '500', label: '0.5 seconds' },
    { value: '1500', label: '1.5 seconds' },
    { value: '3000', label: '3 seconds' },
    { value: '5000', label: '5 seconds' },
    { value: '10000', label: '10 seconds' },
  ];

  let selectedBuiltIn = $state<BuiltInId>('project');
  let selectedCustom = $state<CustomDocument | null>(null);
  let customFile = $state<MemoryFile | null>(null);
  let content = $state('');
  let savedContent = $state('');
  let editMode = $state(false);
  let editorMode = $state<'visual' | 'source' | 'split'>('visual');
  let showDocumentOnNarrow = $state(false);
  let loadingDocument = $state(false);
  let query = $state('');
  let showPolicy = $state(false);
  let showNewDocument = $state(false);
  let newDocumentName = $state('');
  let newDocumentKind = $state<'memory' | 'rules'>('memory');
  let memoryGroupOpen = $state(true);
  let rulesGroupOpen = $state(true);
  let saveState = $state<SaveState>('idle');
  let autosaveTimer: ReturnType<typeof setTimeout> | null = null;
  let savePromise: Promise<boolean> | null = null;
  let editVersion = 0;
  let draftRevision = $state<string | null>(null);
  let loadedProjectPath = $state<string | null | undefined>(undefined);
  let loadedSessionId = $state<string | null | undefined>(undefined);
  let editingSessionId = $state<string | null>(sessionStore.activeSessionId ?? null);
  const draftRegistry = createDraftRegistry<StrandedMemoryDraft>('memory-editor');
  let strandedDrafts = $state<StrandedMemoryDraft[]>(draftRegistry.list());
  let strandedDraft = $derived(strandedDrafts[0] ?? null);
  let projectLoadPromise: Promise<void> | null = null;
  let policyTriggerEl = $state<HTMLButtonElement | undefined>(undefined);
  let policyCloseEl = $state<HTMLButtonElement | undefined>(undefined);
  let newDocumentTriggerEl = $state<HTMLButtonElement | undefined>(undefined);
  let newDocumentNameEl = $state<HTMLInputElement | undefined>(undefined);
  let documentSelectionGeneration = 0;

  let isDirty = $derived(content !== savedContent);
  let contentBytes = $derived(utf8DraftBytes(content));
  let byteLimit = $derived(
    memoryStore.settings?.documentSizeLimitEnabled
      ? (memoryStore.settings.maxDocumentBytes ?? 1_000_000)
      : 5_000_000,
  );
  let overBudget = $derived(contentBytes > byteLimit);
  let renderedContent = $derived(
    DOMPurify.sanitize(
      marked.parse(content || '*Nothing has been written here yet.*', { async: false }) as string,
    ),
  );
  let customMemoryDocuments = $derived(
    memoryStore.documents.filter(
      (document) => document.kind === 'memory' && document.name !== 'project.md',
    ),
  );
  let customRuleDocuments = $derived(
    memoryStore.documents.filter(
      (document) => document.kind === 'rules' && document.name !== 'rules.md',
    ),
  );

  let activeSource = $derived<MemorySourceKey>(
    selectedCustom ? `document:${selectedCustom.kind}:${selectedCustom.name}` : selectedBuiltIn,
  );
  let activeError = $derived(memoryStore.errorFor(activeSource));
  let documentsError = $derived(memoryStore.errorFor('documents'));
  let settingsError = $derived(memoryStore.errorFor('settings'));
  const isRules = $derived(
    selectedCustom?.kind === 'rules' || (!selectedCustom && selectedBuiltIn === 'rules'),
  );
  const projectScope = $derived(
    memoryStore.storageScope
      ? `${memoryStore.storageScope.kind === 'workspace' ? 'Workspace' : 'Project'} · ${memoryStore.storageScope.name}`
      : memoryStore.isLoading
        ? 'Resolving memory scope…'
        : `Project / workspace · ${projectDisplayName(projectStore.currentPath) || 'Choose a project'}`,
  );
  const currentScope = $derived(
    !selectedCustom && selectedBuiltIn === 'universal'
      ? 'Personal'
      : !selectedCustom && selectedBuiltIn === 'session'
        ? 'Session'
        : memoryStore.storageScope?.kind === 'workspace'
          ? 'Workspace'
          : 'Project',
  );

  function sourceTitle(id: BuiltInId): string {
    if (memoryStore.storageScope?.kind === 'workspace' && (id === 'project' || id === 'rules')) {
      return id === 'project' ? 'Workspace memory' : 'Workspace rules';
    }
    return getBuiltInDefinition(id).title;
  }

  function scopeExplanation(): string {
    if (!selectedCustom && selectedBuiltIn === 'universal')
      return 'Universal memory stores your personal facts and preferences across projects on this computer. It is separate from each project’s Notes collection and from personal Skills.';
    if (!selectedCustom && selectedBuiltIn === 'session')
      return 'Session memory belongs to the current conversation. It preserves continuity and compacted summaries, rather than becoming a document in the project’s Notes collection.';
    return memoryStore.storageScope?.kind === 'workspace'
      ? `This memory is stored at the ${memoryStore.storageScope.name} workspace root and shared by projects that inherit that root. Notes remain scoped to the selected project folder. Skills are explicitly personal or project-specific.`
      : 'Project memory belongs to the selected project. Projects that inherit a registered workspace memory root share that root; the scope label shows the resolved location. Notes remain a separate project collection, and Skills are reusable procedures.';
  }

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
    return selectedCustom?.name.replace(/\.md$/i, '') ?? sourceTitle(selectedBuiltIn);
  }

  function currentDescription(): string {
    return selectedCustom
      ? selectedCustom.kind === 'memory'
        ? 'Additional memory document'
        : 'Additional rules document'
      : getBuiltInDefinition(selectedBuiltIn).description;
  }

  function isSelectedBuiltIn(id: BuiltInId) {
    return !selectedCustom && selectedBuiltIn === id;
  }

  function matches(document: { name?: string; title?: string; description?: string }) {
    const term = query.trim().toLowerCase();
    if (!term) return true;
    return [document.name, document.title, document.description]
      .filter(Boolean)
      .some((value) => value!.toLowerCase().includes(term));
  }

  function cancelAutosave() {
    if (autosaveTimer) clearTimeout(autosaveTimer);
    autosaveTimer = null;
  }

  function memoryDraftKey(
    draft: Pick<StrandedMemoryDraft, 'projectPath' | 'sessionId' | 'builtIn' | 'custom'>,
  ): string {
    const documentId = draft.custom
      ? `${draft.custom.kind}:${draft.custom.name}`
      : draft.builtIn === 'session'
        ? `session:${draft.sessionId ?? 'none'}`
        : draft.builtIn;
    return `${draft.projectPath}\0${documentId}`;
  }

  function refreshDrafts(): void {
    strandedDrafts = draftRegistry.list();
  }

  function holdCurrentDraft(projectPath = loadedProjectPath): void {
    if (!isDirty || !projectPath) return;
    const draft: StrandedMemoryDraft = {
      projectPath,
      sessionId: editingSessionId,
      builtIn: selectedBuiltIn,
      custom: selectedCustom,
      title: currentTitle(),
      content,
      revision: draftRevision,
    };
    draftRegistry.set(memoryDraftKey(draft), draft);
    refreshDrafts();
  }

  function restoreHeldDraft(
    projectPath: string,
    builtIn: BuiltInId,
    custom: CustomDocument | null,
  ): void {
    const probe: StrandedMemoryDraft = {
      projectPath,
      sessionId: editingSessionId,
      builtIn,
      custom,
      title: '',
      content: '',
      revision: null,
    };
    const key = memoryDraftKey(probe);
    const draft = draftRegistry.get(key);
    if (!draft) return;
    content = draft.content;
    draftRevision = draft.revision;
    editVersion++;
    editMode = true;
    saveState = content === savedContent ? 'saved' : 'dirty';
    draftRegistry.delete(key);
    refreshDrafts();
  }

  function scheduleAutosave() {
    editVersion++;
    saveState = 'dirty';
    cancelAutosave();
    const delay = autosaveDelayForDraft({
      enabled: memoryStore.settings?.autosaveEnabled ?? true,
      overBudget,
      delayMs: memoryStore.settings?.autosaveDelayMs ?? 1500,
    });
    if (delay === null) return;
    autosaveTimer = setTimeout(() => void saveCurrentDocument(false), delay);
  }

  async function performSave(draft: string, expectedRevision?: string | null): Promise<boolean> {
    if (selectedCustom) {
      const file = await memoryStore.saveDocument(
        selectedCustom.name,
        selectedCustom.kind,
        draft,
        expectedRevision,
      );
      if (!file) return false;
      customFile = file;
      return true;
    }
    if (selectedBuiltIn === 'universal') {
      return memoryStore.saveUniversalMemory(draft, expectedRevision);
    }
    if (selectedBuiltIn === 'project') {
      return memoryStore.saveProjectMemory(draft, expectedRevision);
    }
    if (selectedBuiltIn === 'rules') {
      return memoryStore.saveRules(draft, expectedRevision);
    }
    if (editingSessionId) {
      return memoryStore.saveSessionMemory(editingSessionId, draft, expectedRevision);
    }
    return false;
  }

  async function saveCurrentDocument(
    exitEditMode = false,
    expectedRevision = draftRevision,
  ): Promise<boolean> {
    cancelAutosave();
    if (!isDirty && !memoryStore.conflict) {
      if (exitEditMode) editMode = false;
      return true;
    }
    if (overBudget) {
      saveState = 'error';
      return false;
    }
    if (savePromise) {
      const pending = savePromise;
      const success = await pending;
      if (!success) return false;
      return isDirty && !memoryStore.conflict ? saveCurrentDocument(exitEditMode) : true;
    }

    const draft = content;
    const version = editVersion;
    saveState = 'saving';
    savePromise = performSave(draft, expectedRevision)
      .then((success) => {
        if (!success) {
          saveState = memoryStore.conflict ? 'conflict' : 'error';
          return false;
        }
        draftRevision = currentFile()?.revision ?? expectedRevision ?? null;
        if (isCurrentDraftVersion(version, editVersion)) {
          savedContent = draft;
          saveState = 'saved';
          if (loadedProjectPath) {
            draftRegistry.delete(
              memoryDraftKey({
                projectPath: loadedProjectPath,
                sessionId: editingSessionId,
                builtIn: selectedBuiltIn,
                custom: selectedCustom,
              }),
            );
            refreshDrafts();
          }
          if (exitEditMode) editMode = false;
        } else {
          saveState = 'dirty';
        }
        return true;
      })
      .finally(() => {
        savePromise = null;
      });
    return savePromise;
  }

  async function canLeaveCurrentDocument(): Promise<boolean> {
    cancelAutosave();
    const action = draftExitAction({
      dirty: isDirty,
      autosaveEnabled: memoryStore.settings?.autosaveEnabled ?? true,
    });
    if (action === 'none') return true;
    if (action === 'hold') {
      holdCurrentDraft();
      return true;
    }
    return saveCurrentDocument(false);
  }

  async function applyBuiltInDocument(id: BuiltInId) {
    if (isSelectedBuiltIn(id) || !(await canLeaveCurrentDocument())) return;
    const generation = ++documentSelectionGeneration;
    selectedBuiltIn = id;
    selectedCustom = null;
    customFile = null;
    if (id === 'session') editingSessionId = sessionStore.activeSessionId ?? null;
    loadingDocument = true;
    await memoryStore.loadBuiltIn(id, editingSessionId);
    if (generation !== documentSelectionGeneration) return;
    loadingDocument = false;
    const file = getBuiltInFile(id);
    content = file?.content ?? '';
    savedContent = file?.content ?? '';
    draftRevision = file?.revision ?? null;
    editMode = false;
    saveState = 'idle';
    memoryStore.clearConflict();
    memoryStore.setActiveTab(id);
    if (loadedProjectPath) restoreHeldDraft(loadedProjectPath, id, null);
  }

  async function selectCustomDocument(document: CustomDocument) {
    if (selectedCustom?.name === document.name && selectedCustom.kind === document.kind) return;
    if (!(await canLeaveCurrentDocument())) return;
    const generation = ++documentSelectionGeneration;
    selectedCustom = document;
    customFile = null;
    content = '';
    savedContent = '';
    draftRevision = null;
    editMode = false;
    saveState = 'idle';
    memoryStore.clearConflict();
    loadingDocument = true;
    const file = await memoryStore.loadDocument(document.name, document.kind);
    if (generation !== documentSelectionGeneration) return;
    loadingDocument = false;
    if (!file) return;
    customFile = file;
    content = file.content;
    savedContent = file.content;
    draftRevision = file.revision;
    editMode = false;
    saveState = 'idle';
    if (loadedProjectPath) restoreHeldDraft(loadedProjectPath, selectedBuiltIn, document);
  }

  async function initializeCurrentDocument() {
    if (selectedCustom) return;
    if (selectedBuiltIn === 'universal') await memoryStore.initializeUniversalMemory();
    if (selectedBuiltIn === 'project') await memoryStore.initializeProjectMemory();
    if (selectedBuiltIn === 'rules') await memoryStore.initializeRules();
    if (selectedBuiltIn === 'session' && editingSessionId) {
      await memoryStore.initializeSessionMemory(editingSessionId);
    }
    const file = getBuiltInFile(selectedBuiltIn);
    content = file?.content ?? '';
    savedContent = file?.content ?? '';
    draftRevision = file?.revision ?? null;
  }

  function discardChanges() {
    cancelAutosave();
    content = savedContent;
    editVersion++;
    editMode = false;
    saveState = 'idle';
    memoryStore.clearConflict();
    memoryStore.clearError(activeSource);
  }

  async function createDocument() {
    if (!newDocumentName.trim() || !(await canLeaveCurrentDocument())) return;
    const document = await memoryStore.createDocument(newDocumentName, newDocumentKind);
    if (document) {
      newDocumentName = '';
      showNewDocument = false;
      await selectCustomDocument(document);
    }
  }

  interface ExternalMemoryProviderInfo {
    provider: string;
    supported: boolean;
    connected: boolean;
    selected: boolean;
    scope: string;
    scopeRequired: boolean;
  }

  // External memory providers are reported by the backend, which knows which
  // adapters implement memory and which credential is actually connected. The
  // client never guesses a provider list.
  let externalMemoryProviders = $state<ExternalMemoryProviderInfo[]>([]);

  let selectedExternalNeedsScope = $derived(
    externalMemoryProviders.some(
      (provider) =>
        provider.provider === memoryStore.settings?.externalMemoryProvider &&
        provider.scopeRequired,
    ),
  );

  async function loadExternalMemoryProviders() {
    try {
      const response = await apiFetch(apiUrl('/api/memory/external/providers'));
      const result = await response.json();
      externalMemoryProviders = response.ok && Array.isArray(result.data) ? result.data : [];
    } catch {
      externalMemoryProviders = [];
    }
  }

  function toggleSetting(
    key:
      | 'universalMemoryEnabled'
      | 'projectMemoryEnabled'
      | 'sessionMemoryEnabled'
      | 'rulesEnabled'
      | 'autoIncludeInContext'
      | 'agentMemoryEnabled'
      | 'maxContextTokensEnabled'
      | 'autosaveEnabled'
      | 'documentSizeLimitEnabled'
      | 'externalMemoryEnabled'
      | 'externalMemoryInContext',
  ) {
    if (!memoryStore.settings) return;
    void memoryStore.saveSettings({ [key]: !memoryStore.settings[key] });
  }

  async function retryCurrentLoad() {
    const generation = ++documentSelectionGeneration;
    const custom = selectedCustom ? { ...selectedCustom } : null;
    const builtIn = selectedBuiltIn;
    const sessionId = editingSessionId;
    const source: MemorySourceKey = custom ? `document:${custom.kind}:${custom.name}` : builtIn;
    memoryStore.clearError(source);
    loadingDocument = true;
    try {
      if (custom) {
        const file = await memoryStore.loadDocument(custom.name, custom.kind);
        if (generation !== documentSelectionGeneration) return;
        if (file) {
          customFile = file;
          if (!isDirty) {
            content = savedContent = file.content;
            draftRevision = file.revision;
          }
        }
      } else if (builtIn === 'universal') await memoryStore.loadUniversalMemory();
      else if (builtIn === 'project') await memoryStore.loadProjectMemory();
      else if (builtIn === 'rules') await memoryStore.loadRules();
      else if (sessionId) {
        await memoryStore.loadSessionMemory(sessionId);
      }
    } finally {
      if (generation === documentSelectionGeneration) loadingDocument = false;
    }
  }

  async function retryActiveOperation() {
    if (saveState === 'error' && isDirty) {
      await saveCurrentDocument(false);
      return;
    }
    await retryCurrentLoad();
  }

  function loadRemoteVersion() {
    const remote = memoryStore.conflict?.remote;
    if (!remote) return;
    if (selectedCustom) customFile = remote;
    content = remote.content;
    savedContent = remote.content;
    draftRevision = remote.revision;
    editVersion++;
    saveState = 'idle';
    memoryStore.clearConflict();
    memoryStore.clearError(activeSource);
  }

  function keepLocalVersion() {
    const remoteRevision = memoryStore.conflict?.remote.revision;
    if (remoteRevision === undefined) return;
    memoryStore.clearConflict();
    memoryStore.clearError(activeSource);
    void saveCurrentDocument(false, remoteRevision);
  }

  async function recoverStrandedDraft() {
    const draft = strandedDraft;
    if (!draft) return;
    const selection = await selectProjectNavigation(draft.projectPath);
    if (!selection.ok) {
      toastStore.error(selection.error);
      return;
    }
    await tick();
    await projectLoadPromise;
    if (projectStore.currentPath !== draft.projectPath) return;

    selectedBuiltIn = draft.builtIn;
    selectedCustom = draft.custom;
    editingSessionId = draft.sessionId;
    if (draft.custom) {
      const remote = await memoryStore.loadDocument(draft.custom.name, draft.custom.kind);
      if (!remote) {
        toastStore.error('The original document could not be reopened. The draft is still held.');
        return;
      }
      customFile = remote;
      savedContent = remote.content;
    } else {
      if (draft.builtIn === 'session' && draft.sessionId) {
        await memoryStore.loadSessionMemory(draft.sessionId);
      }
      customFile = null;
      savedContent = getBuiltInFile(draft.builtIn)?.content ?? '';
    }
    content = draft.content;
    draftRevision = draft.revision;
    editVersion++;
    editMode = true;
    saveState = content === savedContent ? 'saved' : 'dirty';
    draftRegistry.delete(memoryDraftKey(draft));
    refreshDrafts();
    toastStore.info(`Recovered the unsaved draft for ${draft.title}`);
  }

  function discardStrandedDraft() {
    if (!strandedDraft) return;
    if (!confirm(`Discard the unsaved draft for "${strandedDraft.title}"?`)) return;
    draftRegistry.delete(memoryDraftKey(strandedDraft));
    refreshDrafts();
    toastStore.info('Discarded the held memory draft');
  }

  function formatDate(value: number | null | undefined) {
    if (!value) return 'Not saved yet';
    return new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(value);
  }

  function formatBytes(value: number) {
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
    return `${(value / (1024 * 1024)).toFixed(2)} MiB`;
  }

  function handleWindowKeydown(event: KeyboardEvent) {
    if (editMode && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      void saveCurrentDocument(false);
      return;
    }
    if (event.key !== 'Escape') return;
    if (showNewDocument) {
      event.preventDefault();
      showNewDocument = false;
      void tick().then(() => newDocumentTriggerEl?.focus());
      return;
    }
    if (!showPolicy) return;
    event.preventDefault();
    showPolicy = false;
    void tick().then(() => policyTriggerEl?.focus());
  }

  $effect(() => {
    const projectPath = projectStore.currentPath;
    const sessionId = sessionStore.activeSessionId ?? null;
    const projectChanged = projectPath !== loadedProjectPath;
    const sessionChanged = sessionId !== loadedSessionId;
    if (!projectChanged && !sessionChanged) return;

    const previousProjectPath = loadedProjectPath;
    const projectScopedSelection = Boolean(selectedCustom) || selectedBuiltIn !== 'universal';
    const affectedSelection =
      (projectChanged && projectScopedSelection) ||
      (sessionChanged && !selectedCustom && selectedBuiltIn === 'session');
    if (
      previousProjectPath !== undefined &&
      previousProjectPath !== null &&
      affectedSelection &&
      isDirty
    ) {
      holdCurrentDraft(previousProjectPath);
    }

    loadedProjectPath = projectPath;
    loadedSessionId = sessionId;
    cancelAutosave();
    documentSelectionGeneration++;

    if (projectChanged) {
      memoryStore.beginProjectTransition();
      if (projectScopedSelection) {
        selectedBuiltIn = 'project';
        selectedCustom = null;
        customFile = null;
        editingSessionId = sessionId;
        content = '';
        savedContent = '';
        draftRevision = null;
        editMode = false;
        saveState = 'idle';
      }

      loadingDocument = true;
      const expectedProject = projectPath;
      const load = memoryStore.loadAllMemory(sessionId ?? undefined).then(() => {
        if (projectStore.currentPath !== expectedProject) return;
        loadingDocument = false;
        if (projectScopedSelection) {
          const file = memoryStore.project;
          content = file?.content ?? '';
          savedContent = file?.content ?? '';
          draftRevision = file?.revision ?? null;
          if (expectedProject) restoreHeldDraft(expectedProject, 'project', null);
        } else if (isDirty) {
          scheduleAutosave();
        }
      });
      projectLoadPromise = load;
      return;
    }

    if (sessionChanged) {
      if (!selectedCustom && selectedBuiltIn === 'session' && isDirty && loadedProjectPath) {
        holdCurrentDraft(loadedProjectPath);
      }
      memoryStore.clearSessionMemory();
      editingSessionId = sessionId;
      if (!selectedCustom && selectedBuiltIn === 'session') {
        content = '';
        savedContent = '';
        draftRevision = null;
        editMode = false;
        saveState = 'idle';
        loadingDocument = true;
      }
      const expectedSession = sessionId;
      const load = (sessionId ? memoryStore.loadSessionMemory(sessionId) : Promise.resolve()).then(
        () => {
          if ((sessionStore.activeSessionId ?? null) !== expectedSession) return;
          loadingDocument = false;
          if (!selectedCustom && selectedBuiltIn === 'session') {
            const file = memoryStore.session;
            content = file?.content ?? '';
            savedContent = file?.content ?? '';
            draftRevision = file?.revision ?? null;
            if (loadedProjectPath) restoreHeldDraft(loadedProjectPath, 'session', null);
          }
        },
      );
      projectLoadPromise = load;
    }
  });

  $effect(() => {
    if (!selectedCustom && !isDirty && !editMode) {
      const file = getBuiltInFile(selectedBuiltIn);
      if (file) {
        content = file.content;
        savedContent = file.content;
        draftRevision = file.revision;
      }
    }
  });

  $effect(() => {
    if (!isDirty && strandedDrafts.length === 0) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  });

  onMount(() => {
    void loadExternalMemoryProviders();
    const flushWhenHidden = () => {
      if (
        document.visibilityState === 'hidden' &&
        isDirty &&
        loadedProjectPath === projectStore.currentPath &&
        (memoryStore.settings?.autosaveEnabled ?? true)
      ) {
        void saveCurrentDocument(false);
      }
    };
    document.addEventListener('visibilitychange', flushWhenHidden);
    window.addEventListener('keydown', handleWindowKeydown);
    return () => {
      document.removeEventListener('visibilitychange', flushWhenHidden);
      window.removeEventListener('keydown', handleWindowKeydown);
      cancelAutosave();
      if (loadedProjectPath === projectStore.currentPath) {
        const action = draftExitAction({
          dirty: isDirty,
          autosaveEnabled: memoryStore.settings?.autosaveEnabled ?? true,
        });
        if (action === 'save') void saveCurrentDocument(false);
        else if (action === 'hold') holdCurrentDraft();
      }
    };
  });
</script>

<div class="memory-shell flex h-full min-h-0 min-w-0 flex-col bg-[var(--color-surface-0)]">
  <header class="memory-header flex shrink-0 flex-wrap items-start justify-between gap-x-6 gap-y-3">
    <div class="memory-heading min-w-0">
      <h3 class="memory-title">Memory</h3>
      <p class="memory-description">
        Keep the facts, preferences, and decisions worth carrying forward.
      </p>
      <div class="memory-scope">
        <KnowledgeScope scope={currentScope} description={scopeExplanation()} />
      </div>
    </div>
    <div class="flex flex-wrap items-center gap-2">
      <span class="hidden text-xs text-[var(--color-text-muted)] sm:inline"
        >{[
          memoryStore.settings?.universalMemoryEnabled,
          memoryStore.settings?.projectMemoryEnabled,
          memoryStore.settings?.sessionMemoryEnabled,
          memoryStore.settings?.rulesEnabled,
        ].filter(Boolean).length} sources active</span
      >
      <button
        bind:this={policyTriggerEl}
        type="button"
        class:!bg-[var(--color-surface-3)]={showPolicy}
        class="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-2)]"
        onclick={() => {
          showPolicy = !showPolicy;
          if (showPolicy) void tick().then(() => policyCloseEl?.focus());
        }}
        aria-expanded={showPolicy}
      >
        <SlidersHorizontal size={14} /> Context settings
      </button>
      <button
        bind:this={newDocumentTriggerEl}
        type="button"
        class="btn btn-primary inline-flex items-center gap-2 px-3 py-2 text-xs"
        onclick={() => {
          showNewDocument = !showNewDocument;
          if (showNewDocument) void tick().then(() => newDocumentNameEl?.focus());
        }}
      >
        <Plus size={15} /> New document
      </button>
    </div>
  </header>

  <div
    class="memory-layout relative flex min-h-0 flex-1"
    class:show-document={showDocumentOnNarrow}
  >
    <aside
      class="memory-library flex shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-surface-1)]"
      aria-label="Memory sources"
    >
      <div class="p-3">
        <label class="relative block">
          <Search
            size={14}
            class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]"
          />
          <input
            class="input h-9 w-full text-sm"
            style="padding-left: 2.5rem;"
            placeholder="Search memory"
            bind:value={query}
            aria-label="Search memory"
          />
        </label>
      </div>

      <nav class="min-h-0 flex-1 overflow-y-auto px-2 pb-4" aria-label="Memory documents">
        <p
          class="px-2 pb-2 pt-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-muted)]"
        >
          Remembered context
        </p>
        {#if documentsError}
          <div
            class="mb-3 rounded-lg border p-2.5 text-xs"
            style="border-color: var(--color-error); background: var(--color-error-bg); color: var(--color-text-primary);"
            role="alert"
          >
            <p>{documentsError}</p>
            <button
              type="button"
              class="mt-2 inline-flex items-center gap-1 font-medium text-[var(--color-error)]"
              onclick={() => void memoryStore.loadDocuments()}
              ><RefreshCw size={12} /> Retry document list</button
            >
          </div>
        {/if}
        {#each builtInDocuments
          .filter((document) => document.id !== 'rules')
          .filter(matches) as document (document.id)}
          {@const Icon = document.icon}
          <button
            type="button"
            class="mb-1 flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2.5 text-left transition-colors {isSelectedBuiltIn(
              document.id,
            )
              ? 'memory-selected text-[var(--color-text-primary)]'
              : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-2)]'}"
            aria-current={isSelectedBuiltIn(document.id) ? 'page' : undefined}
            onclick={() => {
              showDocumentOnNarrow = true;
              void applyBuiltInDocument(document.id);
            }}
          >
            <Icon
              size={16}
              class="mt-0.5 shrink-0 {isSelectedBuiltIn(document.id)
                ? 'text-[var(--color-accent)]'
                : 'text-[var(--color-text-muted)]'}"
            />
            <span class="min-w-0 flex-1"
              ><span class="block truncate text-sm font-medium">{sourceTitle(document.id)}</span
              ><span class="mt-0.5 block truncate text-xs text-[var(--color-text-muted)]"
                >{document.description}</span
              ></span
            >
          </button>
        {/each}

        <div class="mt-4">
          <button
            type="button"
            class="flex w-full items-center gap-1.5 px-2 py-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
            onclick={() => (memoryGroupOpen = !memoryGroupOpen)}
            aria-expanded={memoryGroupOpen}
          >
            {#if memoryGroupOpen}<ChevronDown size={14} />{:else}<ChevronRight size={14} />{/if} Memory
            documents
            <span class="ml-auto normal-case tracking-normal">{customMemoryDocuments.length}</span>
          </button>
          {#if memoryGroupOpen}
            {#if customMemoryDocuments.filter(matches).length}
              {#each customMemoryDocuments.filter(matches) as document (document.path)}
                <button
                  type="button"
                  class="mb-1 flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors {selectedCustom?.path ===
                  document.path
                    ? 'bg-[var(--color-surface-3)] text-[var(--color-text-primary)]'
                    : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-2)]'}"
                  onclick={() => {
                    showDocumentOnNarrow = true;
                    void selectCustomDocument(document);
                  }}
                >
                  <FileText size={15} class="shrink-0 text-[var(--color-text-muted)]" /><span
                    class="truncate">{document.name.replace(/\.md$/i, '')}</span
                  >
                </button>
              {/each}
            {:else if !query}
              <p class="px-2.5 py-1 text-xs text-[var(--color-text-muted)]">
                Add a document for a focused topic.
              </p>
            {/if}
          {/if}
        </div>

        <div class="mt-3">
          <button
            type="button"
            class="flex w-full items-center gap-1.5 px-2 py-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
            onclick={() => (rulesGroupOpen = !rulesGroupOpen)}
            aria-expanded={rulesGroupOpen}
          >
            {#if rulesGroupOpen}<ChevronDown size={14} />{:else}<ChevronRight size={14} />{/if} Rules
            &amp; conventions
            <span class="ml-auto normal-case tracking-normal">{customRuleDocuments.length + 1}</span
            >
          </button>
          {#if rulesGroupOpen}
            {#if matches(getBuiltInDefinition('rules'))}
              <button
                type="button"
                class="mb-1 flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2.5 text-left transition-colors {isSelectedBuiltIn(
                  'rules',
                )
                  ? 'memory-selected text-[var(--color-text-primary)]'
                  : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-2)]'}"
                aria-current={isSelectedBuiltIn('rules') ? 'page' : undefined}
                onclick={() => {
                  showDocumentOnNarrow = true;
                  void applyBuiltInDocument('rules');
                }}
              >
                <BookOpen size={16} class="mt-0.5 shrink-0 text-[var(--color-text-muted)]" />
                <span
                  ><span class="block text-sm font-medium">{sourceTitle('rules')}</span><span
                    class="mt-0.5 block text-xs text-[var(--color-text-muted)]"
                    >Standing instructions, not task playbooks</span
                  ></span
                >
              </button>
            {/if}
            {#if customRuleDocuments.filter(matches).length}
              {#each customRuleDocuments.filter(matches) as document (document.path)}
                <button
                  type="button"
                  class="mb-1 flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors {selectedCustom?.path ===
                  document.path
                    ? 'bg-[var(--color-surface-3)] text-[var(--color-text-primary)]'
                    : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-2)]'}"
                  onclick={() => {
                    showDocumentOnNarrow = true;
                    void selectCustomDocument(document);
                  }}
                >
                  <FileText size={15} class="shrink-0 text-[var(--color-text-muted)]" /><span
                    class="truncate">{document.name.replace(/\.md$/i, '')}</span
                  >
                </button>
              {/each}
            {:else if !query}
              <p class="px-2.5 py-1 text-xs text-[var(--color-text-muted)]">
                No extra rule documents
              </p>
            {/if}
          {/if}
        </div>
      </nav>
      <div class="px-4 py-3 text-xs leading-5 text-[var(--color-text-muted)]">
        Keep remembered facts concise and focused.
      </div>
    </aside>

    <div class="memory-detail flex min-h-0 min-w-0 flex-1 flex-col">
      {#if showNewDocument}
        <div class="border-b border-[var(--color-border)] bg-[var(--color-surface-1)] px-5 py-3">
          <div class="mx-auto flex max-w-4xl flex-wrap items-center gap-2">
            <FilePlus2 size={16} class="text-[var(--color-accent)]" />
            <input
              bind:this={newDocumentNameEl}
              class="input h-9 min-w-48 flex-1 text-sm"
              placeholder="Name this document"
              aria-label="Memory document name"
              bind:value={newDocumentName}
              onkeydown={(event) => {
                if (event.key === 'Enter') void createDocument();
              }}
            />
            <div
              class="flex rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-0)] p-0.5"
              role="group"
              aria-label="Document type"
            >
              {#each ['memory', 'rules'] as kind (kind)}
                <button
                  type="button"
                  class="rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors {newDocumentKind ===
                  kind
                    ? 'bg-[var(--color-surface-3)] text-[var(--color-text-primary)]'
                    : 'text-[var(--color-text-muted)]'}"
                  onclick={() => (newDocumentKind = kind as 'memory' | 'rules')}
                  >{kind === 'memory' ? 'Memory' : 'Rule'}</button
                >
              {/each}
            </div>
            <button
              type="button"
              class="btn btn-primary h-9 px-3 text-xs"
              onclick={() => void createDocument()}>Create</button
            >
            <button
              type="button"
              class="rounded-lg p-2 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-3)]"
              onclick={() => {
                showNewDocument = false;
                void tick().then(() => newDocumentTriggerEl?.focus());
              }}
              aria-label="Close new document"><X size={16} /></button
            >
          </div>
        </div>
      {/if}

      <div
        class="memory-document-heading flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-[var(--color-border)] px-6 py-4"
      >
        <div class="min-w-0">
          <div class="flex items-center gap-2">
            <button
              type="button"
              class="memory-back rounded-lg p-1.5 text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-2)]"
              aria-label="Back to memory sources"
              onclick={() => (showDocumentOnNarrow = false)}><ArrowLeft size={16} /></button
            >
            <h4 class="truncate text-lg font-semibold text-[var(--color-text-primary)]">
              {currentTitle()}
            </h4>
            <span
              class="rounded-md bg-[var(--color-surface-2)] px-2 py-0.5 text-[11px] font-medium text-[var(--color-text-secondary)]"
              >{isRules ? 'Instructions' : 'Context'}</span
            >
          </div>
          <p class="mt-0.5 truncate text-xs text-[var(--color-text-muted)]">
            {currentDescription()} · {formatDate(currentFile()?.lastModified)}
          </p>
        </div>
        <div class="flex shrink-0 items-center gap-2" aria-live="polite">
          {#if saveState === 'saving'}
            <span
              class="hidden items-center gap-1.5 text-xs text-[var(--color-text-muted)] sm:inline-flex"
              ><LoaderCircle size={13} class="animate-spin" /> Saving…</span
            >
          {:else if saveState === 'saved' && !isDirty}
            <span
              class="hidden items-center gap-1.5 text-xs text-[var(--color-success)] sm:inline-flex"
              ><Check size={13} /> Saved</span
            >
          {:else if isDirty}
            <span class="hidden text-xs text-[var(--color-warning)] sm:inline">Unsaved changes</span
            >
          {/if}
          {#if editMode}
            <button
              type="button"
              class="rounded-lg px-3 py-2 text-xs font-medium text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]"
              onclick={discardChanges}>Cancel</button
            >
            <button
              type="button"
              class="btn btn-primary inline-flex items-center gap-1.5 px-3 py-2 text-xs"
              onclick={() => void saveCurrentDocument(false)}
              disabled={saveState === 'saving' || overBudget}><Save size={14} /> Save</button
            >
          {:else}
            <button
              type="button"
              class="inline-flex items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-3 py-2 text-xs font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-2)]"
              onclick={() => {
                editMode = true;
                saveState = isDirty ? 'dirty' : 'idle';
              }}
              disabled={!currentFile()?.exists && !selectedCustom}><Pencil size={14} /> Edit</button
            >
          {/if}
        </div>
      </div>

      {#if strandedDraft}
        <div
          class="border-b px-5 py-3"
          style="border-color: color-mix(in srgb, var(--color-warning) 30%, var(--color-border)); background: var(--color-warning-bg);"
          role="alert"
        >
          <div class="mx-auto flex max-w-5xl flex-wrap items-center gap-3">
            <AlertTriangle size={16} class="shrink-0 text-[var(--color-warning)]" />
            <p class="min-w-56 flex-1 text-xs leading-5 text-[var(--color-text-primary)]">
              An unsaved draft for “{strandedDraft.title}” is being held from
              {strandedDraft.builtIn === 'session'
                ? 'a previous conversation in '
                : ''}{projectDisplayName(strandedDraft.projectPath)}. It was not carried into the
              current project context.
              {#if strandedDrafts.length > 1}
                {strandedDrafts.length - 1} more draft{strandedDrafts.length === 2 ? '' : 's'} are also
                held.
              {/if}
            </p>
            <button
              type="button"
              class="rounded-lg px-3 py-1.5 text-xs font-semibold hover:brightness-110"
              style="background: var(--color-warning); color: var(--color-surface-0);"
              onclick={() => void recoverStrandedDraft()}>Return and recover</button
            >
            <button
              type="button"
              class="rounded-lg border border-[var(--color-warning)]/30 px-3 py-1.5 text-xs font-medium text-[var(--color-warning)] hover:bg-[var(--color-warning-bg)]"
              onclick={discardStrandedDraft}>Discard draft</button
            >
          </div>
        </div>
      {/if}

      {#if memoryStore.conflict}
        <div
          class="border-b px-5 py-3"
          style="border-color: color-mix(in srgb, var(--color-warning) 30%, var(--color-border)); background: var(--color-warning-bg);"
          role="alert"
        >
          <div class="mx-auto flex max-w-5xl flex-wrap items-center gap-3">
            <AlertTriangle size={16} class="shrink-0 text-[var(--color-warning)]" />
            <p class="min-w-56 flex-1 text-xs leading-5 text-[var(--color-text-primary)]">
              A newer version was saved elsewhere. Your draft is still here; choose which version
              should win.
            </p>
            <button
              type="button"
              class="rounded-lg border border-[var(--color-warning)]/30 px-3 py-1.5 text-xs font-medium text-[var(--color-warning)] hover:bg-[var(--color-warning-bg)]"
              onclick={loadRemoteVersion}>Load newer version</button
            >
            <button
              type="button"
              class="rounded-lg px-3 py-1.5 text-xs font-semibold hover:brightness-110"
              style="background: var(--color-warning); color: var(--color-surface-0);"
              onclick={keepLocalVersion}>Keep my draft</button
            >
          </div>
        </div>
      {:else if activeError}
        <div
          class="border-b px-5 py-2.5"
          style="border-color: var(--color-error); background: var(--color-error-bg);"
          role="alert"
        >
          <div class="mx-auto flex max-w-5xl items-center gap-3">
            <AlertTriangle size={15} class="shrink-0 text-[var(--color-error)]" />
            <p class="min-w-0 flex-1 text-xs text-[var(--color-text-primary)]">{activeError}</p>
            <button
              type="button"
              class="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-[var(--color-error)] hover:bg-[var(--color-surface-2)]"
              onclick={() => void retryActiveOperation()}
              ><RefreshCw size={13} /> {saveState === 'error' ? 'Retry save' : 'Retry load'}</button
            >
          </div>
        </div>
      {/if}

      {#if overBudget}
        <div
          class="border-b px-5 py-2 text-xs text-[var(--color-text-primary)]"
          style="border-color: color-mix(in srgb, var(--color-error) 30%, var(--color-border)); background: var(--color-error-bg);"
          role="alert"
        >
          This draft is {formatBytes(contentBytes - byteLimit)} over the configured document limit. Increase
          the limit or shorten the document before saving.
        </div>
      {/if}

      {#if loadingDocument}
        <div class="flex flex-1 items-center justify-center text-sm text-[var(--color-text-muted)]">
          Opening document…
        </div>
      {:else if !currentFile()?.exists && !selectedCustom}
        <div class="flex flex-1 items-center justify-center p-8">
          <div class="max-w-sm text-center">
            <Sparkles size={24} class="mx-auto mb-3 text-[var(--color-accent)]" />
            <h5 class="text-base font-semibold text-[var(--color-text-primary)]">
              {isRules ? 'Set your conventions' : 'Start with what matters'}
            </h5>
            <p class="mt-2 text-sm leading-6 text-[var(--color-text-muted)]">
              {isRules
                ? 'Write standing instructions for this project. Use Skills for procedures that apply to specific tasks.'
                : 'Capture a few durable facts or preferences. Save long reports and research in Notes.'}
            </p>
            <button
              type="button"
              class="btn btn-primary mt-5 inline-flex items-center gap-2 px-4 py-2 text-sm"
              onclick={() => void initializeCurrentDocument()}
              disabled={selectedBuiltIn === 'session' && !sessionStore.activeSessionId}
              ><Plus size={15} /> Initialize</button
            >
          </div>
        </div>
      {:else if editMode}
        <div class="memory-reading-area min-h-0 flex-1 overflow-y-auto">
          <div class="memory-editor-page">
            <DocumentEditor
              value={content}
              bind:mode={editorMode}
              label={`Edit ${currentTitle()}`}
              sourceLabel={`Source of ${currentTitle()}`}
              onchange={(value) => {
                content = value;
                scheduleAutosave();
              }}
            />
          </div>
        </div>
        <div
          id="memory-save-hint"
          class="flex shrink-0 items-center justify-between border-t border-[var(--color-border)] bg-[var(--color-surface-1)] px-5 py-2 text-[11px] text-[var(--color-text-muted)]"
        >
          <span
            >Markdown · {formatShortcut('Mod+S')} saves · {memoryStore.settings?.autosaveEnabled
              ? `autosave after ${(memoryStore.settings.autosaveDelayMs / 1000).toFixed(1)}s`
              : `autosave off · only Save or ${formatShortcut('Mod+S')} writes to disk`}</span
          ><span
            >{content.split(/\s+/).filter(Boolean).length.toLocaleString()} words · {formatBytes(
              contentBytes,
            )}</span
          >
        </div>
      {:else}
        <article class="memory-reading-area min-h-0 flex-1 overflow-y-auto">
          <div class="memory-paper kory-document">
            {@html renderedContent}
          </div>
        </article>
      {/if}
    </div>

    {#if showPolicy}
      <aside
        class="memory-policy absolute inset-y-0 right-0 z-30 w-80 max-w-full overflow-y-auto border-l border-[var(--color-border)] bg-[var(--color-surface-1)] p-5"
        aria-label="Memory context policy"
      >
        <div class="flex items-start justify-between gap-3">
          <div>
            <h4 class="text-base font-semibold text-[var(--color-text-primary)]">
              Context settings
            </h4>
            <p class="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">
              Choose what agents receive automatically.
            </p>
          </div>
          <button
            bind:this={policyCloseEl}
            type="button"
            class="rounded-lg p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-3)]"
            onclick={() => {
              showPolicy = false;
              void tick().then(() => policyTriggerEl?.focus());
            }}
            aria-label="Close context policy"><X size={16} /></button
          >
        </div>
        {#if settingsError}
          <div
            class="mt-4 rounded-lg border p-3 text-xs"
            style="border-color: var(--color-error); background: var(--color-error-bg); color: var(--color-text-primary);"
            role="alert"
          >
            <p>{settingsError}</p>
            <button
              type="button"
              class="mt-2 inline-flex items-center gap-1 font-medium text-[var(--color-error)]"
              onclick={() => void memoryStore.loadSettings()}
              ><RefreshCw size={12} /> Retry policy</button
            >
          </div>
        {/if}
        <div
          class="mt-5 divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]"
        >
          <SettingsSwitch
            checked={memoryStore.settings?.projectMemoryEnabled ?? true}
            label="Project memory"
            description={projectScope}
            onchange={() => toggleSetting('projectMemoryEnabled')}
            flat
          />
          <SettingsSwitch
            checked={memoryStore.settings?.rulesEnabled ?? true}
            label="Project rules"
            description="Instructions and conventions"
            onchange={() => toggleSetting('rulesEnabled')}
            flat
          />
          <SettingsSwitch
            checked={memoryStore.settings?.sessionMemoryEnabled ?? true}
            label="Session memory"
            description="This conversation only"
            onchange={() => toggleSetting('sessionMemoryEnabled')}
            flat
          />
          <SettingsSwitch
            checked={memoryStore.settings?.universalMemoryEnabled ?? true}
            label="Universal memory"
            description="Across all workspaces"
            onchange={() => toggleSetting('universalMemoryEnabled')}
            flat
          />
          <SettingsSwitch
            checked={memoryStore.settings?.autoIncludeInContext ?? true}
            label="Include automatically"
            description="Add enabled sources to agent context"
            onchange={() => toggleSetting('autoIncludeInContext')}
            flat
          />
        </div>
        <section class="mt-5 border-b border-[var(--color-border)] pb-5">
          <h5 class="text-sm font-medium text-[var(--color-text-primary)]">Memory token budget</h5>
          <p class="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">
            Leave room for the task while retaining useful memory. This bounds context injection,
            not what you can write.
          </p>
          <div class="mt-3 border-y border-[var(--color-border)]">
            <SettingsSwitch
              checked={memoryStore.settings?.maxContextTokensEnabled ?? true}
              label="Limit injected memory"
              description="Off still applies the 100,000-token safety ceiling"
              onchange={() => toggleSetting('maxContextTokensEnabled')}
              flat
            />
          </div>
          {#if memoryStore.settings?.maxContextTokensEnabled ?? true}<div class="mt-3">
              <NumberStepper
                value={memoryStore.settings?.maxContextTokens ?? 2000}
                min={100}
                max={100000}
                step={100}
                label="Memory token budget"
                onchange={(value) => void memoryStore.saveSettings({ maxContextTokens: value })}
              />
            </div>{/if}
        </section>
        <section class="mt-5 border-b border-[var(--color-border)] pb-5">
          <h5 class="text-sm font-medium text-[var(--color-text-primary)]">
            External long-term memory
          </h5>
          <p class="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">
            Optionally mirror memories to an external store so they survive a reinstall and follow
            you across machines. Mem0 and Letta are managed memory services, not chat providers, and
            content you store there is sent off this device. Local memory files above remain the
            source of truth and keep working whatever happens here.
          </p>
          <div class="mt-3 border-y border-[var(--color-border)]">
            <SettingsSwitch
              checked={memoryStore.settings?.externalMemoryEnabled ?? false}
              label="Use external memory"
              description="Off by default: external providers bill per operation and store content off-machine"
              onchange={() => toggleSetting('externalMemoryEnabled')}
              flat
            />
          </div>
          {#if memoryStore.settings?.externalMemoryEnabled}
            <div class="mt-3 space-y-3">
              <label class="block">
                <span class="text-xs font-medium text-[var(--color-text-secondary)]">Provider</span>
                <div class="mt-1.5">
                  <KorySelect
                    value={memoryStore.settings?.externalMemoryProvider ?? ''}
                    onchange={(value: string) =>
                      void memoryStore.saveSettings({ externalMemoryProvider: value })}
                    options={[
                      { value: '', label: 'Select a provider' },
                      ...externalMemoryProviders.map((provider) => ({
                        value: provider.provider,
                        label: provider.connected
                          ? provider.provider === 'mem0'
                            ? 'Mem0'
                            : 'Letta'
                          : `${provider.provider === 'mem0' ? 'Mem0' : 'Letta'} (not connected)`,
                        disabled: !provider.connected,
                        description: provider.scopeRequired
                          ? 'Requires a Letta agent id as the scope'
                          : undefined,
                      })),
                    ]}
                    placeholder="Select a provider"
                  />
                </div>
                <span class="mt-1 block text-[11px] text-[var(--color-text-muted)]">
                  {#if !externalMemoryProviders.some((provider) => provider.connected)}
                    No external memory provider is connected yet. Add a key for Mem0 or Letta in
                    Providers &amp; models.
                  {:else if selectedExternalNeedsScope}
                    Letta stores memories against a Letta agent. Paste that agent id below.
                  {/if}
                </span>
              </label>

              {#if selectedExternalNeedsScope}
                <label class="block">
                  <span class="text-xs font-medium text-[var(--color-text-secondary)]">
                    Letta agent id
                  </span>
                  <input
                    type="text"
                    class="mt-1.5 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-1)] px-3 py-2 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]"
                    placeholder="agent-..."
                    value={memoryStore.settings?.externalMemoryScope ?? ''}
                    oninput={(event) =>
                      void memoryStore.saveSettings({
                        externalMemoryScope: (event.currentTarget as HTMLInputElement).value,
                      })}
                  />
                </label>
              {/if}

              <div class="border-t border-[var(--color-border)]">
                <SettingsSwitch
                  checked={memoryStore.settings?.externalMemoryInContext ?? false}
                  label="Include recalled memories in agent context"
                  description="Agents see relevant external memories automatically"
                  onchange={() => toggleSetting('externalMemoryInContext')}
                  flat
                />
              </div>
            </div>
          {/if}
        </section>
        <section class="mt-5 border-b border-[var(--color-border)] pb-5">
          <h5 class="text-sm font-medium text-[var(--color-text-primary)]">Long-form editor</h5>
          <p class="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">
            Control when drafts save and how large each memory document may be.
          </p>
          <div
            class="mt-3 divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]"
          >
            <SettingsSwitch
              checked={memoryStore.settings?.autosaveEnabled ?? true}
              label="Autosave drafts"
              description={`On saves while editing. When off, only Save or ${formatShortcut('Mod+S')} writes to disk`}
              onchange={() => toggleSetting('autosaveEnabled')}
              flat
            />
            <SettingsSwitch
              checked={memoryStore.settings?.documentSizeLimitEnabled ?? true}
              label="Document budget"
              description="Reject oversized saves instead of truncating them"
              onchange={() => toggleSetting('documentSizeLimitEnabled')}
              flat
            />
          </div>
          {#if memoryStore.settings?.autosaveEnabled ?? true}
            <div class="mt-3">
              <p class="mb-1.5 text-xs font-medium text-[var(--color-text-secondary)]">
                Autosave delay
              </p>
              <KorySelect
                compact
                value={String(memoryStore.settings?.autosaveDelayMs ?? 1500)}
                options={autosaveOptions}
                label="Memory autosave delay"
                onchange={(value) => memoryStore.saveSettings({ autosaveDelayMs: Number(value) })}
              />
            </div>
          {/if}
          {#if memoryStore.settings?.documentSizeLimitEnabled ?? true}
            <div class="mt-3">
              <p class="mb-1.5 text-xs font-medium text-[var(--color-text-secondary)]">
                Maximum document size
              </p>
              <NumberStepper
                compact
                value={memoryStore.settings?.maxDocumentBytes ?? 1_000_000}
                min={16384}
                max={5000000}
                step={65536}
                label="Maximum memory document size in bytes"
                valueText={formatBytes(memoryStore.settings?.maxDocumentBytes ?? 1_000_000)}
                onchange={(value) => void memoryStore.saveSettings({ maxDocumentBytes: value })}
              />
              <p class="mt-1.5 text-[11px] leading-4 text-[var(--color-text-muted)]">
                Current limit: {formatBytes(memoryStore.settings?.maxDocumentBytes ?? 1_000_000)}.
                The field accepts exact bytes.
              </p>
            </div>
          {/if}
        </section>
        <div class="border-b border-[var(--color-border)]">
          <SettingsSwitch
            checked={memoryStore.settings?.agentMemoryEnabled ?? true}
            label="Agent can update memory"
            description="Allow approved memory tools to write project memory"
            onchange={() => toggleSetting('agentMemoryEnabled')}
            flat
          />
        </div>
        <button
          type="button"
          class="mt-4 inline-flex items-center gap-2 rounded-lg px-2 py-2 text-xs text-[var(--color-text-muted)] hover:bg-[var(--color-error-bg)] hover:text-[var(--color-error)]"
          onclick={() => void memoryStore.resetSettings()}
          ><RotateCcw size={14} /> Reset policy</button
        >
      </aside>
    {/if}
  </div>
</div>

<style>
  .memory-shell {
    container: memory / inline-size;
  }
  .memory-library {
    width: 240px;
    min-height: 0;
  }
  .memory-selected {
    background: var(--color-surface-3);
  }
  .memory-back {
    display: none;
  }
  .memory-reading-area {
    padding: 28px 32px 40px;
    background: var(--color-surface-0);
  }
  .memory-paper {
    max-width: 780px;
    min-height: 360px;
    margin: 0 auto;
    padding: 24px 32px;
  }
  /*
   * The rendered document reads in one shade of the theme. `document.css` lifts
   * headings and bold text to `--color-text-primary`, which is a distinctly
   * lighter (and in tinted themes, bluer) color than the body copy, so a memory
   * document looked like it was painted in two colors. Hierarchy here comes from
   * size and weight only; every text element inherits the pane's one shade.
   */
  .memory-paper :global(h1),
  .memory-paper :global(h2),
  .memory-paper :global(h3),
  .memory-paper :global(h4),
  .memory-paper :global(h5),
  .memory-paper :global(h6),
  .memory-paper :global(strong),
  .memory-paper :global(th) {
    color: inherit;
  }
  .memory-editor-page {
    max-width: 920px;
    margin: 0 auto;
  }
  .memory-header {
    padding: 28px 32px 16px;
  }
  .memory-heading {
    flex: 1 1 320px;
  }
  .memory-title {
    margin: 0;
    font-size: 20px;
    line-height: 1.3;
    font-weight: 600;
    color: var(--color-text-primary);
  }
  .memory-description {
    margin: 4px 0 0;
    max-width: 64ch;
    font-size: 13px;
    line-height: 1.55;
    color: var(--color-text-muted);
  }
  /* Scope picker + its info disclosure sit together under the description
     instead of the disclosure floating to the far edge of its own row. */
  .memory-scope {
    margin-top: 12px;
  }
  .memory-scope :global(.knowledge-scope-row) {
    justify-content: flex-start;
    padding: 0;
  }
  .memory-library,
  .memory-document-heading {
    border-color: color-mix(in srgb, var(--color-text-muted) 12%, transparent);
  }
  .memory-library :global(input) {
    border-color: transparent;
    background: var(--color-surface-2);
    box-shadow: none;
  }
  .memory-policy {
    box-shadow: -12px 0 32px color-mix(in srgb, var(--color-surface-0) 40%, transparent);
  }
  @container memory (max-width: 720px) {
    .memory-library {
      width: 100%;
      border-right: 0;
    }
    .memory-detail {
      display: none;
    }
    .show-document .memory-library {
      display: none;
    }
    .show-document .memory-detail {
      display: flex;
    }
    .memory-back {
      display: inline-flex;
    }
    .memory-header {
      padding: 20px 16px 12px;
    }
    .memory-document-heading {
      padding: 16px;
    }
    .memory-reading-area {
      padding: 16px;
    }
    .memory-paper {
      padding: 24px;
    }
  }
</style>
