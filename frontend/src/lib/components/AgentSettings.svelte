<script lang="ts">
  import {
    agentSettingsStore,
    DEFAULT_AGENT_SETTINGS,
    DEFAULT_SANDBOX_SETTINGS,
  } from '$lib/stores/agent-settings.svelte';
  import SettingsSwitch from './SettingsSwitch.svelte';
  import SettingsToggle from './SettingsToggle.svelte';
  import { providersStore } from '$lib/stores/providers.svelte';
  import NumberStepper from './NumberStepper.svelte';
  import KorySelect from './KorySelect.svelte';
  import SettingsPageIntro from './SettingsPageIntro.svelte';
  import ConfirmDialog from './ConfirmDialog.svelte';
  import { goalDisplayStore } from '$lib/stores/goal-display.svelte';
  import Bot from 'lucide-svelte/icons/bot';
  import Shield from 'lucide-svelte/icons/shield';
  import FileText from 'lucide-svelte/icons/file-text';
  import AlertTriangle from 'lucide-svelte/icons/alert-triangle';
  import CheckCircle from 'lucide-svelte/icons/check-circle';
  import XCircle from 'lucide-svelte/icons/x-circle';
  import Save from 'lucide-svelte/icons/save';
  import RotateCcw from 'lucide-svelte/icons/rotate-ccw';
  import Plus from 'lucide-svelte/icons/plus';
  import Gavel from 'lucide-svelte/icons/gavel';
  import Eye from 'lucide-svelte/icons/eye';
  import EyeOff from 'lucide-svelte/icons/eye-off';
  import AlertOctagon from 'lucide-svelte/icons/alert-octagon';
  import FlaskConical from 'lucide-svelte/icons/flask-conical';
  import Globe from 'lucide-svelte/icons/globe';
  import ChevronRight from 'lucide-svelte/icons/chevron-right';
  import StickyNote from 'lucide-svelte/icons/sticky-note';
  import Wrench from 'lucide-svelte/icons/wrench';
  import LockKeyhole from 'lucide-svelte/icons/lock-keyhole';
  import GitBranch from 'lucide-svelte/icons/git-branch';
  import Brain from 'lucide-svelte/icons/brain';
  import Route from 'lucide-svelte/icons/route';
  import Search from 'lucide-svelte/icons/search';
  import Boxes from 'lucide-svelte/icons/boxes';
  import Users from 'lucide-svelte/icons/users';

  // Props
  interface Props {
    onClose?: () => void;
    focusPermissions?: boolean;
  }

  let { onClose, focusPermissions = false }: Props = $props();

  type ControlSection = 'permissions' | 'quality' | 'workflow' | 'context' | 'research' | 'routing';
  let selectedControlSection = $state<ControlSection>('permissions');

  const CONTROL_SECTIONS = [
    {
      id: 'permissions',
      label: 'Permissions & autonomy',
      description: 'Approvals and change limits',
      icon: LockKeyhole,
    },
    {
      id: 'quality',
      label: 'Quality & Critic',
      description: 'Review and verification',
      icon: Gavel,
    },
    { id: 'workflow', label: 'Workflow', description: 'Planning and learning', icon: GitBranch },
    {
      id: 'context',
      label: 'Context & memory',
      description: 'Context and persistence',
      icon: Brain,
    },
    { id: 'research', label: 'Research', description: 'Search and source policy', icon: Search },
    {
      id: 'routing',
      label: 'Routing & guidance',
      description: 'Models and manager notes',
      icon: Route,
    },
  ] as const;

  $effect(() => {
    if (!focusPermissions) return;
    selectedControlSection = 'permissions';
  });

  // Local state for preferences editing
  let preferencesContent = $state(agentSettingsStore.preferences?.content ?? '');
  let preferencesDirty = $state(false);
  let selectedSkillKey = $state('');
  let skillDraftContent = $state('');
  let skillDraftDirty = $state(false);
  let skillPreviewPrompt = $state('');
  let skillCollisionChoices = $state<Record<string, 'personal' | 'project'>>({});
  let showSkillComparison = $state(false);
  let showBundledComparison = $state(false);
  let showSkillCreator = $state(false);
  let newSkillSource = $state<'personal' | 'project'>('personal');
  let newSkillName = $state('');
  let newSkillDescription = $state('');
  let newSkillDomains = $state('');
  let newSkillTriggers = $state('');
  let newSkillPositiveExample = $state('');
  let newSkillNegativeExample = $state('');
  let newSkillEvidence = $state('');
  let newSkillInstructions = $state('');
  let newSkillBroader = $state<string[]>([]);
  let newSkillFacets = $state<string[]>([]);
  let newSkillRequires = $state<string[]>([]);
  let newSkillConflicts = $state<string[]>([]);
  let newSkillExcludes = $state('');
  let newSkillTargetMedia = $state<string[]>(['any']);
  let newSkillDepth = $state(0);
  let newSkillContextBudget = $state(4000);
  let showModelAccess = $state(false);
  let showResetConfirmation = $state(false);

  const splitSkillLines = (value: string) =>
    value
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean);

  function normalizeSkillName(value: string) {
    return value
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64);
  }

  function skillRelationOptions(selected: string[]) {
    const ownName = normalizeSkillName(newSkillName);
    const seen = new Set<string>();
    const usedRelations = new Set([
      ...newSkillBroader,
      ...newSkillFacets,
      ...newSkillRequires,
      ...newSkillConflicts,
    ]);
    return agentSettingsStore.skills
      .filter((skill) => {
        if (
          skill.state !== 'active' ||
          skill.name === ownName ||
          selected.includes(skill.name) ||
          usedRelations.has(skill.name) ||
          seen.has(skill.name)
        ) {
          return false;
        }
        seen.add(skill.name);
        return true;
      })
      .map((skill) => ({
        value: skill.name,
        label: skill.name,
        description: skill.description,
      }))
      .sort((left, right) => left.label.localeCompare(right.label));
  }

  function expectedSkillDepth(broader: string[]) {
    if (broader.length === 0) return 0;
    const depths = broader.map(
      (name) =>
        agentSettingsStore.skills.find((skill) => skill.state === 'active' && skill.name === name)
          ?.metadata.depth ?? 0,
    );
    return Math.max(...depths) + 1;
  }

  function addBroader(value: string) {
    newSkillBroader = [...new Set([...newSkillBroader, value])];
    newSkillDepth = expectedSkillDepth(newSkillBroader);
  }

  function removeBroader(value: string) {
    newSkillBroader = newSkillBroader.filter((name) => name !== value);
    newSkillDepth = expectedSkillDepth(newSkillBroader);
  }

  function addTargetMedium(value: string) {
    newSkillTargetMedia =
      value === 'any'
        ? ['any']
        : [...new Set([...newSkillTargetMedia.filter((medium) => medium !== 'any'), value])];
  }

  async function createSkill() {
    const created = await agentSettingsStore.createSkillDraft({
      source: newSkillSource,
      name: normalizeSkillName(newSkillName),
      description: newSkillDescription.trim(),
      instructions: newSkillInstructions.trim(),
      domains: splitSkillLines(newSkillDomains),
      activation: splitSkillLines(newSkillTriggers),
      shouldTrigger: splitSkillLines(newSkillPositiveExample),
      shouldNotTrigger: splitSkillLines(newSkillNegativeExample),
      evidence: splitSkillLines(newSkillEvidence),
      broader: newSkillBroader,
      facets: newSkillFacets,
      requires: newSkillRequires,
      conflicts: newSkillConflicts,
      excludes: splitSkillLines(newSkillExcludes),
      targetMedia: newSkillTargetMedia,
      depth: newSkillDepth,
      contextBudget: newSkillContextBudget,
    });
    if (!created) return;
    selectedSkillKey = `${created.source}:${created.name}:${created.state}`;
    skillDraftDirty = false;
    showSkillCreator = false;
    newSkillName = '';
    newSkillDescription = '';
    newSkillDomains = '';
    newSkillTriggers = '';
    newSkillPositiveExample = '';
    newSkillNegativeExample = '';
    newSkillEvidence = '';
    newSkillInstructions = '';
    newSkillBroader = [];
    newSkillFacets = [];
    newSkillRequires = [];
    newSkillConflicts = [];
    newSkillExcludes = '';
    newSkillTargetMedia = ['any'];
    newSkillDepth = 0;
    newSkillContextBudget = 4000;
  }

  async function runSkillPreview() {
    if (!skillPreviewPrompt.trim()) return;
    await agentSettingsStore.previewSkillResolution(
      skillPreviewPrompt.trim(),
      skillCollisionChoices,
    );
  }

  async function compareSelectedSkill() {
    if (!selectedSkill) return;
    showSkillComparison = await agentSettingsStore.compareSkillDraft(selectedSkill);
  }

  async function compareSelectedSkillWithBundled() {
    if (!selectedSkill) return;
    showBundledComparison = await agentSettingsStore.compareBundledSkill(selectedSkill);
  }

  async function saveSelectedSkillDraft() {
    if (!selectedSkill) return;
    if (await agentSettingsStore.saveSkillDraft(selectedSkill, skillDraftContent))
      skillDraftDirty = false;
  }

  const selectedSkill = $derived(
    agentSettingsStore.skills.find(
      (skill) => `${skill.source}:${skill.name}:${skill.state}` === selectedSkillKey,
    ) ??
      agentSettingsStore.skills.find((skill) => skill.state === 'draft') ??
      agentSettingsStore.skills[0],
  );
  const selectedSkillQualifications = $derived(
    selectedSkill
      ? agentSettingsStore.skillQualifications.filter(
          (record) => record.skill === selectedSkill.name,
        )
      : [],
  );
  const selectedSkillEvaluation = $derived(
    selectedSkill
      ? agentSettingsStore.skillEvaluationCards[
          `${selectedSkill.source}:${selectedSkill.name}:${selectedSkill.state}:${selectedSkill.hash}`
        ]
      : undefined,
  );
  const activeSkillCount = $derived(
    agentSettingsStore.skills.filter((skill) => skill.state === 'active' && skill.validation.valid)
      .length,
  );
  $effect(() => {
    if (selectedSkill && !skillDraftDirty && skillDraftContent !== selectedSkill.content)
      skillDraftContent = selectedSkill.content;
  });
  $effect(() => {
    if (selectedSkill) void agentSettingsStore.loadSkillEvaluationCard(selectedSkill);
  });

  // Sync preferences content
  $effect(() => {
    if (agentSettingsStore.preferences && !preferencesDirty) {
      preferencesContent = agentSettingsStore.preferences.content;
    }
  });

  // ── Manager model access ────────────────────────────────────────────────
  const MODEL_ACCESS_CATEGORIES = [
    {
      id: 'general',
      label: 'General chat & orchestration',
      notesPlaceholder:
        'e.g. State the plan for multi-step work. Keep the manager informed of real blockers.',
    },
    {
      id: 'frontend',
      label: 'Frontend work',
      notesPlaceholder:
        'e.g. Reuse Koryphaios components and theme tokens. Check keyboard and narrow-window states.',
    },
    {
      id: 'backend',
      label: 'Backend work',
      notesPlaceholder:
        'e.g. Preserve API contracts. Add focused route tests and fail closed on missing authorization.',
    },
    {
      id: 'review',
      label: 'Review',
      notesPlaceholder:
        'e.g. Prioritize correctness, regressions, and security. Report findings with paths and severity.',
    },
    {
      id: 'test',
      label: 'Testing',
      notesPlaceholder:
        'e.g. Run focused tests first, then the relevant integration gate. Cover failure states too.',
    },
    {
      id: 'critic',
      label: 'Critic',
      notesPlaceholder:
        'e.g. Challenge unsupported claims and missing evidence. Pass only proven acceptance criteria.',
    },
  ];
  const availableModels = $derived.by(() =>
    providersStore.statusList
      .filter((p) => p.enabled && (p.adapterAvailable ?? p.authenticated))
      .flatMap((p) => (p.selectedModels?.length ? p.selectedModels : (p.models ?? [])))
      .filter((m, i, all) => all.indexOf(m) === i),
  );

  function modelsFor(category: string): string[] {
    return agentSettingsStore.settings.managerModelAccess?.[category] ?? [];
  }
  async function toggleCategoryModel(category: string, model: string) {
    const current = modelsFor(category);
    const next = current.includes(model) ? current.filter((m) => m !== model) : [...current, model];
    await agentSettingsStore.saveSettings({
      managerModelAccess: { ...agentSettingsStore.settings.managerModelAccess, [category]: next },
    });
  }

  const collapsedNotesGroups = $state<Record<string, boolean>>(
    Object.fromEntries(MODEL_ACCESS_CATEGORIES.map((c) => [c.id, true] as const)) as Record<
      string,
      boolean
    >,
  );
  const notesDrafts = $state<Record<string, { text: string; dirty: boolean }>>(
    Object.fromEntries(
      MODEL_ACCESS_CATEGORIES.map(
        (c) => [c.id, { text: '', dirty: false }] as [string, { text: string; dirty: boolean }],
      ),
    ) as Record<string, { text: string; dirty: boolean }>,
  );
  $effect(() => {
    const allNotes = (agentSettingsStore.settings.managerNotes ?? {}) as unknown as Record<
      string,
      string
    >;
    for (const cat of MODEL_ACCESS_CATEGORIES) {
      const draft = notesDrafts[cat.id];
      const next = allNotes[cat.id] ?? '';
      // Only write when the text actually changed — unconditionally assigning a
      // fresh object re-triggers this effect (it reads notesDrafts too) and
      // blows Svelte's max update depth, freezing all reactivity.
      if (!draft?.dirty && draft?.text !== next) {
        notesDrafts[cat.id] = { text: next, dirty: false };
      }
    }
  });
  async function saveGroupNotes(groupId: string) {
    const draft = notesDrafts[groupId];
    if (!draft) return;
    const currentNotes = (agentSettingsStore.settings.managerNotes ?? {}) as unknown as Record<
      string,
      string
    >;
    const allNotes = { ...currentNotes, [groupId]: draft.text } as unknown as Record<
      string,
      string
    >;
    await agentSettingsStore.saveSettings({
      managerNotes: allNotes as any,
    });
    notesDrafts[groupId] = { ...draft, dirty: false };
  }
  function toggleNotesGroup(groupId: string) {
    collapsedNotesGroups[groupId] = !collapsedNotesGroups[groupId];
  }
  function hasGroupNotes(groupId: string): boolean {
    const allNotes = (agentSettingsStore.settings.managerNotes ?? {}) as unknown as Record<
      string,
      string
    >;
    return (allNotes[groupId] ?? '').trim().length > 0;
  }

  // Handler helpers
  async function toggleSetting(key: keyof typeof DEFAULT_AGENT_SETTINGS) {
    const current = agentSettingsStore.settings[key];
    await agentSettingsStore.saveSettings({ [key]: !current });
  }

  async function toggleSandboxFlag(
    key: 'commandWhitelist' | 'metacharacters' | 'pathConfinement' | 'network' | 'containerTools',
  ) {
    const current = agentSettingsStore.settings.sandbox ?? DEFAULT_SANDBOX_SETTINGS;
    await agentSettingsStore.saveSettings(
      { sandbox: { ...current, [key]: !current[key] } },
      { quietSuccess: true },
    );
  }

  async function setSandboxMode(mode: 'auto' | 'always' | 'off') {
    const current = agentSettingsStore.settings.sandbox ?? DEFAULT_SANDBOX_SETTINGS;
    await agentSettingsStore.saveSettings(
      { sandbox: { ...current, mode } },
      { quietSuccess: true },
    );
  }

  async function setSubAgentApproval(mode: 'manager' | 'user' | 'auto') {
    await agentSettingsStore.saveSettings({ subAgentApproval: mode }, { quietSuccess: true });
  }

  // Tool catalog grouped by category for the allowlist/blocklist UI.
  // Interaction tools (ask_user, ask_manager) are excluded — they're always
  // allowed and cannot be blocked.
  const TOOL_CATALOG: { category: string; tools: { name: string; label: string }[] }[] = [
    {
      category: 'Read & search',
      tools: [
        { name: 'read_file', label: 'Read file' },
        { name: 'grep', label: 'Grep' },
        { name: 'glob', label: 'Glob' },
        { name: 'ls', label: 'List directory' },
        { name: 'diff', label: 'Diff' },
        { name: 'web_search', label: 'Web search' },
        { name: 'web_fetch', label: 'Web fetch' },
        { name: 'view_image', label: 'View image' },
        { name: 'fetch_context', label: 'Fetch context' },
        { name: 'get_resource_budget', label: 'Resource budget' },
        { name: 'load_skill_detail', label: 'Load skill detail' },
      ],
    },
    {
      category: 'Notes & knowledge',
      tools: [
        { name: 'list_notes', label: 'List notes' },
        { name: 'search_notes', label: 'Search notes' },
        { name: 'read_note', label: 'Read note' },
        { name: 'recall_notes', label: 'Recall notes' },
        { name: 'render_note', label: 'Render note' },
        { name: 'get_note_backlinks', label: 'Note backlinks' },
        { name: 'get_note_graph_summary', label: 'Note graph summary' },
        { name: 'create_note', label: 'Create note' },
        { name: 'update_note', label: 'Update note' },
        { name: 'link_notes', label: 'Link notes' },
        { name: 'unlink_notes', label: 'Unlink notes' },
        { name: 'delete_note', label: 'Delete note' },
      ],
    },
    {
      category: 'File edits',
      tools: [
        { name: 'write_file', label: 'Write file' },
        { name: 'edit_file', label: 'Edit file' },
        { name: 'batch_edit', label: 'Batch edit' },
        { name: 'patch', label: 'Patch' },
        { name: 'move_file', label: 'Move file' },
      ],
    },
    {
      category: 'Shell & execution',
      tools: [
        { name: 'bash', label: 'Bash' },
        { name: 'shell_manage', label: 'Shell manage' },
      ],
    },
    {
      category: 'Risky & destructive',
      tools: [
        { name: 'delete_file', label: 'Delete file' },
        { name: 'delegate_to_jules', label: 'Delegate to Jules' },
        { name: 'commit_and_create_pr', label: 'Commit & create PR' },
      ],
    },
    {
      category: 'Goals & workflows',
      tools: [
        { name: 'create_goal', label: 'Create goal' },
        { name: 'update_goal', label: 'Update goal' },
        { name: 'list_workflows', label: 'List workflows' },
        { name: 'start_workflow', label: 'Start workflow' },
        { name: 'update_workflow', label: 'Update workflow' },
        { name: 'create_workflow_draft', label: 'Create workflow draft' },
        { name: 'prune_context', label: 'Prune context' },
      ],
    },
    {
      category: 'MCP diagnostics',
      tools: [
        { name: 'detect-errors', label: 'Detect errors' },
        { name: 'analyze-error', label: 'Analyze error' },
        { name: 'suggest-fixes', label: 'Suggest fixes' },
      ],
    },
  ];

  type ToolAccessState = 'allow' | 'default' | 'block';

  function getToolAccessState(toolName: string): ToolAccessState {
    const allowlist = agentSettingsStore.settings.toolAllowlist ?? [];
    const blocklist = agentSettingsStore.settings.toolBlocklist ?? [];
    if (blocklist.includes(toolName)) return 'block';
    if (allowlist.includes(toolName)) return 'allow';
    return 'default';
  }

  async function setToolAccessState(toolName: string, state: ToolAccessState) {
    const allowlist = [...(agentSettingsStore.settings.toolAllowlist ?? [])];
    const blocklist = [...(agentSettingsStore.settings.toolBlocklist ?? [])];
    // Remove from both lists first
    const allowIdx = allowlist.indexOf(toolName);
    if (allowIdx >= 0) allowlist.splice(allowIdx, 1);
    const blockIdx = blocklist.indexOf(toolName);
    if (blockIdx >= 0) blocklist.splice(blockIdx, 1);
    // Add to the appropriate list
    if (state === 'allow') allowlist.push(toolName);
    else if (state === 'block') blocklist.push(toolName);
    await agentSettingsStore.saveSettings(
      { toolAllowlist: allowlist, toolBlocklist: blocklist },
      { quietSuccess: true },
    );
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
    preferencesContent = agentSettingsStore.preferences?.content ?? '';
    preferencesDirty = false;
  }
