<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { marked } from 'marked';
  import DOMPurify from 'dompurify';
  import {
    agentSettingsStore,
    type SkillConversionPreview,
    type SkillDocumentSpec,
    type SkillFormatKind,
    type SkillRevision,
  } from '$lib/stores/agent-settings.svelte';
  import KorySelect from './KorySelect.svelte';
  import NumberStepper from './NumberStepper.svelte';
  import SkillCodeEditor from './SkillCodeEditor.svelte';
  import SkillVisualEditor from './SkillVisualEditor.svelte';
  import ArrowLeft from 'lucide-svelte/icons/arrow-left';
  import CheckCircle from 'lucide-svelte/icons/check-circle';
  import FileDiff from 'lucide-svelte/icons/file-diff';
  import FlaskConical from 'lucide-svelte/icons/flask-conical';
  import Plus from 'lucide-svelte/icons/plus';
  import Save from 'lucide-svelte/icons/save';
  import Search from 'lucide-svelte/icons/search';
  import X from 'lucide-svelte/icons/x';

  let { active = true }: { active?: boolean } = $props();

  type DetailTab = 'overview' | 'editor' | 'evidence';
  type EditorMode = 'visual' | 'source' | 'split';
  type LibraryGroup = 'Drafts' | 'Updates' | 'Needs attention' | 'Active';
  type DraftBuffer = { sourceContent: string; coreInstructions: string; dirty: boolean };

  let selectedKey = $state('');
  let detailTab = $state<DetailTab>('overview');
  let editorMode = $state<EditorMode>('split');
  let searchQuery = $state('');
  let sourceFilter = $state('all');
  let statusFilter = $state('all');
  let buffers = $state<Record<string, DraftBuffer>>({});
  let showDetailOnNarrow = $state(false);
  let routingOpen = $state(false);
  let creatorOpen = $state(false);
  let creatorStep = $state<1 | 2 | 3>(1);
  let comparisonMode = $state<'revision' | 'bundled' | null>(null);
  let conversionTarget = $state<SkillFormatKind>('html');
  let conversionExtension = $state('prompt');
  let conversionRenderer = $state<'markdown' | 'plain' | 'html'>('plain');
  let conversionPreview = $state<SkillConversionPreview | null>(null);
  let liveStatus = $state('');
  let modalReturnFocus: HTMLElement | null = null;

  let newName = $state('');
  let newSource = $state<'personal' | 'project'>('personal');
  let newDescription = $state('');
  let newFormat = $state<SkillFormatKind>('markdown');
  let newExtension = $state('prompt');
  let newRenderer = $state<'markdown' | 'plain' | 'html'>('plain');
  let newInstructions = $state('');
  let newDomains = $state('');
  let newTriggers = $state('');
  let newPositive = $state('');
  let newNegative = $state('');
  let newEvidence = $state('');
  let newBroader = $state('');
  let newRequires = $state('');
  let newConflicts = $state('');
  let newExcludes = $state('');
  let newTargetMedium = $state('any');
  let newContextBudget = $state(4000);

  const skillBufferPrefix = (skill: SkillRevision) => `${skill.source}:${skill.name}:`;
  const revisionKey = (skill: SkillRevision) =>
    `${skillBufferPrefix(skill)}${skill.state}:${skill.hash}`;
  const hasDirtySkillBuffer = (skill: SkillRevision) =>
    Object.entries(buffers).some(
      ([key, buffer]) => key.startsWith(skillBufferPrefix(skill)) && buffer.dirty,
    );
  const splitLines = (value: string) =>
    value
      .split(/\r?\n|,/)
      .map((item) => item.trim())
      .filter(Boolean);
  const normalizeName = (value: string) =>
    value
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64);
  const normalizeExtension = (value: string) =>
    value
      .toLowerCase()
      .trim()
      .replace(/^\.+/, '')
      .replace(/[^a-z0-9_-]/g, '')
      .slice(0, 17);
  const isSafeCustomExtension = (value: string) => {
    const extension = normalizeExtension(value);
    return (
      /^[a-z0-9](?:[a-z0-9_-]{0,15}[a-z0-9])?$/.test(extension) &&
      !['json', 'kory'].includes(extension)
    );
  };

  let selectedSkill = $derived(
    agentSettingsStore.skills.find((skill) => revisionKey(skill) === selectedKey) ??
      agentSettingsStore.skills.find((skill) => skill.state === 'draft') ??
      agentSettingsStore.skills[0],
  );
  let activeSkillCount = $derived(
    agentSettingsStore.skills.filter((skill) => skill.state === 'active' && skill.validation.valid)
      .length,
  );
  let dirtyCount = $derived(Object.values(buffers).filter((buffer) => buffer.dirty).length);
  let creatorDirty = $derived(
    Boolean(
      newName ||
        newDescription ||
        newInstructions ||
        newDomains ||
        newTriggers ||
        newPositive ||
        newNegative ||
        newEvidence ||
        newBroader ||
        newRequires ||
        newConflicts ||
        newExcludes ||
        newSource !== 'personal' ||
        newFormat !== 'markdown' ||
        newExtension !== 'prompt' ||
        newRenderer !== 'plain' ||
        newTargetMedium !== 'any' ||
        newContextBudget !== 4000,
    ),
  );
  let unsavedCount = $derived(dirtyCount + (creatorDirty ? 1 : 0));
  let filteredSkills = $derived.by(() => {
    const query = searchQuery.trim().toLowerCase();
    return agentSettingsStore.skills.filter((skill) => {
      if (sourceFilter !== 'all' && skill.source !== sourceFilter) return false;
      if (statusFilter === 'active' && skill.state !== 'active') return false;
      if (statusFilter === 'draft' && skill.state !== 'draft') return false;
      if (statusFilter === 'invalid' && skill.validation.valid) return false;
      if (statusFilter === 'updates' && !skill.bundledUpdateAvailable) return false;
      if (!query) return true;
      return [skill.name, skill.description, skill.source, ...skill.metadata.domains]
        .join(' ')
        .toLowerCase()
        .includes(query);
    });
  });
  let groupedSkills = $derived.by(() => {
    const groups: Record<LibraryGroup, SkillRevision[]> = {
      Drafts: [],
      Updates: [],
      'Needs attention': [],
      Active: [],
    };
    for (const skill of filteredSkills) {
      if (!skill.validation.valid) groups['Needs attention'].push(skill);
      else if (skill.state === 'draft') groups.Drafts.push(skill);
      else if (skill.bundledUpdateAvailable) groups.Updates.push(skill);
      else groups.Active.push(skill);
    }
    return (Object.entries(groups) as Array<[LibraryGroup, SkillRevision[]]>).filter(
      ([, skills]) => skills.length,
    );
  });
  let selectedBuffer = $derived(selectedSkill ? buffers[revisionKey(selectedSkill)] : undefined);
  let selectedSkillHasDirtyBuffer = $derived(
    selectedSkill ? hasDirtySkillBuffer(selectedSkill) : false,
  );
  let selectedSource = $derived(
    selectedBuffer?.sourceContent ??
      (selectedSkill?.storageVersion === 2
        ? selectedSkill.sourceContent
        : selectedSkill?.content) ??
      '',
  );
  let selectedCore = $derived(
    selectedBuffer?.coreInstructions ?? selectedSkill?.coreInstructions ?? '',
  );

  let creatorIssues = $derived.by(() => {
    const issues: string[] = [];
    if (!normalizeName(newName)) issues.push('Use a lowercase skill name.');
    if (newDescription.trim().length < 40)
      issues.push('Describe the skill in at least 40 characters.');
    if (
      newFormat === 'custom' &&
      !isSafeCustomExtension(newExtension)
    ) {
      issues.push('Use a safe custom extension such as rst or prompt.');
    }
    if (newInstructions.trim().length < 40)
      issues.push('Add at least 40 characters of operating instructions.');
    if (splitLines(newDomains).length < 1) issues.push('Add a professional domain.');
    if (splitLines(newTriggers).length < 1) issues.push('Add a routing phrase.');
    if (splitLines(newPositive).length < 2)
      issues.push('Add two examples that should use the skill.');
    if (splitLines(newNegative).length < 2)
      issues.push('Add two examples that should not use the skill.');
    if (splitLines(newEvidence).length < 1) issues.push('Add completion evidence.');
    return issues;
  });

  $effect(() => {
    if (!selectedSkill) return;
    const key = revisionKey(selectedSkill);
    if (!selectedKey) selectedKey = key;
    if (!buffers[key]) {
      buffers = {
        ...buffers,
        [key]: {
          sourceContent:
            selectedSkill.storageVersion === 2
              ? selectedSkill.sourceContent
              : selectedSkill.content,
          coreInstructions: selectedSkill.coreInstructions,
          dirty: false,
        },
      };
    }
    void agentSettingsStore.loadSkillEvaluationCard(selectedSkill);
  });

  $effect(() => {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(
      new CustomEvent('koryphaios:skills-dirty', { detail: { dirty: unsavedCount > 0 } }),
    );
  });

  function selectSkill(skill: SkillRevision) {
    creatorOpen = false;
    selectedKey = revisionKey(skill);
    showDetailOnNarrow = true;
  }

  function rememberModalTrigger() {
    if (typeof document !== 'undefined' && document.activeElement instanceof HTMLElement) {
      modalReturnFocus = document.activeElement;
    }
  }

  function focusModal(selector: string) {
    void tick().then(() => document.querySelector<HTMLElement>(selector)?.focus());
  }

  function restoreModalFocus() {
    const target = modalReturnFocus;
    modalReturnFocus = null;
    void tick().then(() => target?.focus());
  }

  function openRoutingTool() {
    rememberModalTrigger();
    routingOpen = true;
    focusModal('#routing-prompt');
  }

  function closeRoutingTool() {
    routingOpen = false;
    restoreModalFocus();
  }

  function closeComparison() {
    comparisonMode = null;
    restoreModalFocus();
  }

  function handleDialogKey(event: KeyboardEvent, close: () => void) {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== 'Tab') return;
    const dialog = event.currentTarget as HTMLElement;
    const controls = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), summary, [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((control) => control.offsetParent !== null);
    if (!controls.length) return;
    const first = controls[0];
    const last = controls.at(-1)!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function updateBuffer(sourceContent: string, coreInstructions = selectedCore) {
    if (!selectedSkill) return;
    const key = revisionKey(selectedSkill);
    buffers = { ...buffers, [key]: { sourceContent, coreInstructions, dirty: true } };
    liveStatus = `Unsaved changes in ${selectedSkill.name}`;
  }

  async function saveSelected() {
    if (!selectedSkill || !selectedBuffer?.dirty) return;
    const originalKey = revisionKey(selectedSkill);
    const saved = await agentSettingsStore.saveSkillDraft(
      selectedSkill,
      selectedBuffer.sourceContent,
      selectedBuffer.coreInstructions,
    );
    if (!saved) return;
    const savedKey = revisionKey(saved);
    const nextBuffers = { ...buffers };
    delete nextBuffers[originalKey];
    nextBuffers[savedKey] = {
      sourceContent: saved.storageVersion === 2 ? saved.sourceContent : saved.content,
      coreInstructions: saved.coreInstructions,
      dirty: false,
    };
    buffers = nextBuffers;
    selectedKey = savedKey;
    liveStatus = `${saved.name} saved as an inactive draft`;
  }

  async function activateSelected() {
    if (!selectedSkill || hasDirtySkillBuffer(selectedSkill)) return;
    const bufferPrefix = skillBufferPrefix(selectedSkill);
    const activated = await agentSettingsStore.testAndActivateSkill(selectedSkill);
    if (!activated) return;
    buffers = Object.fromEntries(
      Object.entries(buffers).filter(([key]) => !key.startsWith(bufferPrefix)),
    );
    selectedKey = revisionKey(activated);
    liveStatus = `${activated.name} validated and activated`;
  }

  function previewSource(skill: SkillRevision | undefined, source: string): string {
    if (!skill) return source;
    if (skill.storageVersion === 1) {
      return source.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/)?.[1] ?? source;
    }
    return source;
  }

  function updateVisualSource(sourceContent: string) {
    if (!selectedSkill) return;
    if (selectedSkill.storageVersion === 2) {
      updateBuffer(sourceContent);
      return;
    }
    const legacy = selectedSource.match(/^(---\r?\n[\s\S]*?\r?\n---\r?\n)([\s\S]*)$/);
    updateBuffer(legacy ? `${legacy[1]}${sourceContent}` : sourceContent);
  }

  function markdownPreview(source: string): string {
    return DOMPurify.sanitize(
      marked.parse(source || '*Nothing written yet.*', { async: false }) as string,
    );
  }

  function htmlPreview(source: string): string {
    const csp =
      "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'; navigate-to 'none'";
    return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}"><style>html{color-scheme:light dark}body{font:14px/1.55 system-ui;color:CanvasText;background:Canvas;padding:20px;margin:0}pre{white-space:pre-wrap}</style></head><body>${source}</body></html>`;
  }

  function handleTabKey(event: KeyboardEvent) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const tablist = event.currentTarget as HTMLElement;
    const tabs: DetailTab[] = ['overview', 'editor', 'evidence'];
    if (event.key === 'Home') detailTab = tabs[0];
    else if (event.key === 'End') detailTab = tabs.at(-1)!;
    else {
      const direction = event.key === 'ArrowRight' ? 1 : -1;
      detailTab = tabs[(tabs.indexOf(detailTab) + direction + tabs.length) % tabs.length];
    }
    void tick().then(() =>
      tablist.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus(),
    );
  }

  function documentSpec(): SkillDocumentSpec {
    if (newFormat === 'markdown')
      return {
        kind: 'markdown',
        extension: 'md',
        renderer: 'markdown',
        mediaType: 'text/markdown',
      };
    if (newFormat === 'text')
      return { kind: 'text', extension: 'txt', renderer: 'plain', mediaType: 'text/plain' };
    if (newFormat === 'html')
      return { kind: 'html', extension: 'html', renderer: 'html', mediaType: 'text/html' };
    return {
      kind: 'custom',
      extension: normalizeExtension(newExtension),
      renderer: newRenderer,
      mediaType:
        newRenderer === 'html'
          ? 'text/html'
          : newRenderer === 'markdown'
            ? 'text/markdown'
            : 'text/plain',
    };
  }

  function conversionDocument(): SkillDocumentSpec {
    if (conversionTarget === 'markdown') {
      return {
        kind: 'markdown',
        extension: 'md',
        renderer: 'markdown',
        mediaType: 'text/markdown',
      };
    }
    if (conversionTarget === 'text') {
      return { kind: 'text', extension: 'txt', renderer: 'plain', mediaType: 'text/plain' };
    }
    if (conversionTarget === 'html') {
      return { kind: 'html', extension: 'html', renderer: 'html', mediaType: 'text/html' };
    }
    return {
      kind: 'custom',
      extension: normalizeExtension(conversionExtension),
      renderer: conversionRenderer,
      mediaType:
        conversionRenderer === 'html'
          ? 'text/html'
          : conversionRenderer === 'markdown'
            ? 'text/markdown'
            : 'text/plain',
    };
  }

  function resetCreatorForm() {
    newName = '';
    newSource = 'personal';
    newDescription = '';
    newFormat = 'markdown';
    newExtension = 'prompt';
    newRenderer = 'plain';
    newInstructions = '';
    newDomains = '';
    newTriggers = '';
    newPositive = '';
    newNegative = '';
    newEvidence = '';
    newBroader = '';
    newRequires = '';
    newConflicts = '';
    newExcludes = '';
    newTargetMedium = 'any';
    newContextBudget = 4000;
  }

  async function previewConversion() {
    if (!selectedSkill) return;
    conversionPreview = await agentSettingsStore.convertSkill(
      selectedSkill,
      conversionDocument(),
      true,
    );
  }

  async function confirmConversion() {
    if (!selectedSkill || !conversionPreview) return;
    const converted = await agentSettingsStore.convertSkill(
      selectedSkill,
      conversionPreview.targetDocument,
      false,
    );
    if (!converted?.draft) return;
    conversionPreview = null;
    selectedKey = revisionKey(converted.draft);
    detailTab = 'editor';
  }

  async function createSkill() {
    if (creatorIssues.length) return;
    const created = await agentSettingsStore.createSkillDraft({
      source: newSource,
      name: normalizeName(newName),
      description: newDescription.trim(),
      instructions: newInstructions.trim(),
      sourceContent: newInstructions.trim(),
      coreInstructions: newInstructions.trim(),
      document: documentSpec(),
      domains: splitLines(newDomains),
      activation: splitLines(newTriggers),
      shouldTrigger: splitLines(newPositive),
      shouldNotTrigger: splitLines(newNegative),
      evidence: splitLines(newEvidence),
      broader: splitLines(newBroader),
      requires: splitLines(newRequires),
      conflicts: splitLines(newConflicts),
      excludes: splitLines(newExcludes),
      targetMedia: [newTargetMedium],
      contextBudget: newContextBudget,
    });
    if (!created) return;
    creatorOpen = false;
    creatorStep = 1;
    resetCreatorForm();
    selectedKey = revisionKey(created);
    detailTab = 'editor';
    showDetailOnNarrow = true;
    liveStatus = `${created.name} draft created`;
  }

  async function openRevisionComparison() {
    if (!selectedSkill) return;
    if (await agentSettingsStore.compareSkillDraft(selectedSkill)) {
      rememberModalTrigger();
      comparisonMode = 'revision';
      focusModal('[aria-label="Close comparison"]');
    }
  }

  async function openBundledComparison() {
    if (!selectedSkill) return;
    if (await agentSettingsStore.compareBundledSkill(selectedSkill)) {
      rememberModalTrigger();
      comparisonMode = 'bundled';
      focusModal('[aria-label="Close comparison"]');
    }
  }

  async function applyBundledUpdate(
    choice: 'replace' | 'merge' | 'keep-local' | 'merge-with-agent',
  ) {
    if (!selectedSkill || selectedBuffer?.dirty) return;
    const updated = await agentSettingsStore.applyBundledSkillUpdate(selectedSkill, choice);
    if (!updated) return;
    closeComparison();
    selectedKey = revisionKey(updated);
    if (updated.state === 'draft') detailTab = 'editor';
    liveStatus =
      updated.state === 'draft'
        ? `${updated.name} update saved as an inactive draft`
        : `${updated.name} bundled update choice applied`;
  }

  onMount(() => {
    const keydown = (event: KeyboardEvent) => {
      if (!active) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void saveSelected();
      }
    };
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!Object.values(buffers).some((buffer) => buffer.dirty) && !creatorDirty) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('keydown', keydown);
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      window.removeEventListener('keydown', keydown);
      window.removeEventListener('beforeunload', beforeUnload);
      window.dispatchEvent(
        new CustomEvent('koryphaios:skills-dirty', { detail: { dirty: false } }),
      );
    };
  });