</script>

<div class="flex h-full min-h-0 min-w-0 flex-col">
  <!-- Content -->
  <div class="flex-1 min-h-0 overflow-hidden">
    {#if agentSettingsStore.isLoading}
      <div class="flex items-center justify-center h-full">
        <div
          class="animate-spin rounded-full h-8 w-8 border-b-2 border-[var(--color-accent)]"
        ></div>
      </div>
    {:else if agentSettingsStore.activeTab === 'settings' && !agentSettingsStore.settingsLoaded && agentSettingsStore.settingsError}
      <div class="flex h-full items-center justify-center p-6">
        <div
          class="max-w-md rounded-2xl border border-[var(--color-error)]/35 bg-[var(--color-surface-1)] p-5 text-center"
          role="alert"
        >
          <AlertTriangle size={24} class="mx-auto text-[var(--color-error)]" />
          <h3 class="mt-3 text-sm font-semibold text-[var(--color-text-primary)]">
            Agent settings are unavailable
          </h3>
          <p class="mt-2 text-xs leading-relaxed text-[var(--color-text-muted)]">
            {agentSettingsStore.settingsError}
          </p>
          <p class="mt-2 text-[10px] leading-relaxed text-[var(--color-text-muted)]">
            Koryphaios has not substituted defaults for the current project.
          </p>
          <button
            type="button"
            class="mt-4 rounded-xl bg-[var(--color-accent)] px-4 py-2 text-xs font-semibold text-[var(--color-surface-0)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/70"
            onclick={() => void agentSettingsStore.loadAll()}>Retry</button
          >
        </div>
      </div>
    {:else if agentSettingsStore.activeTab === 'settings'}
      <div class="flex h-full min-h-0 flex-col overflow-hidden">
        <SettingsPageIntro
          title="Agent settings"
          description="Choose one area at a time. Changes are saved to this workspace as soon as you make them."
        >
          <span
            class="rounded-full bg-[var(--color-surface-3)] px-2.5 py-1 text-[10px] text-[var(--color-text-muted)]"
          >
            {agentSettingsStore.settings.agentExecutionMode} execution
          </span>
          <span
            class="rounded-full bg-[var(--color-surface-3)] px-2.5 py-1 text-[10px] text-[var(--color-text-muted)]"
          >
            critic {agentSettingsStore.settings.criticGateEnabled ? 'on' : 'off'}
          </span>
          <span
            class="rounded-full bg-[var(--color-surface-3)] px-2.5 py-1 text-[10px] text-[var(--color-text-muted)]"
            >Current project</span
          >
          <span class="text-[10px] text-[var(--color-text-muted)]" aria-live="polite"
            >{agentSettingsStore.settingsSaving ? 'Saving…' : 'Saved'}</span
          >
          <button
            type="button"
            class="rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-xs text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-3)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/60"
            onclick={() => agentSettingsStore.setActiveTab('preferences')}>Preferences</button
          >
          <button
            type="button"
            class="rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-xs text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-3)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/60"
            onclick={() => agentSettingsStore.setActiveTab('skills')}>Skills</button
          >
        </SettingsPageIntro>
        {#if agentSettingsStore.settingsError}
          <div
            class="mx-4 mt-3 flex items-start justify-between gap-3 rounded-xl border border-[var(--color-error)]/35 bg-[var(--color-error)]/10 px-4 py-3 sm:mx-6"
            role="alert"
          >
            <div>
              <div class="text-xs font-semibold text-[var(--color-error)]">
                Setting was not saved
              </div>
              <div class="mt-1 text-[10px] text-[var(--color-text-secondary)]">
                {agentSettingsStore.settingsError} The last server-confirmed value was restored.
              </div>
            </div>
            <button
              type="button"
              class="shrink-0 rounded-lg border border-[var(--color-border)] px-2.5 py-1.5 text-[10px] text-[var(--color-text-secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/60"
              onclick={() => void agentSettingsStore.loadSettings()}>Reload</button
            >
          </div>
        {/if}
        <div class="h-full min-h-0 overflow-y-auto p-4 sm:p-6">
          <div class="mx-auto max-w-7xl space-y-5">
            <section
              class="grid gap-2 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-1)] p-4 sm:grid-cols-3"
            >
              <div class="rounded-xl bg-[var(--color-surface-2)] px-3 py-2.5">
                <div class="text-sm font-semibold capitalize text-[var(--color-text-primary)]">
                  {agentSettingsStore.settings.permissionMode === 'plan'
                    ? 'guarded'
                    : (agentSettingsStore.settings.permissionMode ?? 'guarded')}
                </div>
                <div class="mt-1 text-[10px] text-[var(--color-text-muted)]">Permission mode</div>
              </div>
              <div class="rounded-xl bg-[var(--color-surface-2)] px-3 py-2.5">
                <div class="text-sm font-semibold text-[var(--color-text-primary)]">
                  {agentSettingsStore.settings.criticGateEnabled ? 'Enabled' : 'Disabled'}
                </div>
                <div class="mt-1 text-[10px] text-[var(--color-text-muted)]">Critic review</div>
              </div>
              <div class="rounded-xl bg-[var(--color-surface-2)] px-3 py-2.5">
                <div class="text-sm font-semibold text-[var(--color-success)]">Available</div>
                <div class="mt-1 text-[10px] text-[var(--color-text-muted)]">
                  Workspace settings
                </div>
              </div>
            </section>

            <div class="grid min-w-0 gap-5 lg:grid-cols-[230px_minmax(0,1fr)]">
              <aside class="min-w-0" aria-label="Agent settings categories">
                <div
                  class="flex gap-2 overflow-x-auto pb-1 lg:sticky lg:top-0 lg:block lg:space-y-1 lg:overflow-visible lg:pb-0"
                >
                  {#each CONTROL_SECTIONS as section (section.id)}
                    <button
                      type="button"
                      aria-pressed={selectedControlSection === section.id}
                      onclick={() => (selectedControlSection = section.id)}
                      class="flex min-h-12 shrink-0 items-center gap-3 rounded-xl px-3 text-left transition-colors lg:w-full {selectedControlSection ===
                      section.id
                        ? 'bg-[var(--color-surface-3)] text-[var(--color-text-primary)]'
                        : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-2)]'}"
                    >
                      <section.icon size={16} class="shrink-0" />
                      <span class="min-w-0">
                        <span class="block text-xs font-medium">{section.label}</span>
                        <span
                          class="mt-0.5 hidden text-[10px] text-[var(--color-text-muted)] lg:block"
                          >{section.description}</span
                        >
                      </span>
                    </button>
                  {/each}
                  <div class="hidden border-t border-[var(--color-border)] pt-3 lg:mt-4 lg:block">
                    <button
                      type="button"
                      onclick={() => (showResetConfirmation = true)}
                      class="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-xs text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-error-bg)] hover:text-[var(--color-error)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/60"
                    >
                      <RotateCcw size={14} /> Reset agent settings
                    </button>
                  </div>
                </div>
              </aside>
              <div class="min-w-0">
                <div class="grid gap-5">
                  <div class="space-y-6">
                    {#if selectedControlSection === 'permissions'}
                      <section
                        class="space-y-5 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-1)] p-5"
                      >
                        <div>
                          <div class="flex items-center gap-2">
                            <LockKeyhole size={17} class="text-[var(--color-accent)]" />
                            <h4 class="text-sm font-semibold text-[var(--color-text-primary)]">
                              Permissions & autonomy
                            </h4>
                          </div>
                          <p class="mt-1 text-xs leading-relaxed text-[var(--color-text-muted)]">
                            Choose a preset or build a custom approval policy for this workspace.
                          </p>
                        </div>

                        <div
                          class="grid gap-2 sm:grid-cols-2 xl:grid-cols-6"
                          role="radiogroup"
                          aria-label="Permission mode"
                        >
                          {#each [{ value: 'guarded', label: 'Guarded', description: 'All edits automatic; ask only for risky actions' }, { value: 'edits', label: 'Accept edits', description: 'Apply edits; ask for other actions' }, { value: 'ask', label: 'Ask', description: 'Confirm every action' }, { value: 'custom', label: 'Custom', description: 'Use the rules below' }, { value: 'yolo', label: 'YOLO', description: 'No approval or risk checks' }] as mode (mode.value)}
                            {@const active =
                              (agentSettingsStore.settings.permissionMode === 'plan'
                                ? 'guarded'
                                : (agentSettingsStore.settings.permissionMode ?? 'guarded')) ===
                              mode.value}
                            <button
                              type="button"
                              role="radio"
                              aria-checked={active}
                              onclick={() =>
                                agentSettingsStore.saveSettings(
                                  {
                                    permissionMode: mode.value as
                                      'yolo' | 'guarded' | 'edits' | 'ask' | 'plan' | 'custom',
                                  },
                                  { quietSuccess: true },
                                )}
                              class="min-h-24 rounded-xl border p-3 text-left transition-colors {active
                                ? 'border-[var(--color-accent)] bg-[var(--color-surface-3)]'
                                : 'border-[var(--color-border)] bg-[var(--color-surface-2)] hover:border-[var(--color-border-bright)]'}"
                            >
                              <span
                                class="flex items-center justify-between gap-2 text-xs font-semibold text-[var(--color-text-primary)]"
                              >
                                {mode.label}
                                {#if active}<CheckCircle
                                    size={14}
                                    class="text-[var(--color-accent)]"
                                  />{/if}
                              </span>
                              <span
                                class="mt-2 block text-[10px] leading-relaxed text-[var(--color-text-muted)]"
                                >{mode.description}</span
                              >
                            </button>
                          {/each}
                        </div>

                        {#if agentSettingsStore.settings.permissionMode === 'custom'}
                          <div class="space-y-3 border-t border-[var(--color-border)] pt-4">
                            <div>
                              <h5 class="text-xs font-semibold text-[var(--color-text-primary)]">
                                Custom approval rules
                              </h5>
                              <p class="mt-1 text-[10px] text-[var(--color-text-muted)]">
                                Fine-tune when Kory continues and when it pauses for you.
                              </p>
                            </div>
                            <div class="grid gap-3 sm:grid-cols-2">
                              <SettingsSwitch
                                checked={agentSettingsStore.settings.autoRunTools}
                                label="Allow routine tools"
                                description="When off, ask once before each routine tool action."
                                onchange={() => toggleSetting('autoRunTools')}
                              />
                              <SettingsSwitch
                                checked={agentSettingsStore.settings.autoApplySafeFixes}
                                label="Apply safe file edits"
                                description="Apply low-risk file changes without a separate confirmation."
                                onchange={() => toggleSetting('autoApplySafeFixes')}
                              />
                              <SettingsSwitch
                                checked={agentSettingsStore.settings.confirmRuleViolations}
                                label="Ask before risky overrides"
                                description="Require confirmation before an action may break workspace rules."
                                onchange={() => toggleSetting('confirmRuleViolations')}
                              />
                            </div>
                          </div>
                        {/if}
                      </section>
                    {/if}

                    {#if selectedControlSection === 'quality'}
                      <section
                        class="space-y-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-1)] p-5"
                      >
                        <div class="space-y-1">
                          <h4
                            class="flex items-center gap-2 text-sm font-semibold text-[var(--color-text-primary)]"
                          >
                            <Shield size={16} class="text-[var(--color-accent)]" />
                            Independent review
                          </h4>
                          <p class="text-xs text-[var(--color-text-muted)]">
                            Configure the distinct Critic pass that reviews actual file changes.
                            Turning it off leaves changed work explicitly unverified.
                          </p>
                        </div>

                        <div class="grid gap-3 sm:grid-cols-2">
                          <SettingsSwitch
                            checked={agentSettingsStore.settings.criticGateEnabled}
                            label="Verify changed work"
                            description="Run deterministic checks and an independent Critic before Kory can claim changed work is verified."
                            onchange={() => toggleSetting('criticGateEnabled')}
                          />
                        </div>

                        <div class="grid gap-3 sm:grid-cols-2">
                          <KorySelect
                            label="Critic outcome policy"
                            value={agentSettingsStore.settings.gateStrictness ?? 'strict'}
                            disabled={!agentSettingsStore.settings.criticGateEnabled}
                            options={[
                              { value: 'strict', label: 'Strict — withhold completion' },
                              { value: 'advisory', label: 'Advisory — report issues' },
                              { value: 'off', label: 'Off — mark work unverified' },
                            ]}
                            onchange={(value) =>
                              agentSettingsStore.saveSettings(
                                { gateStrictness: value as 'strict' | 'advisory' | 'off' },
                                { quietSuccess: true },
                              )}
                          />
                          <div class="rounded-xl bg-[var(--color-surface-2)] p-4">
                            <div class="mb-2 text-xs text-[var(--color-text-muted)]">
                              Maximum Critic passes
                            </div>
                            <NumberStepper
                              compact
                              value={agentSettingsStore.settings.maxCriticIterations ?? 3}
                              min={1}
                              max={10}
                              label="Maximum Critic passes"
                              disabled={!agentSettingsStore.settings.criticGateEnabled}
                              onchange={(value) =>
                                agentSettingsStore.saveSettings(
                                  { maxCriticIterations: value },
                                  { quietSuccess: true },
                                )}
                            />
                            <p
                              class="mt-2 text-[10px] leading-relaxed text-[var(--color-text-muted)]"
                            >
                              Bounds delegated repair attempts; it does not invent a passing
                              verdict.
                            </p>
                          </div>
                        </div>
                      </section>
                    {/if}

                    {#if selectedControlSection === 'workflow'}
                      <section
                        class="space-y-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-1)] p-5"
                      >
                        <div class="space-y-1">
                          <h4 class="text-sm font-semibold text-[var(--color-text-primary)]">
                            Workflow
                          </h4>
                          <p class="text-xs text-[var(--color-text-muted)]">
                            Control real task clarification, orchestration, Goal planning, and
                            reversible skill learning.
                          </p>
                        </div>
                        <div class="grid gap-3 sm:grid-cols-2">
                          <KorySelect
                            label="Intent interview"
                            value={agentSettingsStore.settings.intentInterview ?? 'adaptive'}
                            options={[
                              { value: 'off', label: 'Off' },
                              { value: 'adaptive', label: 'Adaptive' },
                              { value: 'deep', label: 'Deep' },
                            ]}
                            onchange={(value) =>
                              agentSettingsStore.saveSettings(
                                { intentInterview: value as 'off' | 'adaptive' | 'deep' },
                                { quietSuccess: true },
                              )}
                          />
                          <KorySelect
                            label="Execution strategy"
                            value={agentSettingsStore.settings.agentExecutionMode ?? 'auto'}
                            options={[
                              { value: 'auto', label: 'Auto — choose for the task' },
                              { value: 'single', label: 'Single agent' },
                              { value: 'multi', label: 'Multi-agent when available' },
                            ]}
                            onchange={(value) =>
                              agentSettingsStore.saveSettings(
                                { agentExecutionMode: value as 'auto' | 'single' | 'multi' },
                                { quietSuccess: true },
                              )}
                          />
                          <KorySelect
                            label="Goal planning"
                            value={agentSettingsStore.settings.goalPlanningDepth ?? 'adaptive'}
                            options={[
                              { value: 'minimal', label: 'Minimal' },
                              { value: 'adaptive', label: 'Adaptive' },
                              { value: 'structured', label: 'Structured' },
                            ]}
                            onchange={(value) =>
                              agentSettingsStore.saveSettings(
                                {
                                  goalPlanningDepth: value as 'minimal' | 'adaptive' | 'structured',
                                },
                                { quietSuccess: true },
                              )}
                          />
                          <KorySelect
                            label="Skill learning"
                            value={agentSettingsStore.settings.skillLearningMode ??
                              'propose-then-verify'}
                            options={[
                              { value: 'human-only', label: 'Human only' },
                              { value: 'propose-then-verify', label: 'Propose then verify' },
                              { value: 'automatic', label: 'Automatic, reversible' },
                            ]}
                            onchange={(value) =>
                              agentSettingsStore.saveSettings(
                                {
                                  skillLearningMode: value as
                                    'human-only' | 'propose-then-verify' | 'automatic',
                                },
                                { quietSuccess: true },
                              )}
                          />
                        </div>
                        <SettingsSwitch
                          checked={goalDisplayStore.sidebar}
                          label="Show Active Goals in sidebar"
                          description="Keep the compact cross-chat goal list visible in the session sidebar."
                          onchange={() =>
                            goalDisplayStore.update({ sidebar: !goalDisplayStore.sidebar })}
                        />
                        <SettingsSwitch
                          checked={goalDisplayStore.composer}
                          label="Show goal context in composer"
                          description="Place the optional goal selector to the right of model and reasoning controls."
                          onchange={() =>
                            goalDisplayStore.update({ composer: !goalDisplayStore.composer })}
                        />
                      </section>
                    {/if}

                    {#if selectedControlSection === 'permissions'}
                      <section
                        class="space-y-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-1)] p-5"
                      >
                        <div class="space-y-1">
                          <h4 class="text-sm font-semibold text-[var(--color-text-primary)]">
                            Autonomy limits
                          </h4>
                          <p class="text-xs text-[var(--color-text-muted)]">
                            Keep thresholds ready, then explicitly turn them on for runs that need
                            an approval boundary.
                          </p>
                        </div>

                        <SettingsSwitch
                          checked={agentSettingsStore.settings.autonomyLimitsEnabled}
                          label="Enable autonomy limits"
                          description={agentSettingsStore.settings.autonomyLimitsEnabled
                            ? agentSettingsStore.settings.permissionMode === 'guarded'
                              ? 'Active for risky non-edit actions. Guarded always applies file edits automatically.'
                              : `Active: approval is required before edits exceeding ${agentSettingsStore.settings.approvalThresholdFiles} files or ${agentSettingsStore.settings.approvalThresholdLines} lines.`
                            : 'Off by default. The values below are saved but do not constrain runs until you enable this switch.'}
                          onchange={() => toggleSetting('autonomyLimitsEnabled')}
                        />

                        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
                          <div class="rounded-xl bg-[var(--color-surface-2)] p-4">
                            <label
                              for="max-files"
                              class="mb-2 block text-xs text-[var(--color-text-muted)]"
                              >Max Files Changed</label
                            >
                            <NumberStepper
                              value={agentSettingsStore.settings.approvalThresholdFiles}
                              min={1}
                              max={50}
                              label="Maximum files changed"
                              onchange={(value) =>
                                agentSettingsStore.saveSettings(
                                  { approvalThresholdFiles: value },
                                  { quietSuccess: true },
                                )}
                            />
                            <p class="mt-2 text-[10px] text-[var(--color-text-muted)]">
                              Used only while autonomy limits are enabled.
                            </p>
                          </div>

                          <div class="rounded-xl bg-[var(--color-surface-2)] p-4">
                            <label
                              for="max-lines"
                              class="mb-2 block text-xs text-[var(--color-text-muted)]"
                              >Max Lines Changed</label
                            >
                            <NumberStepper
                              value={agentSettingsStore.settings.approvalThresholdLines}
                              min={10}
                              max={1000}
                              step={10}
                              label="Maximum lines changed"
                              onchange={(value) =>
                                agentSettingsStore.saveSettings(
                                  { approvalThresholdLines: value },
                                  { quietSuccess: true },
                                )}
                            />
                            <p class="mt-2 text-[10px] text-[var(--color-text-muted)]">
                              Used only while autonomy limits are enabled.
                            </p>
                          </div>
                        </div>
                      </section>
                    {/if}

                    {#if selectedControlSection === 'permissions'}
                      <section
                        class="space-y-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-1)] p-5"
                      >
                        <div class="space-y-1">
                          <h4
                            class="flex items-center gap-2 text-sm font-semibold text-[var(--color-text-primary)]"
                          >
                            <Boxes size={16} class="text-[var(--color-info)]" />
                            Execution sandbox
                          </h4>
                          <p class="text-xs text-[var(--color-text-muted)]">
                            Control how strictly agent shell commands are confined. Granular toggles
                            only apply while the sandbox is active.
                          </p>
                        </div>

                        <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
                          {#each [{ value: 'auto', label: 'Auto', description: 'Sandbox plan, critic, and worker execution only.' }, { value: 'always', label: 'Always', description: 'Sandbox every agent bash call, including the direct manager.' }, { value: 'off', label: 'Off', description: 'No sandbox. Catastrophic-command and approval prompts still apply.' }] as mode (mode.value)}
                            {@const active =
                              (agentSettingsStore.settings.sandbox?.mode ?? 'auto') === mode.value}
                            <button
                              type="button"
                              role="radio"
                              aria-checked={active}
                              onclick={() =>
                                setSandboxMode(mode.value as 'auto' | 'always' | 'off')}
                              class="min-h-20 rounded-xl border p-3 text-left transition-colors {active
                                ? 'border-[var(--color-accent)] bg-[var(--color-surface-3)]'
                                : 'border-[var(--color-border)] bg-[var(--color-surface-2)] hover:border-[var(--color-border-bright)]'}"
                            >
                              <span
                                class="flex items-center justify-between gap-2 text-xs font-semibold text-[var(--color-text-primary)]"
                              >
                                {mode.label}
                                {#if active}<CheckCircle
                                    size={14}
                                    class="text-[var(--color-accent)]"
                                  />{/if}
                              </span>
                              <span
                                class="mt-2 block text-[10px] leading-relaxed text-[var(--color-text-muted)]"
                                >{mode.description}</span
                              >
                            </button>
                          {/each}
                        </div>

                        {#if (agentSettingsStore.settings.sandbox?.mode ?? 'auto') !== 'off'}
                          <div class="space-y-3 border-t border-[var(--color-border)] pt-4">
                            <div>
                              <h5 class="text-xs font-semibold text-[var(--color-text-primary)]">
                                Sandbox enforces
                              </h5>
                              <p class="mt-1 text-[10px] text-[var(--color-text-muted)]">
                                Turn a toggle off to relax that specific check while sandboxed.
                              </p>
                            </div>
                            <div class="grid gap-3 sm:grid-cols-2">
                              <SettingsSwitch
                                checked={agentSettingsStore.settings.sandbox?.commandWhitelist ??
                                  true}
                                label="Command whitelist"
                                description="Only allow safe development commands (git, npm, bun, cargo, etc.)."
                                onchange={() => toggleSandboxFlag('commandWhitelist')}
                              />
                              <SettingsSwitch
                                checked={agentSettingsStore.settings.sandbox?.metacharacters ??
                                  true}
                                label="Block shell metacharacters"
                                description="Block pipes, command substitution, and chaining. Disabling lets commands like `git add && git commit` run."
                                onchange={() => toggleSandboxFlag('metacharacters')}
                              />
                              <SettingsSwitch
                                checked={agentSettingsStore.settings.sandbox?.pathConfinement ??
                                  true}
                                label="Project path confinement"
                                description="Block commands whose working directory is outside the project root."
                                onchange={() => toggleSandboxFlag('pathConfinement')}
                              />
                              <SettingsSwitch
                                checked={agentSettingsStore.settings.sandbox?.network ?? true}
                                label="Block network commands"
                                description="Block curl, wget, and other network tools while sandboxed."
                                onchange={() => toggleSandboxFlag('network')}
                              />
                              <SettingsSwitch
                                checked={agentSettingsStore.settings.sandbox?.containerTools ??
                                  true}
                                label="Block container tools"
                                description="Block docker, podman, and similar container tools while sandboxed."
                                onchange={() => toggleSandboxFlag('containerTools')}
                              />
                            </div>
                          </div>
                        {/if}
                      </section>
                    {/if}

                    {#if selectedControlSection === 'permissions'}
                      <section
                        class="space-y-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-1)] p-5"
                      >
                        <div class="space-y-1">
                          <h4
                            class="flex items-center gap-2 text-sm font-semibold text-[var(--color-text-primary)]"
                          >
                            <Users size={16} class="text-[var(--color-accent)]" />
                            Sub-agent approval
                          </h4>
                          <p class="text-xs text-[var(--color-text-muted)]">
                            Control how worker sub-agents (specialist workers spawned by the
                            manager) are gated when they run tools.
                          </p>
                        </div>

                        <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
                          {#each [{ value: 'manager', label: 'Manager decides', description: "Workers inherit the manager's permission preset. No extra prompts beyond what the preset already requires." }, { value: 'user', label: 'I decide', description: 'Workers can read and search freely, but every file edit, bash command, and risky action prompts you before running.' }, { value: 'auto', label: 'Auto-approve', description: 'Workers run with no approval prompts and no sandbox. Catastrophic-command hard floors still apply.' }] as mode (mode.value)}
                            {@const active =
                              (agentSettingsStore.settings.subAgentApproval ?? 'manager') ===
                              mode.value}
                            <button
                              type="button"
                              role="radio"
                              aria-checked={active}
                              onclick={() =>
                                setSubAgentApproval(mode.value as 'manager' | 'user' | 'auto')}
                              class="min-h-24 rounded-xl border p-3 text-left transition-colors {active
                                ? 'border-[var(--color-accent)] bg-[var(--color-surface-3)]'
                                : 'border-[var(--color-border)] bg-[var(--color-surface-2)] hover:border-[var(--color-border-bright)]'}"
                            >
                              <span
                                class="flex items-center justify-between gap-2 text-xs font-semibold text-[var(--color-text-primary)]"
                              >
                                {mode.label}
                                {#if active}<CheckCircle
                                    size={14}
                                    class="text-[var(--color-accent)]"
                                  />{/if}
                              </span>
                              <span
                                class="mt-2 block text-[10px] leading-relaxed text-[var(--color-text-muted)]"
                                >{mode.description}</span
                              >
                            </button>
                          {/each}
                        </div>

                        {#if (agentSettingsStore.settings.subAgentApproval ?? 'manager') === 'auto'}
                          <div
                            class="flex gap-2 rounded-xl border border-[var(--color-warning)] bg-[var(--color-warning-bg)] p-3 text-[11px] text-[var(--color-warning)]"
                          >
                            <AlertTriangle size={16} class="shrink-0" />
                            <span
                              >Auto-approve lets workers run unconstrained — no approval prompts and
                              no sandbox. Only enable this for trusted, isolated work. Catastrophic
                              commands (rm -rf /, mkfs, etc.) are still blocked by the hard floor.</span
                            >
                          </div>
                        {/if}
                        {#if (agentSettingsStore.settings.subAgentApproval ?? 'manager') === 'user'}
                          <div
                            class="flex gap-2 rounded-xl border border-[var(--color-info)] bg-[var(--color-info-bg)] p-3 text-[11px] text-[var(--color-info)]"
                          >
                            <Eye size={16} class="shrink-0" />
                            <span
                              >Workers can read files and search without prompting. Every file edit,
                              bash command, and risky action will pause for your approval. This
                              gives you control over mutations without slowing down exploration.</span
                            >
                          </div>
                        {/if}
                      </section>
                    {/if}

                    {#if selectedControlSection === 'permissions'}
                      <section
                        class="space-y-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-1)] p-5"
                      >
                        <div class="space-y-1">
                          <h4
                            class="flex items-center gap-2 text-sm font-semibold text-[var(--color-text-primary)]"
                          >
                            <Shield size={16} class="text-[var(--color-accent)]" />
                            Tool access
                          </h4>
                          <p class="text-xs text-[var(--color-text-muted)]">
                            Override the permission preset for individual tools. <strong
                              >Allow</strong
                            >
                            always runs without prompting.
                            <strong>Block</strong> denies the tool entirely.
                            <strong>Default</strong> follows the preset.
                          </p>
                        </div>

                        <div class="space-y-3">
                          {#each TOOL_CATALOG as group}
                            <div
                              class="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3"
                            >
                              <h5
                                class="mb-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]"
                              >
                                {group.category}
                              </h5>
                              <div class="grid gap-1.5 sm:grid-cols-2">
                                {#each group.tools as tool (tool.name)}
                                  {@const state = getToolAccessState(tool.name)}
                                  <div
                                    class="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5"
                                  >
                                    <span class="text-xs text-[var(--color-text-primary)]"
                                      >{tool.label}</span
                                    >
                                    <div
                                      class="flex shrink-0 gap-0.5 rounded-lg bg-[var(--color-surface-3)] p-0.5"
                                    >
                                      {#each ['allow', 'default', 'block'] as opt (opt)}
                                        {@const isActive = state === opt}
                                        <button
                                          type="button"
                                          onclick={() =>
                                            setToolAccessState(tool.name, opt as ToolAccessState)}
                                          class="rounded-md px-2 py-1 text-[10px] font-medium transition-colors {isActive
                                            ? opt === 'allow'
                                              ? 'bg-[var(--color-success-bg)] text-[var(--color-success)]'
                                              : opt === 'block'
                                                ? 'bg-[var(--color-error-bg)] text-[var(--color-error)]'
                                                : 'bg-[var(--color-surface-1)] text-[var(--color-text-primary)]'
                                            : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]'}"
                                        >
                                          {opt === 'allow'
                                            ? 'Allow'
                                            : opt === 'block'
                                              ? 'Block'
                                              : 'Default'}
                                        </button>
                                      {/each}
                                    </div>
                                  </div>
                                {/each}
                              </div>
                            </div>
                          {/each}
                        </div>

                        {#if (agentSettingsStore.settings.toolAllowlist ?? []).length > 0 || (agentSettingsStore.settings.toolBlocklist ?? []).length > 0}
                          <div
                            class="flex items-center justify-between border-t border-[var(--color-border)] pt-3"
                          >
                            <span class="text-[10px] text-[var(--color-text-muted)]">
                              {(agentSettingsStore.settings.toolAllowlist ?? []).length} allowed · {(
                                agentSettingsStore.settings.toolBlocklist ?? []
                              ).length} blocked
                            </span>
                            <button
                              type="button"
                              class="text-[10px] text-[var(--color-text-muted)] underline hover:text-[var(--color-text-secondary)]"
                              onclick={() =>
                                agentSettingsStore.saveSettings(
                                  { toolAllowlist: [], toolBlocklist: [] },
                                  { quietSuccess: true },
                                )}
                            >
                              Reset all to default
                            </button>
                          </div>
                        {/if}
                      </section>
                    {/if}

                    {#if selectedControlSection === 'context'}
                      <section
                        class="space-y-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-1)] p-5"
                      >
                        <div class="space-y-1">
                          <h4 class="text-sm font-semibold text-[var(--color-text-primary)]">
                            Context & memory
                          </h4>
                          <p class="text-xs text-[var(--color-text-muted)]">
                            Everything the agent does is archived locally; stale tool outputs are
                            collapsed out of its context and stay recoverable via fetch_context.
                            Nothing is ever lost.
                          </p>
                        </div>

                        <div class="grid gap-3 sm:grid-cols-2">
                          <SettingsSwitch
                            checked={agentSettingsStore.settings.contextPruningEnabled ?? true}
                            label="Auto-Collapse Old Tool Output"
                            description="Stub stale file reads, terminal output, and search results while keeping them recoverable."
                            onchange={() => toggleSetting('contextPruningEnabled')}
                          />

                          <SettingsSwitch
                            checked={agentSettingsStore.settings.allowExternalPaths ?? false}
                            label="External File Access"
                            description="Let the chat image renderer and viewers serve files outside your home folder (external drives, mounts)."
                            onchange={() => toggleSetting('allowExternalPaths')}
                          />
                          <SettingsSwitch
                            checked={agentSettingsStore.settings.contextSelfAwareness ?? true}
                            label="Agent Context Awareness"
                            description="Give the agent a live window-usage report so it can prune or compact deliberately."
                            onchange={() => toggleSetting('contextSelfAwareness')}
                          />

                          <SettingsSwitch
                            checked={agentSettingsStore.settings.autoCompactEnabled ?? true}
                            label="Automatic Compaction"
                            description="After a completed turn reaches 80% of a trusted model window, schedule a recoverable context compaction."
                            onchange={() => toggleSetting('autoCompactEnabled')}
                          />

                          <SettingsSwitch
                            checked={agentSettingsStore.settings.reasoningExpandedByDefault ??
                              false}
                            label="Expand Full Reasoning by Default"
                            description="Show reasoning automatically while keeping every block individually collapsible."
                            onchange={() => toggleSetting('reasoningExpandedByDefault')}
                          />

                          <div class="rounded-xl bg-[var(--color-surface-2)] p-4">
                            <label
                              for="ctx-keep-turns"
                              class="mb-2 block text-xs text-[var(--color-text-muted)]"
                              >Keep Recent Turns Full</label
                            >
                            <NumberStepper
                              value={agentSettingsStore.settings.contextKeepRecentTurns ?? 3}
                              min={1}
                              max={10}
                              label="Recent turns kept full"
                              onchange={(value) =>
                                agentSettingsStore.saveSettings(
                                  { contextKeepRecentTurns: value },
                                  { quietSuccess: true },
                                )}
                            />
                            <p class="mt-2 text-[10px] text-[var(--color-text-muted)]">
                              Tool outputs from this many recent turns are never collapsed.
                            </p>
                          </div>

                          <div class="rounded-xl bg-[var(--color-surface-2)] p-4">
                            <label
                              for="ctx-min-chars"
                              class="mb-2 block text-xs text-[var(--color-text-muted)]"
                              >Minimum Size to Collapse</label
                            >
                            <NumberStepper
                              value={agentSettingsStore.settings.contextPruneMinChars ?? 600}
                              min={100}
                              max={10000}
                              step={100}
                              label="Minimum output size to collapse"
                              onchange={(value) =>
                                agentSettingsStore.saveSettings(
                                  { contextPruneMinChars: value },
                                  { quietSuccess: true },
                                )}
                            />
                            <p class="mt-2 text-[10px] text-[var(--color-text-muted)]">
                              Outputs smaller than this (characters) stay in context — not worth
                              collapsing.
                            </p>
                          </div>
                        </div>
                      </section>
                    {/if}
                  </div>

                  <div class="space-y-6">
                    {#if selectedControlSection === 'context'}
                      <section
                        class="space-y-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-1)] p-5"
                      >
                        <div class="space-y-1">
                          <h4 class="text-sm font-semibold text-[var(--color-text-primary)]">
                            Memory policy
                          </h4>
                          <p class="text-xs text-[var(--color-text-muted)]">
                            Control whether the agent can persist what it learns.
                          </p>
                        </div>

                        <div class="space-y-3">
                          <SettingsSwitch
                            checked={agentSettingsStore.settings.agentCanUpdatePreferences}
                            label="Remember explicit requests"
                            description="Persist only requests that explicitly say remember or always; ordinary conversation never writes project preferences."
                            onchange={() => toggleSetting('agentCanUpdatePreferences')}
                          />
                        </div>
                      </section>
                    {/if}

                    {#if selectedControlSection === 'research'}
                      <section
                        class="space-y-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-1)] p-5"
                      >
                        <div class="flex items-center gap-2 text-[var(--color-warning)]">
                          <FlaskConical size={16} />
                          <h4 class="text-sm font-semibold">Research</h4>
                        </div>

                        <div class="space-y-3">
                          <div class="rounded-xl bg-[var(--color-surface-2)] p-4">
                            <div class="flex items-start justify-between gap-4">
                              <div class="flex items-center gap-2">
                                <Globe size={14} class="mt-0.5 text-[var(--color-text-muted)]" />
                                <div>
                                  <div class="text-sm font-medium text-[var(--color-text-primary)]">
                                    Local Web Search
                                  </div>
                                  <div class="mt-1 text-[10px] text-[var(--color-text-muted)]">
                                    Use DuckDuckGo fallback for web search.
                                  </div>
                                </div>
                              </div>
                              <div
                                class="flex shrink-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-0)] p-0.5"
                                role="group"
                                aria-label="Local web search mode"
                              >
                                {#each [{ value: 'off', label: 'Off' }, { value: 'fallback', label: 'Fallback' }, { value: 'on', label: 'On' }] as option (option.value)}
                                  <button
                                    type="button"
                                    aria-pressed={agentSettingsStore.settings.localWebSearch ===
                                      option.value}
                                    onclick={() =>
                                      agentSettingsStore.saveSettings({
                                        localWebSearch: option.value as 'off' | 'on' | 'fallback',
                                      })}
                                    class="rounded-md px-2 py-1 text-[10px] font-medium transition-all {agentSettingsStore
                                      .settings.localWebSearch === option.value
                                      ? 'bg-[var(--color-accent)] text-white shadow-sm'
                                      : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]'}"
                                  >
                                    {option.label}
                                  </button>
                                {/each}
                              </div>
                            </div>
                          </div>

                          <SettingsSwitch
                            compact
                            checked={agentSettingsStore.settings.multiSourceResearch}
                            label="Multi-Source Research"
                            description="Require verification across 3–5 sources for research tasks."
                            onchange={() => toggleSetting('multiSourceResearch')}
                          />
                        </div>
                      </section>
                    {/if}

                    <!-- Manager model access: checkbox grid per category -->
                    {#if selectedControlSection === 'routing'}
                      <section
                        class="rounded-2xl p-5"
                        style="background: var(--color-surface-2); border: 1px solid var(--color-border);"
                      >
                        <button
                          type="button"
                          class="flex w-full items-start justify-between gap-4 text-left"
                          aria-expanded={showModelAccess}
                          onclick={() => (showModelAccess = !showModelAccess)}
                        >
                          <span>
                            <span
                              class="block text-sm font-semibold text-[var(--color-text-primary)]"
                              >Routing access</span
                            >
                            <span class="mt-1 block text-xs text-[var(--color-text-muted)]"
                              >Restrict auto-routing by category. Your explicit composer choice
                              always wins.</span
                            >
                          </span>
                          <ChevronRight
                            size={16}
                            class="shrink-0 text-[var(--color-text-muted)] transition-transform {showModelAccess
                              ? 'rotate-90'
                              : ''}"
                          />
                        </button>
                        {#if showModelAccess}
                          <div class="mt-4 space-y-5">
                            {#each MODEL_ACCESS_CATEGORIES as cat (cat.id)}
                              <div
                                class="rounded-xl p-4"
                                style="background: var(--color-surface-0); border: 1px solid var(--color-border);"
                              >
                                <span
                                  class="mb-3 block text-xs font-medium text-[var(--color-text-secondary)]"
                                  >{cat.label}</span
                                >
                                {#if availableModels.length === 0}
                                  <span class="text-[10px] text-[var(--color-text-muted)] italic"
                                    >No enabled models available</span
                                  >
                                {:else}
                                  <div class="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                                    {#each availableModels as m (m)}
                                      {@const checked = modelsFor(cat.id).includes(m)}
                                      <div
                                        class="flex min-w-0 items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-xs transition-colors"
                                        style="background: {checked
                                          ? 'color-mix(in srgb, var(--color-accent) 9%, var(--color-surface-2))'
                                          : 'var(--color-surface-2)'}; border: 1px solid {checked
                                          ? 'color-mix(in srgb, var(--color-accent) 38%, var(--color-border))'
                                          : 'var(--color-border)'};"
                                      >
                                        <span
                                          class="min-w-0 truncate font-mono text-[var(--color-text-primary)]"
                                          >{m}</span
                                        >
                                        <SettingsToggle
                                          {checked}
                                          label={`Allow ${m} for ${cat.label}`}
                                          onchange={() => void toggleCategoryModel(cat.id, m)}
                                        />
                                      </div>
                                    {/each}
                                  </div>
                                {/if}
                              </div>
                            {/each}
                          </div>
                        {/if}
                      </section>

                      <!-- Per-group standing guidance for the manager -->
                      <section
                        class="rounded-2xl p-5"
                        style="background: var(--color-surface-2); border: 1px solid var(--color-border);"
                      >
                        <div class="flex items-center gap-2">
                          <StickyNote size={16} style="color: var(--color-accent);" />
                          <h4 class="text-sm font-semibold text-[var(--color-text-primary)]">
                            Notes for the Manager
                          </h4>
                        </div>
                        <p class="mt-1 text-xs text-[var(--color-text-muted)]">
                          Per-group standing guidance injected into every conversation. Expand a
                          group to edit its notes.
                        </p>
                        <div class="mt-4 space-y-2">
                          {#each MODEL_ACCESS_CATEGORIES as cat (cat.id)}
                            {@const collapsed = collapsedNotesGroups[cat.id] ?? true}
                            {@const draft = notesDrafts[cat.id] ?? { text: '', dirty: false }}
                            <div
                              class="rounded-xl overflow-hidden"
                              style="background: var(--color-surface-0); border: 1px solid var(--color-border);"
                            >
                              <button
                                type="button"
                                class="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-[var(--color-surface-1)]"
                                onclick={() => toggleNotesGroup(cat.id)}
                              >
                                <span class="text-xs font-medium text-[var(--color-text-primary)]"
                                  >{cat.label}</span
                                >
                                <div class="flex items-center gap-2">
                                  {#if draft.dirty}
                                    <span
                                      class="rounded-full px-2 py-0.5 text-[10px] font-medium"
                                      style="background: var(--color-accent); color: var(--color-surface-0);"
                                      >unsaved</span
                                    >
                                  {/if}
                                  {#if hasGroupNotes(cat.id)}
                                    <span
                                      class="rounded-full px-2 py-0.5 text-[10px]"
                                      style="background: var(--color-success); color: var(--color-surface-0);"
                                      >has notes</span
                                    >
                                  {/if}
                                  <ChevronRight
                                    size={14}
                                    class="text-[var(--color-text-muted)] transition-transform {collapsed
                                      ? ''
                                      : 'rotate-90'}"
                                  />
                                </div>
                              </button>
                              {#if !collapsed}
                                <div class="border-t border-[var(--color-border)] px-4 py-3">
                                  <textarea
                                    class="w-full min-h-[100px] rounded-lg p-3 text-xs font-mono resize-y focus:outline-none"
                                    style="background: var(--color-surface-2); color: var(--color-text-primary); border: 1px solid var(--color-border);"
                                    placeholder={cat.notesPlaceholder}
                                    value={draft.text}
                                    oninput={(e) => {
                                      notesDrafts[cat.id] = {
                                        text: e.currentTarget.value,
                                        dirty: true,
                                      };
                                    }}
                                  ></textarea>
                                  <div class="mt-2 flex justify-end">
                                    <button
                                      type="button"
                                      class="rounded-lg px-3 py-1.5 text-xs font-medium transition-colors"
                                      style="background: {draft.dirty
                                        ? 'var(--color-accent)'
                                        : 'var(--color-surface-3)'}; color: {draft.dirty
                                        ? 'var(--color-surface-0)'
                                        : 'var(--color-text-muted)'};"
                                      onclick={() => void saveGroupNotes(cat.id)}
                                    >
                                      {draft.dirty ? 'Save' : 'Saved'}
                                    </button>
                                  </div>
                                </div>
                              {/if}
                            </div>
                          {/each}
                        </div>
                      </section>
                    {/if}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    {:else if agentSettingsStore.activeTab === 'skills'}
      <div class="flex h-full min-h-0 flex-col">
        <section class="border-b border-[var(--color-border)] bg-[var(--color-surface-2)] p-3">
          <div class="mb-3 flex items-center justify-between gap-3">
            <div>
              <h3 class="text-sm font-semibold text-[var(--color-text-primary)]">Skills</h3>
              <p class="mt-1 text-xs text-[var(--color-text-muted)]">
                Manage, test, and create local instructions available to the agent.
              </p>
            </div>
            <div class="flex items-center gap-2">
              <button
                type="button"
                onclick={() => (showSkillCreator = !showSkillCreator)}
                aria-expanded={showSkillCreator}
                aria-label="Create a new skill"
                class="inline-flex items-center gap-1.5 rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90"
              >
                <Plus size={14} strokeWidth={2.5} />
                New skill
              </button>
              <button
                type="button"
                onclick={() => agentSettingsStore.setActiveTab('settings')}
                class="rounded-lg px-3 py-1.5 text-xs text-[var(--color-text-muted)] hover:bg-[var(--color-surface-3)]"
                >Back to controls</button
              >
            </div>
          </div>
          {#if showSkillCreator}
            <div
              class="mb-3 rounded-xl border border-[var(--color-accent)]/40 bg-[var(--color-surface-1)] p-3"
            >
              <div class="mb-3 flex items-start justify-between gap-3">
                <div>
                  <h4 class="text-xs font-semibold text-[var(--color-text-primary)]">
                    Create a skill draft
                  </h4>
                  <p class="mt-1 text-[10px] leading-relaxed text-[var(--color-text-muted)]">
                    Start with concrete triggers, non-triggers, a real workflow, and evidence. The
                    draft stays inactive until its trigger tests pass and you activate it.
                  </p>
                </div>
                <button
                  type="button"
                  onclick={() => (showSkillCreator = false)}
                  class="rounded-md px-2 py-1 text-[10px] text-[var(--color-text-muted)] hover:bg-[var(--color-surface-3)]"
                  >Close</button
                >
              </div>
              <div class="grid gap-3 lg:grid-cols-2">
                <label class="text-[10px] font-medium text-[var(--color-text-secondary)]">
                  Skill name
                  <input
                    value={newSkillName}
                    oninput={(event) =>
                      (newSkillName = normalizeSkillName(event.currentTarget.value))}
                    placeholder="release-notes-review"
                    class="mt-1 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-0)] px-3 py-2 text-xs text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none"
                  />
                </label>
                <div class="text-[10px] font-medium text-[var(--color-text-secondary)]">
                  Save for
                  <div
                    class="mt-1 flex rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-0)] p-1"
                  >
                    {#each ['personal', 'project'] as source (source)}
                      <button
                        type="button"
                        onclick={() => (newSkillSource = source as 'personal' | 'project')}
                        class="flex-1 rounded-md px-3 py-1.5 text-xs capitalize transition-colors {newSkillSource ===
                        source
                          ? 'bg-[var(--color-accent)] text-white'
                          : 'text-[var(--color-text-muted)] hover:bg-[var(--color-surface-3)]'}"
                        >{source}</button
                      >
                    {/each}
                  </div>
                </div>
                <label
                  class="text-[10px] font-medium text-[var(--color-text-secondary)] lg:col-span-2"
                >
                  What it does and when to use it
                  <input
                    bind:value={newSkillDescription}
                    placeholder="Review release notes for accuracy, user impact, and missing migration guidance."
                    class="mt-1 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-0)] px-3 py-2 text-xs text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none"
                  />
                </label>
                <label class="text-[10px] font-medium text-[var(--color-text-secondary)]">
                  Trigger phrases <span class="font-normal text-[var(--color-text-muted)]"
                    >· one per line</span
                  >
                  <textarea
                    bind:value={newSkillTriggers}
                    rows="2"
                    placeholder={'release notes\nchangelog review'}
                    class="mt-1 w-full resize-none rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-0)] px-3 py-2 text-xs text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none"
                  ></textarea>
                </label>
                <label class="text-[10px] font-medium text-[var(--color-text-secondary)]">
                  Domains <span class="font-normal text-[var(--color-text-muted)]"
                    >· one per line</span
                  >
                  <textarea
                    bind:value={newSkillDomains}
                    rows="2"
                    placeholder={'release\ncommunication'}
                    class="mt-1 w-full resize-none rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-0)] px-3 py-2 text-xs text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none"
                  ></textarea>
                </label>
                <div
                  class="space-y-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3 lg:col-span-2"
                >
                  <div>
                    <h5 class="text-[10px] font-semibold text-[var(--color-text-primary)]">
                      Professional relationships
                    </h5>
                    <p class="mt-1 text-[10px] leading-relaxed text-[var(--color-text-muted)]">
                      Broader concepts form the hierarchy. Facets add cross-cutting practice;
                      requirements are mandatory dependencies; conflicts cannot be selected
                      together.
                    </p>
                  </div>
                  <div class="grid gap-3 lg:grid-cols-2">
                    <div class="space-y-1.5">
                      <span class="text-[10px] font-medium text-[var(--color-text-secondary)]"
                        >Broader concepts</span
                      >
                      <KorySelect
                        compact
                        value=""
                        label="Add broader concept"
                        placeholder="Add a broader discipline…"
                        options={skillRelationOptions(newSkillBroader)}
                        onchange={addBroader}
                      />
                      <div class="flex flex-wrap gap-1">
                        {#each newSkillBroader as relation (relation)}
                          <button
                            type="button"
                            aria-label={`Remove broader concept ${relation}`}
                            onclick={() => removeBroader(relation)}
                            class="inline-flex items-center gap-1 rounded-md bg-[var(--color-accent)]/10 px-2 py-1 text-[10px] text-[var(--color-accent)]"
                            >{relation}<XCircle size={11} /></button
                          >
                        {/each}
                      </div>
                    </div>
                    <div class="space-y-1.5">
                      <span class="text-[10px] font-medium text-[var(--color-text-secondary)]"
                        >Cross-cutting facets</span
                      >
                      <KorySelect
                        compact
                        value=""
                        label="Add cross-cutting facet"
                        placeholder="Add a professional facet…"
                        options={skillRelationOptions(newSkillFacets)}
                        onchange={(value) =>
                          (newSkillFacets = [...new Set([...newSkillFacets, value])])}
                      />
                      <div class="flex flex-wrap gap-1">
                        {#each newSkillFacets as relation (relation)}
                          <button
                            type="button"
                            aria-label={`Remove facet ${relation}`}
                            onclick={() =>
                              (newSkillFacets = newSkillFacets.filter((name) => name !== relation))}
                            class="inline-flex items-center gap-1 rounded-md bg-[var(--color-surface-3)] px-2 py-1 text-[10px] text-[var(--color-text-secondary)]"
                            >{relation}<XCircle size={11} /></button
                          >
                        {/each}
                      </div>
                    </div>
                    <div class="space-y-1.5">
                      <span class="text-[10px] font-medium text-[var(--color-text-secondary)]"
                        >Required skills</span
                      >
                      <KorySelect
                        compact
                        value=""
                        label="Add required skill"
                        placeholder="Add a required skill…"
                        options={skillRelationOptions(newSkillRequires)}
                        onchange={(value) =>
                          (newSkillRequires = [...new Set([...newSkillRequires, value])])}
                      />
                      <div class="flex flex-wrap gap-1">
                        {#each newSkillRequires as relation (relation)}
                          <button
                            type="button"
                            aria-label={`Remove required skill ${relation}`}
                            onclick={() =>
                              (newSkillRequires = newSkillRequires.filter(
                                (name) => name !== relation,
                              ))}
                            class="inline-flex items-center gap-1 rounded-md bg-[var(--color-surface-3)] px-2 py-1 text-[10px] text-[var(--color-text-secondary)]"
                            >{relation}<XCircle size={11} /></button
                          >
                        {/each}
                      </div>
                    </div>
                    <div class="space-y-1.5">
                      <span class="text-[10px] font-medium text-[var(--color-text-secondary)]"
                        >Conflicting skills</span
                      >
                      <KorySelect
                        compact
                        value=""
                        label="Add conflicting skill"
                        placeholder="Add an incompatible skill…"
                        options={skillRelationOptions(newSkillConflicts)}
                        onchange={(value) =>
                          (newSkillConflicts = [...new Set([...newSkillConflicts, value])])}
                      />
                      <div class="flex flex-wrap gap-1">
                        {#each newSkillConflicts as relation (relation)}
                          <button
                            type="button"
                            aria-label={`Remove conflicting skill ${relation}`}
                            onclick={() =>
                              (newSkillConflicts = newSkillConflicts.filter(
                                (name) => name !== relation,
                              ))}
                            class="inline-flex items-center gap-1 rounded-md bg-[var(--color-warning)]/10 px-2 py-1 text-[10px] text-[var(--color-warning)]"
                            >{relation}<XCircle size={11} /></button
                          >
                        {/each}
                      </div>
                    </div>
                  </div>
                </div>
                <div class="space-y-1.5">
                  <span class="text-[10px] font-medium text-[var(--color-text-secondary)]"
                    >Target media</span
                  >
                  <KorySelect
                    compact
                    value=""
                    label="Add target medium"
                    placeholder="Add a target medium…"
                    options={[
                      { value: 'any', label: 'Any medium' },
                      { value: 'web', label: 'Web' },
                      { value: 'native', label: 'Native desktop' },
                      { value: 'mobile', label: 'Mobile' },
                      { value: 'terminal', label: 'Terminal' },
                      { value: 'game', label: 'Game' },
                      { value: 'spatial', label: 'Spatial' },
                      { value: 'embedded', label: 'Embedded' },
                    ].filter((option) => !newSkillTargetMedia.includes(option.value))}
                    onchange={addTargetMedium}
                  />
                  <div class="flex flex-wrap gap-1">
                    {#each newSkillTargetMedia as medium (medium)}
                      <button
                        type="button"
                        aria-label={`Remove target medium ${medium}`}
                        disabled={newSkillTargetMedia.length === 1}
                        onclick={() =>
                          (newSkillTargetMedia = newSkillTargetMedia.filter(
                            (value) => value !== medium,
                          ))}
                        class="inline-flex items-center gap-1 rounded-md bg-[var(--color-surface-3)] px-2 py-1 text-[10px] text-[var(--color-text-secondary)] disabled:cursor-not-allowed disabled:opacity-50"
                        >{medium}<XCircle size={11} /></button
                      >
                    {/each}
                  </div>
                </div>
                <label class="text-[10px] font-medium text-[var(--color-text-secondary)]">
                  Exclusion phrases <span class="font-normal text-[var(--color-text-muted)]"
                    >· one per line</span
                  >
                  <textarea
                    bind:value={newSkillExcludes}
                    rows="3"
                    placeholder={'marketing-only rewrite\nunrelated deployment'}
                    class="mt-1 w-full resize-none rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-0)] px-3 py-2 text-xs text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none"
                  ></textarea>
                </label>
                <div
                  class="grid gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3 lg:col-span-2 sm:grid-cols-2"
                >
                  <div>
                    <div class="mb-2 text-[10px] font-medium text-[var(--color-text-secondary)]">
                      Hierarchy depth
                    </div>
                    <NumberStepper
                      compact
                      value={newSkillDepth}
                      min={0}
                      max={32}
                      label="Skill hierarchy depth"
                      onchange={(value) => (newSkillDepth = value)}
                    />
                    <p class="mt-1 text-[10px] text-[var(--color-text-muted)]">
                      Updated from broader concepts and verified server-side against the graph.
                    </p>
                  </div>
                  <div>
                    <div class="mb-2 text-[10px] font-medium text-[var(--color-text-secondary)]">
                      Context budget
                    </div>
                    <NumberStepper
                      compact
                      value={newSkillContextBudget}
                      min={100}
                      max={20000}
                      step={100}
                      label="Skill context budget"
                      onchange={(value) => (newSkillContextBudget = value)}
                    />
                    <p class="mt-1 text-[10px] text-[var(--color-text-muted)]">
                      Maximum injected characters for this skill, including its prompt header.
                    </p>
                  </div>
                </div>
                <label class="text-[10px] font-medium text-[var(--color-text-secondary)]">
                  Should trigger <span class="font-normal text-[var(--color-text-muted)]"
                    >· at least two, one per line</span
                  >
                  <textarea
                    bind:value={newSkillPositiveExample}
                    rows="3"
                    placeholder={'Review these release notes before launch\nCheck this changelog for missing migration guidance'}
                    class="mt-1 w-full resize-none rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-0)] px-3 py-2 text-xs text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none"
                  ></textarea>
                </label>
                <label class="text-[10px] font-medium text-[var(--color-text-secondary)]">
                  Should not trigger <span class="font-normal text-[var(--color-text-muted)]"
                    >· at least two, one per line</span
                  >
                  <textarea
                    bind:value={newSkillNegativeExample}
                    rows="3"
                    placeholder={'Fix this runtime crash\nDesign a settings screen'}
                    class="mt-1 w-full resize-none rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-0)] px-3 py-2 text-xs text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none"
                  ></textarea>
                </label>
                <label
                  class="text-[10px] font-medium text-[var(--color-text-secondary)] lg:col-span-2"
                >
                  Instructions
                  <textarea
                    bind:value={newSkillInstructions}
                    rows="5"
                    placeholder={'Describe the workflow in order. Include decisions, constraints, failure and recovery behavior, and what must be verified before completion.'}
                    class="mt-1 w-full resize-y rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-0)] px-3 py-2 font-mono text-xs leading-relaxed text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none"
                  ></textarea>
                </label>
                <label
                  class="text-[10px] font-medium text-[var(--color-text-secondary)] lg:col-span-2"
                >
                  Completion evidence <span class="font-normal text-[var(--color-text-muted)]"
                    >· one item per line</span
                  >
                  <textarea
                    bind:value={newSkillEvidence}
                    rows="2"
                    placeholder={'Factual review complete\nRendered output verified'}
                    class="mt-1 w-full resize-none rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-0)] px-3 py-2 text-xs text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none"
                  ></textarea>
                </label>
              </div>
              <div class="mt-3 flex items-center justify-between gap-3">
                <p class="text-[10px] text-[var(--color-text-muted)]">
                  Personal skills follow you. Project skills live with this workspace.
                </p>
                <button
                  type="button"
                  onclick={() => void createSkill()}
                  disabled={!normalizeSkillName(newSkillName) ||
                    newSkillDescription.trim().length < 40 ||
                    newSkillInstructions.trim().length < 40 ||
                    splitSkillLines(newSkillDomains).length < 1 ||
                    splitSkillLines(newSkillTriggers).length < 1 ||
                    splitSkillLines(newSkillPositiveExample).length < 2 ||
                    splitSkillLines(newSkillNegativeExample).length < 2 ||
                    splitSkillLines(newSkillEvidence).length < 1}
                  class="rounded-lg bg-[var(--color-accent)] px-4 py-2 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40"
                  >Create draft</button
                >
              </div>
            </div>
          {/if}
          <div class="flex gap-2">
            <input
              bind:value={skillPreviewPrompt}
              onkeydown={(event) => event.key === 'Enter' && void runSkillPreview()}
              aria-label="Task to preview skill selection"
              placeholder="Preview which local skills a task will use…"
              class="min-w-0 flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-0)] px-3 py-2 text-xs text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none"
            />
            <button
              type="button"
              onclick={() => void runSkillPreview()}
              disabled={!skillPreviewPrompt.trim()}
              class="rounded-lg bg-[var(--color-accent)] px-3 py-2 text-xs font-medium text-white disabled:opacity-40"
              >Preview routing plan</button
            >
          </div>
          {#if agentSettingsStore.skillResolutionPreview}
            {@const preview = agentSettingsStore.skillResolutionPreview}
            <div class="mt-2 text-[10px] text-[var(--color-text-muted)]">
              Planning-only routing preview · {preview.selected.length} selected ·
              {preview.totalContextCost}/{preview.contextBudget} context characters ({preview.contextOverheadCost}
              manifest/header) ·
              {preview.blocked ? 'routing blocked pending a decision' : 'routing valid'}
            </div>
            <p class="mt-1 text-[10px] leading-relaxed text-[var(--color-text-muted)]">
              {preview.planningLimit} This preview never claims that the current manager turn will fit.
            </p>
            {#if preview.selected.length}
              <div class="mt-2 flex flex-wrap gap-1.5">
                {#each preview.selected as item (item.skill.hash)}
                  <span
                    title={`${item.reason}${item.representation === 'full' ? '' : ` · ${item.omittedDetailChars} detailed characters omitted to fit context`}`}
                    class="rounded px-2 py-1 text-[10px] {item.representation === 'full'
                      ? 'bg-[var(--color-accent)]/10 text-[var(--color-accent)]'
                      : 'bg-[var(--color-warning)]/10 text-[var(--color-warning)]'}"
                    >{item.skill.name} · {item.representation} · {item.contextCost}</span
                  >
                {/each}
              </div>
            {/if}
            {#if preview.compressedByBudget.length}
              <div
                class="mt-2 rounded-lg border border-[var(--color-warning)]/30 bg-[var(--color-warning)]/5 p-2 text-[10px] leading-relaxed text-[var(--color-text-secondary)]"
              >
                Context-aware compression is active. Koryphaios retained each affected skill’s
                operating contract, safety boundaries, and completion evidence while omitting
                extended rationale and examples:
                {preview.compressedByBudget
                  .map(
                    (item) =>
                      `${item.name} (${item.representation}, ${item.contextCost}/${item.fullContextCost} chars)`,
                  )
                  .join(' · ')}
              </div>
            {/if}
            {#if preview.rejectedCandidates.length}
              <details
                class="mt-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-1)] p-2 text-[10px]"
              >
                <summary class="cursor-pointer text-[var(--color-text-secondary)]">
                  Why {preview.rejectedCandidateCount} other skill candidates were not selected
                  {preview.rejectedCandidatesTruncated
                    ? '(showing the highest-signal reasons)'
                    : ''}
                </summary>
                <div class="mt-2 grid gap-1.5">
                  {#each preview.rejectedCandidates as candidate (candidate.name)}
                    <div class="grid grid-cols-[minmax(8rem,0.32fr)_minmax(0,1fr)] gap-2">
                      <span class="font-medium text-[var(--color-text-primary)]"
                        >{candidate.name}</span
                      >
                      <span class="text-[var(--color-text-muted)]">{candidate.reason}</span>
                    </div>
                  {/each}
                </div>
              </details>
            {/if}
            {#each preview.collisions as collision (collision.name)}
              <div
                class="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/5 p-2 text-[10px]"
              >
                <span class="text-[var(--color-text-secondary)]"
                  >Choose {collision.name} for this preview:</span
                >
                {#each ['project', 'personal'] as source (source)}
                  <button
                    type="button"
                    onclick={() => {
                      skillCollisionChoices = {
                        ...skillCollisionChoices,
                        [collision.name]: source as 'personal' | 'project',
                      };
                      void runSkillPreview();
                    }}
                    class="rounded px-2 py-1 {skillCollisionChoices[collision.name] === source
                      ? 'bg-[var(--color-accent)] text-white'
                      : 'bg-[var(--color-surface-3)] text-[var(--color-text-secondary)]'}"
                    >Use {source}</button
                  >
                {/each}
              </div>
            {/each}
            {#if preview.selectionConflicts.length || preview.hierarchyErrors.length || preview.omittedByBudget.length}
              <div class="mt-2 text-[10px] text-[var(--color-error)]">
                {[
                  ...preview.selectionConflicts.map(
                    (item) => `${item.left} conflicts with ${item.right}`,
                  ),
                  ...preview.hierarchyErrors,
                  ...preview.omittedByBudget.map((name) => `${name} omitted by context budget`),
                ].join(' · ')}
              </div>
            {/if}
          {/if}
        </section>
        <div class="grid min-h-0 flex-1 grid-cols-[minmax(190px,0.36fr)_minmax(0,1fr)]">
          <aside
            class="min-h-0 overflow-y-auto border-r border-[var(--color-border)] bg-[var(--color-surface-1)] p-2"
          >
            <div
              class="px-2 py-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]"
            >
              Local library · {activeSkillCount} active
              {#if agentSettingsStore.bundledUpdateCount > 0}
                <span
                  class="ml-1 rounded bg-[var(--color-accent)]/15 px-1.5 py-0.5 text-[var(--color-accent)]"
                  >{agentSettingsStore.bundledUpdateCount} update{agentSettingsStore.bundledUpdateCount >
                  1
                    ? 's'
                    : ''} available</span
                >
              {/if}
            </div>
            {#each agentSettingsStore.skills as skill (`${skill.source}:${skill.name}:${skill.state}`)}
              <button
                onclick={() => {
                  selectedSkillKey = `${skill.source}:${skill.name}:${skill.state}`;
                  skillDraftDirty = false;
                  showSkillComparison = false;
                  showBundledComparison = false;
                }}
                class="mb-1 w-full rounded-lg border py-2 pr-2.5 text-left transition-colors {selectedSkill?.name ===
                  skill.name &&
                selectedSkill?.source === skill.source &&
                selectedSkill?.state === skill.state
                  ? 'border-[var(--color-accent)] bg-[var(--color-surface-3)]'
                  : 'border-transparent hover:bg-[var(--color-surface-2)]'}"
                style={`padding-left: ${10 + Math.min(skill.metadata.depth, 4) * 12}px`}
              >
                <div class="flex items-center justify-between gap-2">
                  <span class="truncate text-xs font-medium text-[var(--color-text-primary)]"
                    >{skill.name}</span
                  >
                  <div class="flex shrink-0 items-center gap-1">
                    {#if skill.bundledUpdateAvailable}
                      <span
                        class="rounded bg-[var(--color-accent)]/15 px-1.5 py-0.5 text-[9px] text-[var(--color-accent)]"
                        title="A newer bundled version is available. Use Compare to review and merge."
                        >update</span
                      >
                    {/if}
                    <span
                      class="rounded px-1.5 py-0.5 text-[9px] {skill.state === 'active'
                        ? 'bg-[var(--color-success)]/15 text-[var(--color-success)]'
                        : 'bg-[var(--color-warning)]/15 text-[var(--color-warning)]'}"
                      >{skill.state}</span
                    >
                  </div>
                </div>
                <div class="mt-1 text-[10px] text-[var(--color-text-muted)]">
                  {skill.source} · v{skill.metadata.version}
                </div>
              </button>
            {/each}
          </aside>
          {#if selectedSkill}
            <section class="flex min-h-0 flex-col">
              <div
                class="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-2"
              >
                <div class="min-w-0">
                  <div class="text-sm font-semibold text-[var(--color-text-primary)]">
                    {selectedSkill.name}
                  </div>
                  <div class="truncate text-[10px] text-[var(--color-text-muted)]">
                    {selectedSkill.description} · base {selectedSkill.metadata.baseVersion} · budget {selectedSkill
                      .metadata.contextBudget}
                  </div>
                </div>
                <div class="flex items-center gap-2">
                  <button
                    onclick={() => void compareSelectedSkill()}
                    class="rounded-md border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-text-secondary)]"
                    >Compare</button
                  >
                  {#if selectedSkill.bundledUpdateAvailable}
                    <button
                      onclick={() => void compareSelectedSkillWithBundled()}
                      class="rounded-md bg-[var(--color-accent)]/15 px-2 py-1 text-xs text-[var(--color-accent)]"
                      >Compare with bundled</button
                    >
                  {/if}
                  <button
                    onclick={() => {
                      skillDraftContent = selectedSkill.content;
                      skillDraftDirty = false;
                    }}
                    disabled={!skillDraftDirty}
                    class="rounded-md border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-text-secondary)] disabled:opacity-40"
                    >Reset</button
                  >
                  <button
                    onclick={() => void saveSelectedSkillDraft()}
                    disabled={!skillDraftDirty}
                    class="rounded-md bg-[var(--color-accent)] px-2 py-1 text-xs text-white disabled:opacity-40"
                    >Save draft</button
                  >
                  {#if selectedSkill.state === 'draft'}<button
                      onclick={() => agentSettingsStore.testAndActivateSkill(selectedSkill)}
                      class="rounded-md bg-[var(--color-success)] px-2 py-1 text-xs text-white"
                      >Test & activate</button
                    >{/if}
                </div>
              </div>
              <div
                class="flex flex-wrap gap-1.5 border-b border-[var(--color-border)] px-4 py-2 text-[10px] text-[var(--color-text-muted)]"
              >
                {#each selectedSkill.metadata.broader as broader (broader)}<span
                    class="rounded bg-[var(--color-accent)]/10 px-1.5 py-0.5 text-[var(--color-accent)]"
                    >broader: {broader}</span
                  >{/each}
                {#each selectedSkill.metadata.facets as facet (facet)}<span
                    class="rounded bg-[var(--color-info)]/10 px-1.5 py-0.5 text-[var(--color-info)]"
                    >facet: {facet}</span
                  >{/each}
                {#each selectedSkill.metadata.domains as domain (domain)}<span
                    class="rounded bg-[var(--color-surface-3)] px-1.5 py-0.5">{domain}</span
                  >{/each}
                {#each selectedSkill.metadata.activation as term (term)}<span
                    class="rounded bg-[var(--color-surface-3)] px-1.5 py-0.5">trigger: {term}</span
                  >{/each}
                {#each selectedSkill.metadata.requires as requirement (requirement)}<span
                    class="rounded bg-[var(--color-info)]/10 px-1.5 py-0.5 text-[var(--color-info)]"
                    >requires: {requirement}</span
                  >{/each}
                {#each selectedSkill.metadata.conflicts as conflict (conflict)}<span
                    class="rounded bg-[var(--color-warning)]/10 px-1.5 py-0.5 text-[var(--color-warning)]"
                    >conflicts: {conflict}</span
                  >{/each}
                {#if selectedSkill.validation.warnings.length}<span
                    class="text-[var(--color-warning)]"
                    >{selectedSkill.validation.warnings.join(' · ')}</span
                  >{/if}
                {#if selectedSkill.validation.errors.length}<span class="text-[var(--color-error)]"
                    >{selectedSkill.validation.errors.join(' · ')}</span
                  >{/if}
              </div>
              <div
                class="border-b border-[var(--color-border)] px-4 py-2 text-[10px] text-[var(--color-text-muted)]"
              >
                {#if selectedSkillQualifications.length}
                  <span class="font-semibold text-[var(--color-text-secondary)]"
                    >Measured harness evidence:</span
                  >
                  {#each selectedSkillQualifications as record, i (i)}
                    <span class="ml-2"
                      >{record.provider}:{record.model} · {record.role} · {record.successes}/{record.sampleSize}
                      pass · quality {Math.round(record.quality * 100)}%</span
                    >
                  {/each}
                {:else}
                  No measured harness qualification yet. Unknown models are not assigned a
                  fabricated rank.
                {/if}
              </div>
              <div
                class="border-b border-[var(--color-border)] px-4 py-2 text-[10px] text-[var(--color-text-muted)]"
              >
                {#if selectedSkillEvaluation}
                  {@const gate = selectedSkillEvaluation.gate}
                  <span class="font-semibold text-[var(--color-text-secondary)]"
                    >Promotion evidence:</span
                  >
                  <span
                    class="ml-2 rounded px-1.5 py-0.5 {gate.status === 'ready'
                      ? 'bg-[var(--color-success)]/15 text-[var(--color-success)]'
                      : gate.status === 'blocked'
                        ? 'bg-[var(--color-error)]/15 text-[var(--color-error)]'
                        : 'bg-[var(--color-warning)]/15 text-[var(--color-warning)]'}"
                    >{gate.status}</span
                  >
                  <span class="ml-2"
                    >{gate.candidateRuns} observed runs · {gate.distinctProviders} providers · {gate.distinctModels}
                    models · {gate.humanBlindReviews} blinded review{gate.humanBlindReviews === 1
                      ? ''
                      : 's'}</span
                  >
                  {#if gate.reasons.length}<div class="mt-1">{gate.reasons.join(' · ')}</div>{/if}
                  <div class="mt-1">
                    {selectedSkillEvaluation.cases.length} evaluation cases are derived from the skill’s
                    visible trigger and non-trigger contract. No model score is shown until evidence is
                    recorded.
                  </div>
                {:else}
                  Loading the evidence card…
                {/if}
              </div>
              <textarea
                bind:value={skillDraftContent}
                oninput={() => (skillDraftDirty = true)}
                spellcheck="false"
                aria-label="Skill Markdown editor"
                class="min-h-0 flex-1 resize-none bg-[var(--color-surface-0)] p-4 font-mono text-xs text-[var(--color-text-primary)] focus:outline-none"
              ></textarea>
              {#if showSkillComparison && agentSettingsStore.skillComparison}
                <div
                  class="max-h-[45%] overflow-auto border-t border-[var(--color-border)] bg-[var(--color-surface-1)] p-3"
                >
                  <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <span class="text-xs font-semibold text-[var(--color-text-primary)]"
                      >Active versus draft</span
                    >
                    <button
                      type="button"
                      onclick={() => (showSkillComparison = false)}
                      class="rounded border border-[var(--color-border)] px-2 py-1 text-[10px] text-[var(--color-text-secondary)]"
                      >Close</button
                    >
                  </div>
                  <div class="grid gap-2 xl:grid-cols-2">
                    <pre
                      class="overflow-auto whitespace-pre-wrap rounded bg-[var(--color-surface-0)] p-2 text-[9px] text-[var(--color-text-secondary)]">{agentSettingsStore
                        .skillComparison.active}</pre>
                    <pre
                      class="overflow-auto whitespace-pre-wrap rounded bg-[var(--color-surface-0)] p-2 text-[9px] text-[var(--color-text-secondary)]">{agentSettingsStore
                        .skillComparison.draft}</pre>
                  </div>
                </div>
              {/if}
              {#if showBundledComparison && agentSettingsStore.bundledComparison}
                <div
                  class="max-h-[45%] overflow-auto border-t border-[var(--color-border)] bg-[var(--color-surface-1)] p-3"
                >
                  <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <span class="text-xs font-semibold text-[var(--color-text-primary)]"
                      >Your version versus bundled update</span
                    >
                    <div class="flex flex-wrap gap-1.5">
                      <button
                        type="button"
                        onclick={() =>
                          void agentSettingsStore.applyBundledSkillUpdate(
                            selectedSkill,
                            'keep-local',
                          )}
                        disabled={agentSettingsStore.isMergingSkill}
                        class="rounded bg-[var(--color-surface-3)] px-2 py-1 text-[10px] text-[var(--color-text-secondary)] disabled:opacity-40"
                        >Keep local</button
                      >
                      <button
                        type="button"
                        onclick={() =>
                          void agentSettingsStore.applyBundledSkillUpdate(selectedSkill, 'merge')}
                        disabled={agentSettingsStore.isMergingSkill}
                        class="rounded bg-[var(--color-warning)] px-2 py-1 text-[10px] text-white disabled:opacity-40"
                        >Merge to draft</button
                      >
                      <button
                        type="button"
                        onclick={() =>
                          void agentSettingsStore.applyBundledSkillUpdate(
                            selectedSkill,
                            'merge-with-agent',
                          )}
                        disabled={agentSettingsStore.isMergingSkill}
                        class="rounded bg-[var(--color-accent)] px-2 py-1 text-[10px] text-white disabled:opacity-40"
                        >{agentSettingsStore.isMergingSkill
                          ? 'Merging…'
                          : 'Merge with agent'}</button
                      >
                      <button
                        type="button"
                        onclick={() =>
                          void agentSettingsStore.applyBundledSkillUpdate(selectedSkill, 'replace')}
                        disabled={agentSettingsStore.isMergingSkill}
                        class="rounded bg-[var(--color-error)] px-2 py-1 text-[10px] text-white disabled:opacity-40"
                        >Replace with bundled</button
                      >
                      <button
                        type="button"
                        onclick={() => (showBundledComparison = false)}
                        disabled={agentSettingsStore.isMergingSkill}
                        class="rounded border border-[var(--color-border)] px-2 py-1 text-[10px] text-[var(--color-text-secondary)] disabled:opacity-40"
                        >Close</button
                      >
                    </div>
                  </div>
                  {#if agentSettingsStore.isMergingSkill}
                    <div
                      class="mb-2 rounded bg-[var(--color-accent)]/10 px-3 py-2 text-[10px] text-[var(--color-accent)]"
                    >
                      The agent is reading both versions and producing a merged draft. This usually
                      takes 10–30 seconds…
                    </div>
                  {/if}
                  <div class="grid gap-2 xl:grid-cols-2">
                    <div>
                      <div
                        class="mb-1 text-[9px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]"
                      >
                        Your version
                      </div>
                      <pre
                        class="overflow-auto whitespace-pre-wrap rounded bg-[var(--color-surface-0)] p-2 text-[9px] text-[var(--color-text-secondary)]">{agentSettingsStore
                          .bundledComparison.local}</pre>
                    </div>
                    <div>
                      <div
                        class="mb-1 text-[9px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]"
                      >
                        Bundled update
                      </div>
                      <pre
                        class="overflow-auto whitespace-pre-wrap rounded bg-[var(--color-surface-0)] p-2 text-[9px] text-[var(--color-text-secondary)]">{agentSettingsStore
                          .bundledComparison.bundled}</pre>
                    </div>
                  </div>
                </div>
              {/if}
            </section>
          {:else}
            <div class="flex items-center justify-center text-sm text-[var(--color-text-muted)]">
              No local skills found.
            </div>
          {/if}
        </div>
      </div>
    {:else if agentSettingsStore.activeTab === 'preferences'}
      {@const prefs = agentSettingsStore.preferences}
      <div class="flex h-full min-h-0 flex-col">
        <!-- Preferences Header -->
        <div class="px-4 py-2 bg-[var(--color-surface-2)] border-b border-[var(--color-border)]">
          <div class="flex items-center justify-between">
            <div class="flex-1 min-w-0">
              {#if !prefs?.exists}
                <div class="flex items-center gap-2 text-xs text-[var(--color-warning)]">
                  <AlertTriangle size={14} />
                  <span>Preferences not initialized</span>
                </div>
              {:else}
                <div class="flex items-center gap-4 text-xs text-[var(--color-text-muted)]">
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
              <button
                type="button"
                onclick={() => agentSettingsStore.setActiveTab('settings')}
                class="px-2 py-1 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
                >Back to controls</button
              >
              {#if !prefs?.exists}
                <button
                  onclick={() => agentSettingsStore.initializePreferences()}
                  class="flex items-center gap-1 rounded bg-[var(--color-success-bg)] px-2 py-1 text-xs text-[var(--color-success)] hover:bg-[var(--color-surface-3)]"
                >
                  <Plus size={12} />
                  Initialize
                </button>
              {:else}
                <button
                  onclick={handleResetPreferences}
                  disabled={!preferencesDirty}
                  class="flex items-center gap-1 px-2 py-1 text-xs rounded disabled:opacity-50
                    {preferencesDirty
                    ? 'bg-[var(--color-warning-bg)] text-[var(--color-warning)] hover:bg-[var(--color-surface-3)]'
                    : 'bg-[var(--color-surface-3)] text-[var(--color-text-muted)]'}"
                >
                  <RotateCcw size={12} />
                  Reset
                </button>
                <button
                  onclick={handleSavePreferences}
                  disabled={!preferencesDirty}
                  class="flex items-center gap-1 rounded bg-[var(--color-success-bg)] px-2 py-1 text-xs text-[var(--color-success)] hover:bg-[var(--color-surface-3)] disabled:opacity-50"
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
    {/if}
  </div>
</div>

<ConfirmDialog
  open={showResetConfirmation}
  title="Restore project agent defaults?"
  message="This replaces the current project's agent permissions, workflow, quality, context, research, and routing settings with Koryphaios defaults. Preferences and skill files are not changed."
  confirmLabel="Restore defaults"
  variant="warning"
  onCancel={() => (showResetConfirmation = false)}
  onConfirm={() => {
    showResetConfirmation = false;
    void agentSettingsStore.resetSettings();
  }}
/>