</script>

<div class="skills-shell">
  <header class="skills-header">
    <div class="min-w-0">
      <h2>Skills workspace</h2>
      <p>
        {activeSkillCount} active · {agentSettingsStore.skills.length} revisions{unsavedCount
          ? ` · ${unsavedCount} unsaved`
          : ''}
      </p>
    </div>
    <div class="header-actions">
      <button class="secondary-action" type="button" onclick={openRoutingTool}
        ><FlaskConical size={17} />Test routing</button
      >
      <button
        class="primary-action"
        type="button"
        onclick={() => {
          creatorOpen = true;
          showDetailOnNarrow = true;
        }}
        ><Plus size={18} />New skill</button
      >
    </div>
  </header>

  <div class="workspace-body">
    <aside
      class:hidden-on-narrow={showDetailOnNarrow}
      class="skill-library"
      aria-label="Skill library"
    >
      <div class="library-tools">
        <label class="search-field">
          <Search size={17} />
          <input
            bind:value={searchQuery}
            aria-label="Search skills"
            placeholder="Search all skills"
          />
        </label>
        <div class="filter-grid">
          <KorySelect
            compact
            value={sourceFilter}
            label="Filter by skill source"
            options={[
              { value: 'all', label: 'All sources' },
              { value: 'personal', label: 'Personal' },
              { value: 'project', label: 'Project' },
            ]}
            onchange={(value) => (sourceFilter = value)}
          />
          <KorySelect
            compact
            value={statusFilter}
            label="Filter by skill status"
            options={[
              { value: 'all', label: 'All states' },
              { value: 'draft', label: 'Drafts' },
              { value: 'active', label: 'Active' },
              { value: 'updates', label: 'Updates' },
              { value: 'invalid', label: 'Needs attention' },
            ]}
            onchange={(value) => (statusFilter = value)}
          />
        </div>
      </div>
      <div class="library-scroll">
        {#each groupedSkills as [group, skills] (group)}
          <section class="library-group">
            <h3>{group}<span>{skills.length}</span></h3>
            {#each skills as skill (revisionKey(skill))}
              <button
                type="button"
                class:selected={selectedSkill && revisionKey(selectedSkill) === revisionKey(skill)}
                class="skill-row"
                onclick={() => selectSkill(skill)}
              >
                <span class="skill-row-main"
                  ><strong>{skill.name}</strong><small>{skill.description}</small></span
                >
                <span class="skill-row-meta">
                  {#if buffers[revisionKey(skill)]?.dirty}<span
                      class="dirty-dot"
                      title="Unsaved changes">Unsaved</span
                    >{/if}
                  <span>{skill.document?.extension?.toUpperCase() ?? 'MD'}</span><span
                    >{skill.source}</span
                  >
                </span>
              </button>
            {/each}
          </section>
        {:else}
          <div class="empty-library">No skills match these filters.</div>
        {/each}
      </div>
    </aside>

    <section
      class:hidden-on-narrow={!showDetailOnNarrow}
      class="skill-detail"
      aria-label="Skill detail workspace"
    >
      {#if creatorOpen}
        {@render creatorPane()}
      {:else if selectedSkill}
        <div class="detail-heading">
          <button class="back-action" type="button" onclick={() => (showDetailOnNarrow = false)}
            ><ArrowLeft size={17} />Library</button
          >
          <div class="detail-title">
            <h2>{selectedSkill.name}</h2>
            <p>{selectedSkill.description}</p>
          </div>
          <div class="detail-actions">
            <button
              type="button"
              class="secondary-action"
              disabled={!selectedBuffer?.dirty}
              onclick={() => {
                const key = revisionKey(selectedSkill);
                buffers = {
                  ...buffers,
                  [key]: {
                    sourceContent:
                      selectedSkill.storageVersion === 2
                        ? selectedSkill.sourceContent
                        : selectedSkill.content,
                    coreInstructions: selectedSkill.coreInstructions,
                    dirty: false,
                  },
                };
              }}>Reset</button
            >
            <button
              type="button"
              class="primary-action"
              disabled={!selectedBuffer?.dirty}
              onclick={() => void saveSelected()}><Save size={17} />Save draft</button
            >
          </div>
        </div>

        <div
          class="detail-tabs"
          role="tablist"
          tabindex="-1"
          aria-label="Skill details"
          onkeydown={handleTabKey}
        >
          {#each [{ id: 'overview', label: 'Overview' }, { id: 'editor', label: 'Editor' }, { id: 'evidence', label: 'Evidence' }] as tab (tab.id)}
            <button
              type="button"
              role="tab"
              aria-selected={detailTab === tab.id}
              tabindex={detailTab === tab.id ? 0 : -1}
              onclick={() => (detailTab = tab.id as DetailTab)}>{tab.label}</button
            >
          {/each}
        </div>

        <div class="detail-scroll">
          {#if detailTab === 'overview'}
            <div class="overview-grid">
              <section class="info-card">
                <span>Status</span><strong
                  >{selectedSkill.state === 'draft' ? 'Inactive draft' : 'Active'}</strong
                >
                <p>
                  {selectedSkill.validation.valid
                    ? 'The document contract is valid.'
                    : 'This revision needs attention before activation.'}
                </p>
              </section>
              <section class="info-card">
                <span>Native format</span><strong
                  >{selectedSkill.document.kind} · .{selectedSkill.document.extension}</strong
                >
                <p>
                  {selectedSkill.storageVersion === 1
                    ? 'Legacy Markdown; migrates only when you save or convert.'
                    : `${selectedSkill.document.renderer} rendering · ${selectedSkill.document.mediaType}`}
                </p>
              </section>
              <section class="info-card">
                <span>Scope</span><strong>{selectedSkill.source}</strong>
                <p>
                  {selectedSkill.source === 'personal'
                    ? 'Available across your workspaces.'
                    : 'Stored with this project.'}
                </p>
              </section>
              <section class="info-card">
                <span>Context budget</span><strong
                  >{selectedSkill.metadata.contextBudget.toLocaleString()} characters</strong
                >
                <p>Compact loading uses the format-neutral core instructions.</p>
              </section>
            </div>
            <section class="wide-card">
              <div>
                <h3>Routing contract</h3>
                <p>Triggers and boundaries decide when this local instruction set is loaded.</p>
              </div>
              <div class="chip-list">
                {#each selectedSkill.metadata.activation as item (item)}<span>Use: {item}</span
                  >{/each}{#each selectedSkill.metadata.excludes as item (item)}<span
                    class="warning-chip">Avoid: {item}</span
                  >{/each}
              </div>
            </section>
            <section class="wide-card">
              <div>
                <h3>Revision comparison</h3>
                <p>
                  Review active versus draft or compare a customized bundled skill with its update.
                </p>
              </div>
              <div class="card-actions">
                <button
                  type="button"
                  class="secondary-action"
                  onclick={() => void openRevisionComparison()}
                  ><FileDiff size={16} />Active vs draft</button
                >{#if selectedSkill.bundledUpdateAvailable}<button
                    type="button"
                    class="secondary-action"
                    disabled={Boolean(selectedBuffer?.dirty)}
                    onclick={() => void openBundledComparison()}>Bundled update</button
                  >{/if}
              </div>
            </section>
            <section class="wide-card conversion-card">
              <div>
                <h3>Change native format</h3>
                <p>
                  Conversion creates a reviewable draft. The active revision stays untouched until
                  validation and trigger tests pass.
                </p>
              </div>
              <div class="conversion-actions">
                <KorySelect
                  compact
                  value={conversionTarget}
                  label="Conversion target format"
                  options={[
                    { value: 'markdown', label: 'Markdown' },
                    { value: 'text', label: 'Plain text' },
                    { value: 'html', label: 'Sandboxed HTML' },
                    { value: 'custom', label: 'Custom extension' },
                  ]}
                  onchange={(value) => {
                    conversionTarget = value as SkillFormatKind;
                    conversionPreview = null;
                  }}
                />
                {#if conversionTarget === 'custom'}
                  <label class="conversion-field">
                    <span>Extension</span>
                    <input
                      value={conversionExtension}
                      oninput={(event) => {
                        conversionExtension = normalizeExtension(event.currentTarget.value);
                        conversionPreview = null;
                      }}
                      placeholder="rst"
                    />
                  </label>
                  <KorySelect
                    compact
                    value={conversionRenderer}
                    label="Custom preview behavior"
                    options={[
                      { value: 'plain', label: 'Plain text' },
                      { value: 'markdown', label: 'Markdown-like' },
                      { value: 'html', label: 'Sandboxed HTML' },
                    ]}
                    onchange={(value) => {
                      conversionRenderer = value as 'markdown' | 'plain' | 'html';
                      conversionPreview = null;
                    }}
                  />
                {/if}
                <button
                  type="button"
                  class="secondary-action"
                  disabled={Boolean(selectedBuffer?.dirty) ||
                    (conversionTarget === 'custom' &&
                      !isSafeCustomExtension(conversionExtension))}
                  onclick={() => void previewConversion()}>Preview conversion</button
                >
                {#if selectedBuffer?.dirty}<p class="conversion-blocked">
                    Save this revision before converting its native format.
                  </p>{/if}
              </div>
            </section>
            {#if conversionPreview}<section class="conversion-preview">
                <div class="conversion-warning">
                  <strong
                    >{conversionPreview.lossy
                      ? 'Lossy conversion'
                      : 'Source-preserving conversion'}</strong
                  >
                  <p>
                    {conversionPreview.warnings.join(' · ') ||
                      'No format-specific warnings were reported.'}
                  </p>
                </div>
                <div class="comparison-grid">
                  <div>
                    <h3>Before</h3>
                    <pre>{conversionPreview.sourceContent}</pre>
                  </div>
                  <div>
                    <h3>After</h3>
                    <pre>{conversionPreview.convertedContent}</pre>
                  </div>
                </div>
                <div class="conversion-confirm">
                  <button
                    type="button"
                    class="primary-action"
                    onclick={() => void confirmConversion()}>Create converted draft</button
                  >
                </div>
              </section>{/if}
          {:else if detailTab === 'editor'}
            <div class="editor-toolbar-row">
              <div class="mode-switch" aria-label="Editor mode">
                {#each ['visual', 'source', 'split'] as mode (mode)}<button
                    type="button"
                    class:active={editorMode === mode}
                    onclick={() => (editorMode = mode as EditorMode)}>{mode}</button
                  >{/each}
              </div>
              <span class="format-label"
                >{selectedSkill.document.kind} · .{selectedSkill.document.extension}</span
              >
            </div>
            {#if selectedSkill.storageVersion === 1}<div class="migration-note">
                This legacy SKILL.md remains untouched until you save or convert it. Source mode
                includes its frontmatter.
              </div>{/if}
            {#if editorMode === 'visual'}
              <div
                class="visual-editor"
                class:html-visual={selectedSkill.document.renderer === 'html'}
              >
                <SkillVisualEditor
                  value={previewSource(selectedSkill, selectedSource)}
                  format={selectedSkill.document.kind}
                  renderer={selectedSkill.document.renderer}
                  onchange={updateVisualSource}
                  onrequestsource={() => (editorMode = 'source')}
                  onstatus={(message) => (liveStatus = message)}
                  label={`Visual editor for ${selectedSkill.name}`}
                />
                {#if selectedSkill.document.renderer === 'html'}<div class="preview-pane">
                    <iframe
                      title="Sandboxed skill HTML preview"
                      sandbox=""
                      srcdoc={htmlPreview(previewSource(selectedSkill, selectedSource))}
                    ></iframe>
                  </div>{/if}
              </div>
            {:else if editorMode === 'source'}
              <div class="source-editor">
                <SkillCodeEditor
                  value={selectedSource}
                  language={selectedSkill.document.kind}
                  renderer={selectedSkill.document.renderer}
                  onchange={(value) => updateBuffer(value)}
                  ariaLabel="Exact skill source"
                />
              </div>
            {:else}
              <div class="split-editor">
                <div class="source-editor">
                  <SkillCodeEditor
                    value={selectedSource}
                    language={selectedSkill.document.kind}
                    renderer={selectedSkill.document.renderer}
                    onchange={(value) => updateBuffer(value)}
                    ariaLabel="Exact skill source"
                  />
                </div>
                <div class="preview-pane">
                  {#if selectedSkill.document.renderer === 'html'}<iframe
                      title="Sandboxed skill HTML preview"
                      sandbox=""
                      srcdoc={htmlPreview(previewSource(selectedSkill, selectedSource))}
                    ></iframe>{:else if selectedSkill.document.renderer === 'markdown'}<article
                      class="rendered-markdown"
                    >
                      {@html markdownPreview(previewSource(selectedSkill, selectedSource))}
                    </article>{:else}<pre>{previewSource(selectedSkill, selectedSource)}</pre>{/if}
                </div>
              </div>
            {/if}
            {#if selectedSkill.storageVersion === 2}<label class="core-editor"
                ><span>Compact context contract</span><textarea
                  value={selectedCore}
                  oninput={(event) => updateBuffer(selectedSource, event.currentTarget.value)}
                  aria-label="Format-neutral core instructions"
                ></textarea><small
                  >Compact and minimal loading use this text; full loading uses the native source
                  above.</small
                ></label
              >{/if}
          {:else}
            {@const evaluation =
              agentSettingsStore.skillEvaluationCards[
                `${selectedSkill.source}:${selectedSkill.name}:${selectedSkill.state}:${selectedSkill.hash}`
              ]}
            <div class="evidence-state {evaluation?.gate.status ?? 'unmeasured'}">
              <CheckCircle size={22} />
              <div>
                <h3>
                  {evaluation?.gate.status === 'ready'
                    ? 'Ready for activation'
                    : evaluation?.gate.status === 'blocked'
                      ? 'Activation blocked'
                      : evaluation?.gate.status === 'insufficient-evidence'
                        ? 'More evidence needed'
                        : 'Not measured'}
                </h3>
                <p>
                  {evaluation?.gate.reasons.join(' · ') ||
                    'No provider/model qualification evidence has been recorded for this revision.'}
                </p>
              </div>
            </div>
            <div class="overview-grid">
              <section class="info-card">
                <span>Trigger cases</span><strong>{evaluation?.cases.length ?? 0}</strong>
                <p>Positive and negative examples derived from visible routing metadata.</p>
              </section>
              <section class="info-card">
                <span>Observed runs</span><strong>{evaluation?.gate.candidateRuns ?? 0}</strong>
                <p>Evidence is never inferred from metadata alone.</p>
              </section>
              <section class="info-card">
                <span>Providers</span><strong>{evaluation?.gate.distinctProviders ?? 0}</strong>
                <p>Independent provider families represented.</p>
              </section>
              <section class="info-card">
                <span>Blind reviews</span><strong>{evaluation?.gate.humanBlindReviews ?? 0}</strong>
                <p>Human quality comparisons recorded.</p>
              </section>
            </div>
            {#if selectedSkill.state === 'draft'}<button
                type="button"
                class="activate-action"
                disabled={selectedSkillHasDirtyBuffer}
                onclick={() => void activateSelected()}
                >Validate triggers and activate</button
              >{#if selectedSkillHasDirtyBuffer}<p class="activation-blocked">
                  Save or reset every unsaved revision of this skill before activation.
                </p>{/if}{/if}
          {/if}
        </div>
      {:else}<div class="empty-detail">No local skills found.</div>{/if}
    </section>
  </div>
</div>

{#if routingOpen}<div class="tool-overlay" role="presentation">
    <div
      class="tool-panel"
      role="dialog"
      tabindex="-1"
      aria-modal="true"
      aria-labelledby="routing-title"
      onkeydown={(event) => handleDialogKey(event, closeRoutingTool)}
    >
      <div class="tool-title">
        <div>
          <h2 id="routing-title">Test routing</h2>
          <p>Preview local skill selection without changing the current agent run.</p>
        </div>
        <button type="button" aria-label="Close routing test" onclick={closeRoutingTool}
          ><X size={20} /></button
        >
      </div>
      <div class="routing-input">
        <input
          id="routing-prompt"
          aria-label="Task to test"
          placeholder="Describe a task to test…"
          onkeydown={(event) => {
            if (event.key === 'Enter') {
              const value = event.currentTarget.value.trim();
              if (value) void agentSettingsStore.previewSkillResolution(value, {});
            }
          }}
        /><button
          type="button"
          class="primary-action"
          onclick={() => {
            const input = document.getElementById('routing-prompt') as HTMLInputElement | null;
            if (input?.value.trim())
              void agentSettingsStore.previewSkillResolution(input.value.trim(), {});
          }}>Run test</button
        >
      </div>
      {#if agentSettingsStore.skillResolutionPreview}{@const preview =
          agentSettingsStore.skillResolutionPreview}
        <div class="routing-result" aria-live="polite">
          <strong
            >{preview.blocked
              ? 'Routing needs a decision'
              : `${preview.selected.length} skills selected`}</strong
          >
          <p>
            {preview.totalContextCost.toLocaleString()} of {preview.contextBudget.toLocaleString()} context
            characters
          </p>
          <div class="chip-list">
            {#each preview.selected as item (item.skill.hash)}<span
                >{item.skill.name} · {item.representation}</span
              >{/each}
          </div>
          {#if preview.rejectedCandidates.length}<details>
              <summary>Why other skills were skipped</summary
              >{#each preview.rejectedCandidates as item (item.name)}<p>
                  <strong>{item.name}</strong> — {item.reason}
                </p>{/each}
            </details>{/if}
        </div>{/if}
    </div>
  </div>{/if}

{#snippet creatorPane()}<div class="creator-workspace">
    <div class="creator-panel" role="region" aria-labelledby="creator-title">
      <div class="tool-title">
        <div>
          <h2 id="creator-title">New skill</h2>
          <p>Step {creatorStep} of 3 · saved as an inactive draft</p>
        </div>
        <button type="button" aria-label="Close skill creator" onclick={() => (creatorOpen = false)}
          ><X size={20} /></button
        >
      </div>
      <div class="stepper" aria-label="Creation progress">
        {#each ['Basics', 'Behavior', 'Advanced'] as label, index (label)}<span
            class:active={creatorStep === index + 1}>{index + 1}. {label}</span
          >{/each}
      </div>
      <div class="creator-scroll">
        {#if creatorStep === 1}<div class="form-grid">
            <label
              ><span>Name</span><input
                value={newName}
                oninput={(event) => (newName = normalizeName(event.currentTarget.value))}
                placeholder="release-notes-review"
              /></label
            ><label
              ><span>Scope</span><KorySelect
                value={newSource}
                label="Skill scope"
                options={[
                  {
                    value: 'personal',
                    label: 'Personal',
                    description: 'Available across workspaces',
                  },
                  { value: 'project', label: 'Project', description: 'Stored with this workspace' },
                ]}
                onchange={(value) => (newSource = value as 'personal' | 'project')}
              /></label
            ><label class="full"
              ><span>Description</span><textarea
                bind:value={newDescription}
                rows="3"
                placeholder="Explain what this skill does and when an agent should use it."
              ></textarea><small>{newDescription.trim().length}/40 minimum</small></label
            ><label
              ><span>File format</span><KorySelect
                value={newFormat}
                label="Skill file format"
                options={[
                  {
                    value: 'markdown',
                    label: 'Markdown',
                    description: 'Recommended for structured instructions',
                  },
                  { value: 'text', label: 'Plain text' },
                  { value: 'html', label: 'Sandboxed HTML' },
                  { value: 'custom', label: 'Custom extension' },
                ]}
                onchange={(value) => (newFormat = value as SkillFormatKind)}
              /></label
            >{#if newFormat === 'custom'}<label
                ><span>Extension</span><input
                  value={newExtension}
                  oninput={(event) =>
                    (newExtension = normalizeExtension(event.currentTarget.value))}
                  placeholder="rst"
                /></label
              ><label
                ><span>Preview behavior</span><KorySelect
                  value={newRenderer}
                  label="Custom preview behavior"
                  options={[
                    { value: 'plain', label: 'Plain text' },
                    { value: 'markdown', label: 'Markdown-like' },
                    { value: 'html', label: 'Sandboxed HTML' },
                  ]}
                  onchange={(value) => (newRenderer = value as 'markdown' | 'plain' | 'html')}
                /></label
              >{/if}
          </div>
        {:else if creatorStep === 2}<div class="form-grid">
            <label class="full"
              ><span>Required operating instructions</span><textarea
                bind:value={newInstructions}
                rows="8"
                placeholder="Describe the workflow, decisions, safety boundaries, and verification steps."
              ></textarea></label
            ><label
              ><span>Professional domains</span><textarea
                bind:value={newDomains}
                rows="3"
                placeholder="release\ncommunication"
              ></textarea></label
            ><label
              ><span>Routing phrases</span><textarea
                bind:value={newTriggers}
                rows="3"
                placeholder="release notes\nchangelog review"
              ></textarea></label
            ><label
              ><span>Should use this skill</span><textarea
                bind:value={newPositive}
                rows="4"
                placeholder="One example per line; add at least two."
              ></textarea></label
            ><label
              ><span>Should not use this skill</span><textarea
                bind:value={newNegative}
                rows="4"
                placeholder="One example per line; add at least two."
              ></textarea></label
            ><label class="full"
              ><span>Completion evidence</span><textarea
                bind:value={newEvidence}
                rows="3"
                placeholder="What proves the task was completed correctly?"
              ></textarea></label
            >
          </div>
        {:else}<div class="form-grid">
            <label
              ><span>Broader skills</span><textarea
                bind:value={newBroader}
                rows="3"
                placeholder="Optional skill IDs"
              ></textarea></label
            ><label
              ><span>Required skills</span><textarea
                bind:value={newRequires}
                rows="3"
                placeholder="Optional dependencies"
              ></textarea></label
            ><label
              ><span>Conflicts</span><textarea
                bind:value={newConflicts}
                rows="3"
                placeholder="Skills that cannot run together"
              ></textarea></label
            ><label
              ><span>Do not use when</span><textarea
                bind:value={newExcludes}
                rows="3"
                placeholder="Exclusion phrases"
              ></textarea></label
            ><label
              ><span>Target medium</span><KorySelect
                value={newTargetMedium}
                label="Target medium"
                options={[
                  'any',
                  'web',
                  'native',
                  'mobile',
                  'terminal',
                  'game',
                  'spatial',
                  'embedded',
                ].map((value) => ({ value, label: value === 'any' ? 'Any medium' : value }))}
                onchange={(value) => (newTargetMedium = value)}
              /></label
            ><label
              ><span>Context budget</span><NumberStepper
                value={newContextBudget}
                min={100}
                max={20000}
                step={100}
                label="Context budget"
                onchange={(value) => (newContextBudget = value)}
              /></label
            >
          </div>{/if}
      </div>
      <div class="creator-footer">
        <div class="requirements" aria-live="polite">
          {#if creatorIssues.length}<strong>Still needed</strong><span
              >{creatorIssues.slice(0, 3).join(' · ')}</span
            >{:else}<strong>Ready to create</strong><span
              >The skill will remain inactive until validation and trigger tests pass.</span
            >{/if}
        </div>
        <div class="card-actions">
          {#if creatorStep > 1}<button
              type="button"
              class="secondary-action"
              onclick={() => (creatorStep = (creatorStep - 1) as 1 | 2)}>Back</button
            >{/if}{#if creatorStep < 3}<button
              type="button"
              class="primary-action"
              onclick={() => (creatorStep = (creatorStep + 1) as 2 | 3)}>Continue</button
            >{:else}<button
              type="button"
              class="primary-action"
              disabled={creatorIssues.length > 0}
              onclick={() => void createSkill()}>Create draft</button
            >{/if}
        </div>
      </div>
    </div>
  </div>{/snippet}

{#if comparisonMode}<div class="tool-overlay" role="presentation">
    <div
      class="comparison-panel"
      role="dialog"
      tabindex="-1"
      aria-modal="true"
      aria-labelledby="comparison-title"
      onkeydown={(event) => handleDialogKey(event, closeComparison)}
    >
      <div class="tool-title">
        <div>
          <h2 id="comparison-title">
            {comparisonMode === 'revision'
              ? 'Active and draft comparison'
              : 'Bundled update comparison'}
          </h2>
          <p>Review exact native contents before choosing an update.</p>
        </div>
        <button type="button" aria-label="Close comparison" onclick={closeComparison}
          ><X size={20} /></button
        >
      </div>
      {#if comparisonMode === 'revision' && agentSettingsStore.skillComparison}<div
          class="comparison-grid"
        >
          <div>
            <h3>
              Active · .{agentSettingsStore.skillComparison.activeDocument?.extension ?? 'md'}
            </h3>
            <pre>{agentSettingsStore.skillComparison.active}</pre>
          </div>
          <div>
            <h3>Draft · .{agentSettingsStore.skillComparison.draftDocument?.extension ?? 'md'}</h3>
            <pre>{agentSettingsStore.skillComparison.draft}</pre>
          </div>
        </div>{:else if comparisonMode === 'bundled' && agentSettingsStore.bundledComparison}<div
          class="comparison-grid"
        >
          <div>
            <h3
              >Local · .{agentSettingsStore.bundledComparison.localDocument?.extension ?? 'md'}</h3
            >
            <pre>{agentSettingsStore.bundledComparison.local}</pre>
          </div>
          <div>
            <h3
              >Bundled · .{agentSettingsStore.bundledComparison.bundledDocument?.extension ??
                'md'}</h3
            >
            <pre>{agentSettingsStore.bundledComparison.bundled}</pre>
          </div>
        </div>
        <div class="comparison-actions">
          <p>
            Replacing returns this skill to bundled Markdown. Both merge options create an inactive
            review draft in the current native format.
          </p>
          <div class="card-actions">
            <button
              type="button"
              class="secondary-action"
              onclick={() => void applyBundledUpdate('keep-local')}>Keep local</button
            >
            <button
              type="button"
              class="secondary-action"
              onclick={() => void applyBundledUpdate('merge')}>Merge to draft</button
            >
            <button
              type="button"
              class="secondary-action"
              disabled={agentSettingsStore.isMergingSkill}
              onclick={() => void applyBundledUpdate('merge-with-agent')}
              >{agentSettingsStore.isMergingSkill ? 'Merging…' : 'Agent merge to draft'}</button
            >
            <button
              type="button"
              class="replace-action"
              onclick={() => void applyBundledUpdate('replace')}>Replace with bundled Markdown</button
            >
          </div>
        </div>{/if}
    </div>
  </div>{/if}

<p class="sr-only" aria-live="polite">{liveStatus}</p>

<style>
  .skills-shell {
    display: flex;
    min-height: 0;
    height: 100%;
    flex-direction: column;
    background: var(--color-surface-0);
    color: var(--color-text-primary);
  }
  .skills-header,
  .detail-heading,
  .tool-title,
  .creator-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    border-bottom: 1px solid var(--color-border);
    background: var(--color-surface-2);
    padding: 14px 18px;
  }
  .skills-header h2,
  .detail-title h2,
  .tool-title h2 {
    font-size: 16px;
    font-weight: 700;
  }
  .skills-header p,
  .detail-title p,
  .tool-title p {
    margin-top: 3px;
    font-size: 13px;
    color: var(--color-text-muted);
  }
  .header-actions,
  .detail-actions,
  .card-actions {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .primary-action,
  .secondary-action,
  .activate-action {
    display: inline-flex;
    min-height: 40px;
    align-items: center;
    justify-content: center;
    gap: 8px;
    border-radius: 10px;
    padding: 0 14px;
    font-size: 13px;
    font-weight: 650;
    outline: none;
  }
  .primary-action {
    border: 1px solid var(--color-accent);
    background: var(--color-accent);
    color: var(--color-on-accent);
  }
  .secondary-action {
    border: 1px solid var(--color-border);
    background: var(--color-surface-1);
    color: var(--color-text-primary);
  }
  button:focus-visible,
  input:focus-visible,
  textarea:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 2px;
  }
  .primary-action:disabled,
  .secondary-action:disabled {
    cursor: not-allowed;
    border-color: var(--color-border);
    background: var(--color-surface-3);
    color: var(--color-text-muted);
  }
  .workspace-body {
    display: grid;
    min-height: 0;
    flex: 1;
    grid-template-columns: 320px minmax(0, 1fr);
  }
  .skill-library {
    display: flex;
    min-height: 0;
    flex-direction: column;
    border-right: 1px solid var(--color-border);
    background: var(--color-surface-1);
  }
  .library-tools {
    display: grid;
    gap: 10px;
    border-bottom: 1px solid var(--color-border);
    padding: 12px;
  }
  .search-field {
    display: flex;
    min-height: 42px;
    align-items: center;
    gap: 9px;
    border: 1px solid var(--color-border);
    border-radius: 10px;
    background: var(--color-surface-0);
    padding: 0 12px;
    color: var(--color-text-muted);
  }
  .search-field input {
    min-width: 0;
    flex: 1;
    background: transparent;
    font-size: 14px;
    color: var(--color-text-primary);
    outline: none;
  }
  .filter-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }
  .library-scroll,
  .detail-scroll,
  .creator-scroll {
    min-height: 0;
    overflow: auto;
  }
  .library-scroll {
    padding: 10px;
  }
  .library-group h3 {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 8px 6px;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--color-text-muted);
  }
  .library-group h3 span {
    border-radius: 999px;
    background: var(--color-surface-3);
    padding: 2px 7px;
  }
  .skill-row {
    display: flex;
    width: 100%;
    min-height: 64px;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    border: 1px solid transparent;
    border-radius: 10px;
    padding: 9px 10px;
    text-align: left;
  }
  .skill-row:hover {
    background: var(--color-surface-2);
  }
  .skill-row.selected {
    border-color: var(--color-accent);
    background: var(--color-surface-3);
  }
  .skill-row-main {
    min-width: 0;
  }
  .skill-row-main strong {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: 14px;
  }
  .skill-row-main small {
    display: -webkit-box;
    margin-top: 3px;
    overflow: hidden;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 1;
    line-clamp: 1;
    font-size: 12px;
    color: var(--color-text-muted);
  }
  .skill-row-meta {
    display: flex;
    flex-shrink: 0;
    flex-direction: column;
    align-items: flex-end;
    gap: 3px;
    font-size: 11px;
    color: var(--color-text-muted);
  }
  .dirty-dot {
    color: var(--color-warning);
  }
  .empty-library,
  .empty-detail {
    display: grid;
    min-height: 180px;
    place-items: center;
    padding: 24px;
    font-size: 14px;
    color: var(--color-text-muted);
  }
  .skill-detail {
    display: flex;
    min-width: 0;
    min-height: 0;
    flex-direction: column;
  }
  .creator-workspace {
    display: flex;
    min-height: 0;
    flex: 1;
    flex-direction: column;
  }
  .creator-workspace .creator-panel {
    width: 100%;
    height: 100%;
    max-height: none;
    border: 0;
    border-radius: 0;
    box-shadow: none;
  }
  .back-action {
    display: none;
    min-height: 40px;
    align-items: center;
    gap: 7px;
    color: var(--color-text-secondary);
  }
  .detail-title {
    min-width: 0;
    flex: 1;
  }
  .detail-title p {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .detail-tabs {
    display: flex;
    gap: 4px;
    border-bottom: 1px solid var(--color-border);
    padding: 0 18px;
  }
  .detail-tabs button {
    min-height: 44px;
    border-bottom: 2px solid transparent;
    padding: 0 14px;
    font-size: 14px;
    color: var(--color-text-muted);
  }
  .detail-tabs button[aria-selected='true'] {
    border-color: var(--color-accent);
    color: var(--color-text-primary);
  }
  .detail-scroll {
    padding: 18px;
  }
  .overview-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 12px;
  }
  .info-card,
  .wide-card {
    border: 1px solid var(--color-border);
    border-radius: 14px;
    background: var(--color-surface-1);
    padding: 16px;
  }
  .info-card span {
    font-size: 12px;
    color: var(--color-text-muted);
  }
  .info-card strong {
    display: block;
    margin-top: 7px;
    font-size: 15px;
  }
  .info-card p,
  .wide-card p {
    margin-top: 7px;
    font-size: 13px;
    line-height: 1.5;
    color: var(--color-text-muted);
  }
  .wide-card {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 18px;
    margin-top: 12px;
  }
  .wide-card h3,
  .evidence-state h3 {
    font-size: 15px;
    font-weight: 700;
  }
  .chip-list {
    display: flex;
    flex-wrap: wrap;
    gap: 7px;
  }
  .chip-list span {
    border-radius: 999px;
    background: var(--color-surface-3);
    padding: 6px 9px;
    font-size: 12px;
    color: var(--color-text-secondary);
  }
  .chip-list .warning-chip {
    background: var(--color-warning-bg);
    color: var(--color-warning);
  }
  .conversion-actions {
    display: grid;
    min-width: 230px;
    gap: 8px;
  }
  .conversion-field span {
    display: block;
    margin-bottom: 5px;
    font-size: 12px;
    font-weight: 650;
    color: var(--color-text-secondary);
  }
  .conversion-field input {
    min-height: 40px;
    width: 100%;
    border: 1px solid var(--color-border);
    border-radius: 9px;
    background: var(--color-surface-1);
    padding: 0 11px;
    font-size: 14px;
    color: var(--color-text-primary);
  }
  .conversion-blocked,
  .activation-blocked {
    font-size: 12px;
    line-height: 1.45;
    color: var(--color-warning);
  }
  .conversion-preview {
    margin-top: 12px;
    overflow: hidden;
    border: 1px solid var(--color-border);
    border-radius: 14px;
    background: var(--color-surface-1);
  }
  .conversion-warning,
  .conversion-confirm {
    padding: 14px 16px;
  }
  .conversion-warning {
    border-bottom: 1px solid var(--color-border);
  }
  .conversion-warning p {
    margin-top: 5px;
    font-size: 13px;
    color: var(--color-text-muted);
  }
  .conversion-confirm {
    display: flex;
    justify-content: flex-end;
    border-top: 1px solid var(--color-border);
  }
  .editor-toolbar-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 12px;
  }
  .mode-switch {
    display: flex;
    border: 1px solid var(--color-border);
    border-radius: 10px;
    background: var(--color-surface-1);
    padding: 3px;
  }
  .mode-switch button {
    min-height: 40px;
    border-radius: 7px;
    padding: 0 13px;
    font-size: 13px;
    text-transform: capitalize;
    color: var(--color-text-muted);
  }
  .mode-switch button.active {
    background: var(--color-surface-3);
    color: var(--color-text-primary);
  }
  .format-label {
    font-size: 12px;
    color: var(--color-text-muted);
  }
  .migration-note {
    margin-bottom: 12px;
    border: 1px solid var(--color-warning);
    border-radius: 10px;
    background: var(--color-warning-bg);
    padding: 10px 12px;
    font-size: 13px;
    color: var(--color-warning);
  }
  .split-editor {
    display: grid;
    min-height: 430px;
    grid-template-columns: 1fr 1fr;
    border: 1px solid var(--color-border);
    border-radius: 14px;
    overflow: hidden;
    background: var(--color-surface-1);
  }
  .visual-editor {
    min-height: 430px;
  }
  .visual-editor :global(.skill-visual-editor) {
    min-height: 430px;
  }
  .visual-editor.html-visual {
    display: grid;
    grid-template-columns: 1fr 1fr;
    border: 1px solid var(--color-border);
    border-radius: 14px;
    overflow: hidden;
    background: var(--color-surface-1);
  }
  .visual-editor.html-visual :global(.skill-visual-editor) {
    border: 0;
    border-right: 1px solid var(--color-border);
    border-radius: 0;
  }
  .source-editor {
    min-height: 430px;
    background: var(--color-surface-0);
  }
  .source-editor {
    width: 100%;
    overflow: hidden;
    border: 1px solid var(--color-border);
    border-radius: 14px;
  }
  .source-editor :global(.skill-code-editor) {
    min-height: 430px;
    border: 0;
    border-radius: 0;
  }
  .split-editor .source-editor {
    border: 0;
    border-right: 1px solid var(--color-border);
    border-radius: 0;
  }
  .preview-pane {
    min-width: 0;
    overflow: auto;
    background: var(--color-surface-1);
    padding: 18px;
  }
  .preview-pane iframe {
    width: 100%;
    min-height: 390px;
    border: 0;
    background: var(--color-surface-0);
  }
  .preview-pane pre,
  .comparison-grid pre {
    white-space: pre-wrap;
    font: 13px/1.6 var(--font-mono, monospace);
    color: var(--color-text-secondary);
  }
  .comparison-actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    border-top: 1px solid var(--color-border);
    padding: 14px 16px;
  }
  .comparison-actions p {
    max-width: 42rem;
    font-size: 12px;
    line-height: 1.5;
    color: var(--color-text-muted);
  }
  .replace-action {
    min-height: 40px;
    border: 1px solid var(--color-warning);
    border-radius: 10px;
    background: var(--color-warning-bg);
    padding: 0 14px;
    color: var(--color-text-primary);
    font-size: 13px;
    font-weight: 650;
  }
  .rendered-markdown {
    font-size: 14px;
    line-height: 1.65;
  }
  .rendered-markdown :global(h1),
  .rendered-markdown :global(h2),
  .rendered-markdown :global(h3) {
    margin: 1em 0 0.5em;
    font-weight: 700;
  }
  .rendered-markdown :global(p),
  .rendered-markdown :global(ul),
  .rendered-markdown :global(ol) {
    margin: 0.65em 0;
  }
  .core-editor {
    display: block;
    margin-top: 14px;
  }
  .core-editor span {
    display: block;
    margin-bottom: 7px;
    font-size: 13px;
    font-weight: 650;
  }
  .core-editor textarea {
    min-height: 130px;
    width: 100%;
    resize: vertical;
    border: 1px solid var(--color-border);
    border-radius: 12px;
    background: var(--color-surface-1);
    padding: 13px;
    font-size: 14px;
    color: var(--color-text-primary);
  }
  .core-editor small {
    display: block;
    margin-top: 6px;
    font-size: 12px;
    color: var(--color-text-muted);
  }
  .evidence-state {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    border: 1px solid var(--color-border);
    border-radius: 14px;
    background: var(--color-surface-1);
    padding: 16px;
    margin-bottom: 12px;
  }
  .evidence-state p {
    margin-top: 5px;
    font-size: 13px;
    color: var(--color-text-muted);
  }
  .evidence-state.ready {
    border-color: var(--color-success);
    color: var(--color-success);
  }
  .evidence-state.blocked {
    border-color: var(--color-error);
    color: var(--color-error);
  }
  .activate-action {
    margin-top: 14px;
    border: 1px solid var(--color-success);
    background: var(--color-success);
    color: var(--color-on-success);
  }
  .activate-action:disabled {
    cursor: not-allowed;
    border-color: var(--color-border);
    background: var(--color-surface-3);
    color: var(--color-text-muted);
  }
  .activation-blocked {
    margin-top: 7px;
  }
  .tool-overlay {
    position: fixed;
    inset: 0;
    z-index: 150;
    display: grid;
    place-items: center;
    background: rgb(0 0 0 / 0.58);
    padding: 24px;
  }
  .tool-panel,
  .creator-panel,
  .comparison-panel {
    display: flex;
    max-height: min(820px, calc(100vh - 48px));
    width: min(820px, calc(100vw - 48px));
    flex-direction: column;
    overflow: hidden;
    border: 1px solid var(--color-border);
    border-radius: 18px;
    background: var(--color-surface-1);
    box-shadow: 0 24px 80px rgb(0 0 0 / 0.45);
  }
  .creator-panel,
  .comparison-panel {
    width: min(1040px, calc(100vw - 48px));
  }
  .tool-title button {
    display: grid;
    min-height: 40px;
    min-width: 40px;
    place-items: center;
    border-radius: 9px;
  }
  .routing-input {
    display: flex;
    gap: 10px;
    padding: 18px;
  }
  .routing-input input {
    min-height: 42px;
    min-width: 0;
    flex: 1;
    border: 1px solid var(--color-border);
    border-radius: 10px;
    background: var(--color-surface-0);
    padding: 0 13px;
    font-size: 14px;
    color: var(--color-text-primary);
  }
  .routing-result {
    margin: 0 18px 18px;
    border: 1px solid var(--color-border);
    border-radius: 14px;
    padding: 16px;
  }
  .routing-result > p {
    margin: 5px 0 12px;
    font-size: 13px;
    color: var(--color-text-muted);
  }
  .routing-result details {
    margin-top: 14px;
    font-size: 13px;
    color: var(--color-text-secondary);
  }
  .stepper {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    border-bottom: 1px solid var(--color-border);
  }
  .stepper span {
    padding: 13px 16px;
    text-align: center;
    font-size: 13px;
    color: var(--color-text-muted);
  }
  .stepper span.active {
    background: var(--color-surface-3);
    color: var(--color-text-primary);
  }
  .creator-scroll {
    padding: 18px;
  }
  .form-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
  }
  .form-grid label {
    display: block;
  }
  .form-grid label.full {
    grid-column: 1/-1;
  }
  .form-grid label > span {
    display: block;
    margin-bottom: 7px;
    font-size: 13px;
    font-weight: 650;
  }
  .form-grid input,
  .form-grid textarea {
    width: 100%;
    border: 1px solid var(--color-border);
    border-radius: 10px;
    background: var(--color-surface-0);
    padding: 11px 12px;
    font-size: 14px;
    color: var(--color-text-primary);
  }
  .form-grid textarea {
    resize: vertical;
  }
  .form-grid small {
    display: block;
    margin-top: 5px;
    font-size: 12px;
    color: var(--color-text-muted);
  }
  .creator-footer {
    border-top: 1px solid var(--color-border);
    border-bottom: 0;
  }
  .requirements {
    min-width: 0;
  }
  .requirements strong {
    display: block;
    font-size: 13px;
  }
  .requirements span {
    display: block;
    margin-top: 4px;
    font-size: 12px;
    color: var(--color-text-muted);
  }
  .comparison-grid {
    display: grid;
    min-height: 0;
    grid-template-columns: 1fr 1fr;
    overflow: auto;
  }
  .comparison-grid > div {
    min-width: 0;
    padding: 16px;
  }
  .comparison-grid > div + div {
    border-left: 1px solid var(--color-border);
  }
  .comparison-grid h3 {
    margin-bottom: 10px;
    font-size: 13px;
    font-weight: 700;
  }
  .comparison-grid pre {
    max-height: 620px;
    overflow: auto;
    border: 1px solid var(--color-border);
    border-radius: 10px;
    background: var(--color-surface-0);
    padding: 14px;
  }
  .hidden {
    display: none;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
  }
  @media (max-width: 1100px) {
    .overview-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
  @media (max-width: 1100px) {
    .workspace-body {
      display: block;
    }
    .skill-library,
    .skill-detail {
      height: 100%;
    }
    .hidden-on-narrow {
      display: none;
    }
    .back-action {
      display: inline-flex;
    }
    .detail-heading {
      align-items: flex-start;
      flex-wrap: wrap;
    }
    .detail-actions {
      margin-left: auto;
    }
    .visual-editor.html-visual,
    .split-editor {
      grid-template-columns: 1fr;
    }
    .visual-editor.html-visual :global(.skill-visual-editor),
    .split-editor .source-editor {
      border-right: 0;
      border-bottom: 1px solid var(--color-border);
    }
    .wide-card {
      align-items: flex-start;
      flex-direction: column;
    }
  }
  @media (max-width: 640px) {
    .skills-header {
      align-items: flex-start;
      flex-direction: column;
    }
    .header-actions {
      width: 100%;
    }
    .header-actions button {
      flex: 1;
    }
    .overview-grid,
    .form-grid,
    .comparison-grid {
      grid-template-columns: 1fr;
    }
    .form-grid label.full {
      grid-column: auto;
    }
    .comparison-grid > div + div {
      border-top: 1px solid var(--color-border);
      border-left: 0;
    }
    .comparison-actions,
    .comparison-actions .card-actions {
      align-items: stretch;
      flex-direction: column;
    }
    .tool-overlay {
      padding: 10px;
    }
    .tool-panel,
    .creator-panel,
    .comparison-panel {
      width: calc(100vw - 20px);
      max-height: calc(100vh - 20px);
    }
    .creator-footer {
      align-items: flex-start;
      flex-direction: column;
    }
    .detail-scroll {
      padding: 12px;
    }
  }
</style>
