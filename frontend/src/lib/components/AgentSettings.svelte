<script lang="ts">
  import { onMount, tick } from 'svelte';
  import {
    agentSettingsStore,
    DEFAULT_AGENT_SETTINGS,
    DEFAULT_SANDBOX_SETTINGS,
  } from '$lib/stores/agent-settings.svelte';
  import SettingsSwitch from './SettingsSwitch.svelte';
  import SettingsScopeBar from './settings/SettingsScopeBar.svelte';
  import ComputerUseSettings from './ComputerUseSettings.svelte';
  import { defaultComputerUseSettings } from '@koryphaios/shared';
  import SettingsToggle from './SettingsToggle.svelte';
  import { providersStore } from '$lib/stores/providers.svelte';
  import NumberStepper from './NumberStepper.svelte';
  import KorySelect from './KorySelect.svelte';
  import CriticModeSelect from './CriticModeSelect.svelte';
  import { resolveCriticMode } from '@koryphaios/shared';
  import ConfirmDialog from './ConfirmDialog.svelte';
  import { goalDisplayStore } from '$lib/stores/goal-display.svelte';
  import { projectStore } from '$lib/stores/project.svelte';
  import { loadAgentEditorDraft, saveAgentEditorDraft } from '$lib/utils/unsaved-editor-drafts';
  import { toastStore } from '$lib/stores/toast.svelte';
  import Bot from 'lucide-svelte/icons/bot';
  import Shield from 'lucide-svelte/icons/shield';
  import FileText from 'lucide-svelte/icons/file-text';
  import AlertTriangle from 'lucide-svelte/icons/alert-triangle';
  import CheckCircle from 'lucide-svelte/icons/check-circle';
  import ChoiceCardGroup from './settings/ChoiceCardGroup.svelte';
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
    active?: boolean;
    /** Legacy navigation hook retained for callers while Skills has its own settings route. */
    onOpenSkills?: () => void;
  }

  let {
    onClose,
    focusPermissions = false,
    active = true,
    onOpenSkills: _onOpenSkills,
  }: Props = $props();

  type AgentTab = 'settings' | 'preferences' | 'skills';
  type ControlSection = 'permissions' | 'quality' | 'workflow' | 'context' | 'research' | 'routing';
  let expandedSections = $state<Record<ControlSection, boolean>>({
    permissions: true,
    quality: false,
    workflow: false,
    context: false,
    research: false,
    routing: false,
  });
  let currentSection = $state<ControlSection>('permissions');
  let criticAdvancedOpen = $state(false);
  // Sections the user has manually expanded/collapsed via the section header.
  // Picker (quick-jump) navigation auto-collapses every other expanded section
  // except these, so a user working somewhere is never force-collapsed.
  let manualSections = $state<Record<ControlSection, boolean>>({
    permissions: false,
    quality: false,
    workflow: false,
    context: false,
    research: false,
    routing: false,
  });
  function toggleSection(id: ControlSection) {
    currentSection = id;
    manualSections = { ...manualSections, [id]: true };
    expandedSections = { ...expandedSections, [id]: !expandedSections[id] };
  }

  async function navigateToSection(id: ControlSection) {
    currentSection = id;
    const next = { ...expandedSections };
    for (const key of Object.keys(next) as ControlSection[]) {
      if (key !== id && !manualSections[key]) {
        next[key] = false;
      }
    }
    next[id] = true;
    expandedSections = next;
    await tick();
    const header = document
      .getElementById(`agent-section-${id}`)
      ?.querySelector<HTMLButtonElement>('button');
    header?.focus({ preventScroll: true });
    header?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  const AGENT_TABS: readonly { id: AgentTab; label: string; icon: typeof Bot }[] = [
    { id: 'settings', label: 'Behavior', icon: Bot },
    { id: 'preferences', label: 'Preferences', icon: FileText },
  ];

  const CONTROL_SECTIONS = [
    {
      id: 'permissions',
      label: 'Permissions & autonomy',
      shortLabel: 'Permissions',
      description: 'Approvals and change limits',
      icon: LockKeyhole,
    },
    {
      id: 'workflow',
      label: 'Workflow',
      shortLabel: 'Workflow',
      description: 'Planning and learning',
      icon: GitBranch,
    },
    {
      id: 'context',
      label: 'Context & memory',
      shortLabel: 'Context',
      description: 'Context and persistence',
      icon: Brain,
    },
    {
      id: 'quality',
      label: 'Quality & Critic',
      shortLabel: 'Quality',
      description: 'Review and verification',
      icon: Gavel,
    },
    {
      id: 'routing',
      label: 'Routing & guidance',
      shortLabel: 'Routing',
      description: 'Models and manager notes',
      icon: Route,
    },
    {
      id: 'research',
      label: 'Research',
      shortLabel: 'Research',
      description: 'Search and source policy',
      icon: Search,
    },
  ] as const;

  $effect(() => {
    if (!focusPermissions) return;
    currentSection = 'permissions';
    expandedSections = { ...expandedSections, permissions: true };
  });

  // Local state for preferences editing
  let preferencesContent = $state(agentSettingsStore.preferences?.content ?? '');
  let preferencesDirty = $state(false);
  let selectedSkillKey = $state('');
  let skillDraftContent = $state('');
  let skillDraftDirty = $state(false);
  let skillPreviewPrompt = $state('');
  let skillCollisionChoices = $state<Record<string, 'personal' | 'project'>>({});
  let showSkillCreator = $state(false);
  let skillCreatorMode = $state<'template' | 'freeform'>('template');
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
    const relation = normalizeSkillName(value);
    if (!relation) return;
    newSkillBroader = [...new Set([...newSkillBroader, relation])];
    newSkillDepth = expectedSkillDepth(newSkillBroader);
  }

  function removeBroader(value: string) {
    newSkillBroader = newSkillBroader.filter((name) => name !== value);
    newSkillDepth = expectedSkillDepth(newSkillBroader);
  }

  function addTargetMedium(value: string) {
    const medium = value.trim().toLowerCase();
    if (!medium) return;
    newSkillTargetMedia =
      medium === 'any'
        ? ['any']
        : [...new Set([...newSkillTargetMedia.filter((item) => item !== 'any'), medium])];
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
    skillCreatorMode = 'template';
  }

  async function createFreeformSkill() {
    const created = await agentSettingsStore.createFreeformSkillDraft({
      source: newSkillSource,
      name: normalizeSkillName(newSkillName),
      description: newSkillDescription.trim(),
      instructions: newSkillInstructions.trim(),
    });
    if (!created) return;
    selectedSkillKey = `${created.source}:${created.name}:${created.state}`;
    skillDraftDirty = false;
    showSkillCreator = false;
    newSkillName = '';
    newSkillDescription = '';
    newSkillInstructions = '';
    skillCreatorMode = 'template';
  }

  async function runSkillPreview() {
    if (!skillPreviewPrompt.trim()) return;
    await agentSettingsStore.previewSkillResolution(
      skillPreviewPrompt.trim(),
      skillCollisionChoices,
    );
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
      id: 'ui',
      label: 'UI & frontend work',
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
  const availableModels = $derived.by(() => {
    const seen = new Set<string>();
    return providersStore.statusList
      .filter((p) => p.enabled && (p.adapterAvailable ?? p.authenticated))
      .flatMap((p) => {
        const models = p.selectedModels?.length ? p.selectedModels : (p.models ?? []);
        return models.map((model) => ({
          id: `${p.name}:${model}`,
          model,
          provider: p.name,
        }));
      })
      .filter((item) => {
        if (seen.has(item.id)) return false;
        seen.add(item.id);
        return true;
      });
  });

  function modelsFor(category: string): string[] {
    const access = agentSettingsStore.settings.managerModelAccess ?? {};
    // Existing projects may still have the pre-worker `frontend` key.
    return access[category] ?? (category === 'ui' ? (access.frontend ?? []) : []);
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
  let restoredEditorDraftScope = $state<string | null>(null);
  let restoredEditorDraftNoticeScope = $state<string | null>(null);
  let editorDraftScope = $derived(
    projectStore.currentPath ?? agentSettingsStore.preferences?.path ?? 'personal',
  );
  let managerNotesDirty = $derived(Object.values(notesDrafts).some((draft) => draft.dirty));
  let hasUnsavedEditorWork = $derived(preferencesDirty || managerNotesDirty);

  // Preferences and manager notes have an explicit Save action. Keep a
  // bounded local recovery copy between renderer restarts, scoped to the
  // current project, and publish their dirty state to Settings' close guard.
  $effect(() => {
    const scope = editorDraftScope;
    if (!active || restoredEditorDraftScope === scope) return;
    const recovered = loadAgentEditorDraft(scope);
    restoredEditorDraftScope = scope;
    let restored = false;
    if (recovered.preferences && !preferencesDirty) {
      preferencesContent = recovered.preferences;
      preferencesDirty = true;
      restored = true;
    }
    if (recovered.managerNotes) {
      for (const [groupId, text] of Object.entries(recovered.managerNotes)) {
        if (!notesDrafts[groupId]?.dirty) {
          notesDrafts[groupId] = { text, dirty: true };
          restored = true;
        }
      }
    }
    if (restored && restoredEditorDraftNoticeScope !== scope) {
      restoredEditorDraftNoticeScope = scope;
      toastStore.info('Recovered unsaved Agent settings edits on this device.');
    }
  });

  $effect(() => {
    const scope = editorDraftScope;
    if (restoredEditorDraftScope !== scope) return;
    const managerNotes = Object.fromEntries(
      Object.entries(notesDrafts)
        .filter(([, draft]) => draft.dirty)
        .map(([groupId, draft]) => [groupId, draft.text]),
    );
    saveAgentEditorDraft(scope, {
      ...(preferencesDirty ? { preferences: preferencesContent } : {}),
      ...(Object.keys(managerNotes).length ? { managerNotes } : {}),
    });
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('koryphaios:agent-settings-dirty', {
          detail: { dirty: hasUnsavedEditorWork },
        }),
      );
    }
  });
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
    const saved = await agentSettingsStore.saveSettings({
      managerNotes: allNotes as any,
    });
    if (saved) notesDrafts[groupId] = { ...draft, dirty: false };
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

  async function setAgentMessaging(mode: 'open' | 'approval-cross-project' | 'off') {
    await agentSettingsStore.saveSettings({ agentMessaging: mode }, { quietSuccess: true });
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
        { name: 'record_work_note', label: 'Record work note' },
        { name: 'create_note', label: 'Create note' },
        { name: 'update_note', label: 'Update note' },
        { name: 'link_notes', label: 'Link notes' },
        { name: 'unlink_notes', label: 'Unlink notes' },
        { name: 'delete_note', label: 'Move note to trash' },
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
        { name: 'commit_and_create_pr', label: 'Commit & create PR' },
      ],
    },
    {
      category: 'Goals & workflows',
      tools: [
        { name: 'create_goal', label: 'Create goal' },
        { name: 'update_goal', label: 'Update goal' },
        { name: 'edit_goal_checklist', label: 'Edit goal checks' },
        { name: 'list_workflows', label: 'List workflows' },
        { name: 'start_workflow', label: 'Start workflow' },
        { name: 'update_workflow', label: 'Update workflow' },
        { name: 'create_workflow_draft', label: 'Create workflow draft' },
        { name: 'prune_context', label: 'Prune context' },
      ],
    },
    {
      category: 'Checklists',
      tools: [
        { name: 'create_checklist', label: 'Create checklist' },
        { name: 'list_checklists', label: 'List checklists' },
        { name: 'read_checklist', label: 'Read checklist' },
        { name: 'add_checklist_item', label: 'Add checklist item' },
        { name: 'check_checklist_item', label: 'Check checklist item' },
        { name: 'update_checklist', label: 'Update checklist' },
        { name: 'delete_checklist', label: 'Delete checklist' },
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

  onMount(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!hasUnsavedEditorWork) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      window.removeEventListener('beforeunload', beforeUnload);
      window.dispatchEvent(
        new CustomEvent('koryphaios:agent-settings-dirty', { detail: { dirty: false } }),
      );
    };
  });

  const PERMISSION_TIER_BASE: { value: string; label: string; description: string }[] = [
    {
      value: 'ask',
      label: 'Ask',
      description:
        'Reads run automatically. File edits and actions that change state ask for approval',
    },
    { value: 'edits', label: 'Accept edits', description: 'Apply edits. Ask for other actions' },
    {
      value: 'guarded',
      label: 'Guarded',
      description: 'All edits automatic. Ask only for risky actions',
    },
    {
      value: 'yolo',
      label: 'YOLO',
      description:
        'Skip Kory approvals for allowed computer actions; explicit blocks and native failures still apply',
    },
  ];

  let permissionModeValue = $derived(
    (agentSettingsStore.settings.permissionMode ?? 'guarded') as string,
  );

  let permissionTierOptions = $derived.by(() => {
    if (permissionModeValue === 'custom') {
      return [
        ...PERMISSION_TIER_BASE,
        { value: 'custom', label: 'Custom', description: 'Use the rules below' },
      ];
    }
    return PERMISSION_TIER_BASE;
  });

  function sectionSummary(id: ControlSection): string {
    const settings = agentSettingsStore.settings;
    switch (id) {
      case 'permissions': {
        const preset =
          permissionTierOptions.find((option) => option.value === permissionModeValue)?.label ??
          'Custom';
        return `${preset} · Autonomy limits ${settings.autonomyLimitsEnabled ? 'on' : 'off'} · Sandbox ${settings.sandbox?.mode ?? 'auto'}`;
      }
      case 'workflow': {
        const execution = {
          auto: 'Auto execution',
          single: 'Single agent',
          multi: 'Multi-agent when available',
        };
        return `${execution[settings.agentExecutionMode ?? 'auto']} · ${settings.goalPlanningDepth ?? 'adaptive'} planning`;
      }
      case 'context':
        return `${(settings.autoCompactEnabled ?? true) ? `Auto-compact at ${settings.autoCompactThreshold ?? 80}%` : 'Auto-compaction off'} · Remember requests ${settings.agentCanUpdatePreferences ? 'on' : 'off'}`;
      case 'quality':
        return settings.criticGateEnabled
          ? `Critic ${resolveCriticMode(settings)} · ${settings.gateStrictness === 'advisory' ? 'Deliver with notes' : settings.gateStrictness === 'off' ? 'Quality gate off' : 'Hold delivery'} · ${settings.maxCriticIterations ?? 3} passes max`
          : 'Critic off';
      case 'routing': {
        const categories = MODEL_ACCESS_CATEGORIES.filter(
          (category) => modelsFor(category.id).length > 0,
        ).length;
        const notes = MODEL_ACCESS_CATEGORIES.filter((category) =>
          hasGroupNotes(category.id),
        ).length;
        return `${categories}/${MODEL_ACCESS_CATEGORIES.length} categories with model selections · ${notes} note groups${managerNotesDirty ? ' · Unsaved notes' : ''}`;
      }
      case 'research':
        return `Local search ${settings.localWebSearch ?? 'fallback'} · Multi-source ${settings.multiSourceResearch ? 'on' : 'off'}`;
    }
  }

  async function handlePermissionTierChange(value: string) {
    await agentSettingsStore.saveSettings(
      {
        permissionMode: value as 'yolo' | 'guarded' | 'edits' | 'ask' | 'custom',
      },
      { quietSuccess: true },
    );
  }

  let toolAccessTier = $state<string>('ask');
  $effect(() => {
    const mode = (agentSettingsStore.settings.permissionMode ?? 'ask') as string;
    if (['ask', 'edits', 'guarded', 'yolo', 'custom'].includes(mode) && toolAccessTier !== mode) {
      if (toolAccessTier === 'ask' && mode !== 'ask') {
        // keep initial 'ask' until user picks, but sync if still at default and mode changed
      }
    }
  });

  let toolAccessTierOptions = $derived.by(() => {
    const byTier = (agentSettingsStore.settings as any).toolPermissionsByTier ?? {};
    const customTier = byTier['custom'];
    const hasCustomEdits =
      (customTier &&
        (customTier.allow.length > 0 ||
          customTier.block.length > 0 ||
          (customTier.ask?.length ?? 0) > 0)) ||
      permissionModeValue === 'custom' ||
      agentSettingsStore.settings.permissionMode === 'custom';
    if (hasCustomEdits) {
      return [
        ...PERMISSION_TIER_BASE,
        { value: 'custom', label: 'Custom', description: 'Use the rules below' },
      ];
    }
    return PERMISSION_TIER_BASE;
  });

  const READ_ONLY = new Set([
    'read_file',
    'grep',
    'glob',
    'ls',
    'diff',
    'web_search',
    'web_fetch',
    'view_image',
    'fetch_context',
    'get_resource_budget',
    'load_skill_detail',
    'list_notes',
    'search_notes',
    'read_note',
    'recall_notes',
    'render_note',
    'get_note_backlinks',
    'get_note_graph_summary',
    'detect-errors',
    'analyze-error',
    'suggest-fixes',
  ]);
  const FILE_EDIT = new Set(['write_file', 'edit_file', 'batch_edit', 'patch', 'move_file']);
  const RISKY = new Set([
    'delete_file',
    'delete_note',
    'shell_manage',
    'commit_and_create_pr',
    'manage_mcp_server',
  ]);

  function tierDefault(toolName: string, tier: string): ToolAccessState | null {
    if (tier === 'yolo') return 'allow';
    if (tier === 'guarded') return RISKY.has(toolName) ? 'default' : 'allow';
    if (tier === 'edits')
      return READ_ONLY.has(toolName) || FILE_EDIT.has(toolName) ? 'allow' : 'default';
    if (tier === 'ask') return READ_ONLY.has(toolName) ? 'allow' : 'default';
    return null;
  }

  function getToolAccessStateForTier(toolName: string, tier: string): ToolAccessState {
    const tierEntry = (agentSettingsStore.settings as any).toolPermissionsByTier?.[tier];
    if (tierEntry) {
      if (tierEntry.block.includes(toolName)) return 'block';
      if (tierEntry.allow.includes(toolName)) return 'allow';
      // Explicit Ask sticks even where the preset default is Allow (e.g.
      // read-only tools in Ask mode). It renders on the Ask button.
      if (tierEntry.ask?.includes(toolName)) return 'default';
      const d = tierDefault(toolName, tier);
      if (d) return d;
      return 'default';
    }
    if (tier === 'custom') {
      const allowlist = agentSettingsStore.settings.toolAllowlist ?? [];
      const blocklist = agentSettingsStore.settings.toolBlocklist ?? [];
      if (blocklist.includes(toolName)) return 'block';
      if (allowlist.includes(toolName)) return 'allow';
    }
    const d = tierDefault(toolName, tier);
    if (d) return d;
    return 'default';
  }

  async function setToolAccessStateForTier(toolName: string, tier: string, state: ToolAccessState) {
    const currentByTier = (agentSettingsStore.settings as any).toolPermissionsByTier ?? {};
    const tierEntry = currentByTier[tier] ?? { allow: [], block: [], ask: [] };
    let allow = [...(tierEntry.allow ?? [])];
    let block = [...(tierEntry.block ?? [])];
    let ask = [...(tierEntry.ask ?? [])];
    allow = allow.filter((n) => n !== toolName);
    block = block.filter((n) => n !== toolName);
    ask = ask.filter((n) => n !== toolName);
    if (state === 'allow') allow.push(toolName);
    else if (state === 'block') block.push(toolName);
    else if (tierDefault(toolName, tier) === 'allow') {
      // Ask must stick even where the preset default is Allow (e.g. read-only
      // tools in Ask mode), so record it explicitly. Where the preset already
      // asks, clearing the override is equivalent.
      ask.push(toolName);
    }
    const nextByTier = { ...currentByTier, [tier]: { allow, block, ask } };
    if (tier === 'custom') {
      const globalAllow = [...(agentSettingsStore.settings.toolAllowlist ?? [])].filter(
        (n) => n !== toolName,
      );
      const globalBlock = [...(agentSettingsStore.settings.toolBlocklist ?? [])].filter(
        (n) => n !== toolName,
      );
      if (state === 'allow') globalAllow.push(toolName);
      else if (state === 'block') globalBlock.push(toolName);
      await agentSettingsStore.saveSettings(
        {
          toolPermissionsByTier: nextByTier,
          toolAllowlist: globalAllow,
          toolBlocklist: globalBlock,
        } as any,
        { quietSuccess: true },
      );
    } else {
      await agentSettingsStore.saveSettings({ toolPermissionsByTier: nextByTier } as any, {
        quietSuccess: true,
      });
    }
  }
</script>

<div class="agent-settings-shell flex h-full min-h-0 min-w-0 flex-col">
  <nav
    class="flex h-11 shrink-0 items-end gap-6 border-b border-[var(--color-border)] bg-[var(--color-surface-1)] px-6"
    aria-label="Agent behavior sections"
  >
    {#each AGENT_TABS as tab (tab.id)}
      <button
        type="button"
        aria-current={agentSettingsStore.activeTab === tab.id ? 'page' : undefined}
        onclick={() => agentSettingsStore.setActiveTab(tab.id)}
        class="relative flex h-full items-center gap-2 border-b-2 px-0.5 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-accent)]/60 {agentSettingsStore.activeTab ===
        tab.id
          ? 'border-[var(--color-accent)] text-[var(--color-text-primary)]'
          : 'border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]'}"
      >
        <tab.icon
          size={14}
          class={agentSettingsStore.activeTab === tab.id ? 'text-[var(--color-accent)]' : ''}
        />
        {tab.label}
      </button>
    {/each}
    <div class="ml-auto hidden self-center md:block">
      <SettingsScopeBar compact projectLabel="Project" projectSelector="current" />
    </div>
  </nav>

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
        <div class="agent-settings-content h-full min-h-0 overflow-y-auto p-4 sm:p-6">
          <div class="agent-settings-page mx-auto max-w-5xl space-y-3">
            <header class="agent-page-header">
              <div>
                <h2>Agent behavior</h2>
                <p>Set the workspace defaults for how Kory plans, acts, verifies, and remembers.</p>
              </div>
              <div class="agent-page-actions">
                <div class="agent-page-summary" aria-label="Current agent posture">
                  <span>{permissionModeValue}</span>
                  <span>Critic {resolveCriticMode(agentSettingsStore.settings)}</span>
                  <span>Sandbox: {agentSettingsStore.settings.sandbox?.mode ?? 'auto'}</span>
                  <span
                    >Computer: {agentSettingsStore.settings.computerUse?.enabled
                      ? 'On'
                      : 'Off'}</span
                  >
                </div>
                <button
                  type="button"
                  class="agent-reset-action"
                  onclick={() => (showResetConfirmation = true)}
                >
                  <RotateCcw size={14} /> Reset agent settings
                </button>
              </div>
            </header>
            <nav class="agent-section-index" aria-label="Behavior section index">
              {#each CONTROL_SECTIONS as section (section.id)}
                <button
                  type="button"
                  aria-label={section.label}
                  aria-current={currentSection === section.id ? 'location' : undefined}
                  title={`Jump to ${section.label}`}
                  onclick={() => void navigateToSection(section.id)}>{section.shortLabel}</button
                >
              {/each}
            </nav>
            {#each CONTROL_SECTIONS as section (section.id)}
              <div
                id={`agent-section-${section.id}`}
                class="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-1)] overflow-hidden"
                onfocusin={() => (currentSection = section.id)}
              >
                <button
                  type="button"
                  class="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-[var(--color-surface-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-accent)]/60"
                  onclick={() => toggleSection(section.id)}
                  aria-expanded={expandedSections[section.id]}
                  aria-controls={expandedSections[section.id]
                    ? `agent-panel-${section.id}`
                    : undefined}
                >
                  <span class="flex items-center gap-3">
                    <span
                      class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--color-surface-2)] text-[var(--color-text-secondary)]"
                      ><section.icon size={15} /></span
                    >
                    <span>
                      <span class="block text-sm font-medium text-[var(--color-text-primary)]"
                        >{section.label}</span
                      >
                      <span class="block mt-0.5 text-[11px] text-[var(--color-text-muted)]"
                        >{sectionSummary(section.id)}</span
                      >
                    </span>
                  </span>
                  <ChevronRight
                    size={16}
                    class="shrink-0 text-[var(--color-text-muted)] transition-transform {expandedSections[
                      section.id
                    ]
                      ? 'rotate-90'
                      : ''}"
                  />
                </button>
                {#if section.id === 'permissions' && expandedSections.permissions}
                  <div id="agent-panel-permissions" class="border-t border-[var(--color-border)]">
                    <section class="space-y-5 p-5">
                      <div>
                        <h4 class="text-sm font-semibold text-[var(--color-text-primary)]">
                          Approval preset
                        </h4>
                        <p class="mt-1 text-xs leading-relaxed text-[var(--color-text-muted)]">
                          Choose a preset or build a custom approval policy for this workspace. This
                          is the default for new chats; the composer's permission pill overrides it
                          per chat.
                        </p>
                      </div>

                      <ChoiceCardGroup
                        label="Permission mode"
                        value={agentSettingsStore.settings.permissionMode ?? 'guarded'}
                        columns="sm:grid-cols-2 xl:grid-cols-5"
                        options={[
                          {
                            value: 'guarded',
                            label: 'Guarded',
                            description: 'All edits automatic. Ask only for risky actions',
                          },
                          {
                            value: 'edits',
                            label: 'Accept edits',
                            description: 'Apply edits. Ask for other actions',
                          },
                          {
                            value: 'ask',
                            label: 'Ask',
                            description:
                              'Reads run automatically. File edits and actions that change state ask for approval',
                          },
                          {
                            value: 'custom',
                            label: 'Custom',
                            description: 'Use the rules below',
                          },
                          {
                            value: 'yolo',
                            label: 'YOLO',
                            description:
                              'Skip Kory approvals for allowed computer actions; explicit blocks and native failures still apply',
                          },
                        ]}
                        onchange={(value) =>
                          agentSettingsStore.saveSettings(
                            {
                              permissionMode: value as
                                'yolo' | 'guarded' | 'edits' | 'ask' | 'custom',
                            },
                            { quietSuccess: true },
                          )}
                      />

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

                    <section class="space-y-5 border-t border-[var(--color-border)] p-5">
                      <div class="space-y-1">
                        <h4 class="text-sm font-semibold text-[var(--color-text-primary)]">
                          Autonomy limits
                        </h4>
                        <p class="text-xs text-[var(--color-text-muted)]">
                          Keep thresholds ready, then explicitly turn them on for runs that need an
                          approval boundary.
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
                        <div
                          class="divide-y divide-[var(--color-border)] overflow-hidden rounded-xl bg-[var(--color-surface-2)]"
                        >
                          <div class="flex items-center justify-between gap-4 px-3 py-2.5">
                            <label
                              for="max-files"
                              class="text-xs font-medium text-[var(--color-text-secondary)]"
                              >Max files changed</label
                            >
                            <div class="w-32 shrink-0">
                              <NumberStepper
                                value={agentSettingsStore.settings.approvalThresholdFiles}
                                min={1}
                                max={50}
                                compact
                                quiet
                                label="Maximum files changed"
                                onchange={(value) =>
                                  agentSettingsStore.saveSettings(
                                    { approvalThresholdFiles: value },
                                    { quietSuccess: true },
                                  )}
                              />
                            </div>
                          </div>

                          <div class="flex items-center justify-between gap-4 px-3 py-2.5">
                            <label
                              for="max-lines"
                              class="text-xs font-medium text-[var(--color-text-secondary)]"
                              >Max lines changed</label
                            >
                            <div class="w-32 shrink-0">
                              <NumberStepper
                                value={agentSettingsStore.settings.approvalThresholdLines}
                                min={10}
                                max={1000}
                                step={10}
                                compact
                                quiet
                                label="Maximum lines changed"
                                onchange={(value) =>
                                  agentSettingsStore.saveSettings(
                                    { approvalThresholdLines: value },
                                    { quietSuccess: true },
                                  )}
                              />
                            </div>
                          </div>
                        </div>
                      </div>
                    </section>

                    <section class="space-y-5 border-t border-[var(--color-border)] p-5">
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

                      <ChoiceCardGroup
                        label="Execution sandbox mode"
                        value={agentSettingsStore.settings.sandbox?.mode ?? 'auto'}
                        columns="sm:grid-cols-3"
                        options={[
                          {
                            value: 'auto',
                            label: 'Auto',
                            description: 'Sandbox plan, critic, and worker execution only.',
                          },
                          {
                            value: 'always',
                            label: 'Always',
                            description:
                              'Sandbox every agent bash call, including the direct manager.',
                          },
                          {
                            value: 'off',
                            label: 'Off',
                            description:
                              'No sandbox. Catastrophic-command and approval prompts still apply.',
                          },
                        ]}
                        onchange={(value) => setSandboxMode(value as 'auto' | 'always' | 'off')}
                      />

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
                              checked={agentSettingsStore.settings.sandbox?.metacharacters ?? true}
                              label="Block shell metacharacters"
                              description="Block pipes, command substitution, and chaining. Disabling lets commands like `git add && git commit` run."
                              onchange={() => toggleSandboxFlag('metacharacters')}
                            />
                            <SettingsSwitch
                              checked={agentSettingsStore.settings.sandbox?.pathConfinement ?? true}
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
                              checked={agentSettingsStore.settings.sandbox?.containerTools ?? true}
                              label="Block container tools"
                              description="Block docker, podman, and similar container tools while sandboxed."
                              onchange={() => toggleSandboxFlag('containerTools')}
                            />
                          </div>
                        </div>
                      {/if}
                    </section>

                    <section class="space-y-5 border-t border-[var(--color-border)] p-5">
                      <div class="space-y-1">
                        <h4
                          class="flex items-center gap-2 text-sm font-semibold text-[var(--color-text-primary)]"
                        >
                          <Users size={16} class="text-[var(--color-accent)]" />
                          Sub-agent approval
                        </h4>
                        <p class="text-xs text-[var(--color-text-muted)]">
                          Control how worker sub-agents (specialist workers spawned by the manager)
                          are gated when they run tools.
                        </p>
                      </div>

                      <ChoiceCardGroup
                        label="Sub-agent approval"
                        value={agentSettingsStore.settings.subAgentApproval ?? 'manager'}
                        columns="sm:grid-cols-3"
                        options={[
                          {
                            value: 'manager',
                            label: 'Manager decides',
                            description:
                              'In Guarded mode, the manager reviews worker actions. Other presets use their normal user-facing approval behavior.',
                          },
                          {
                            value: 'user',
                            label: 'I decide',
                            description:
                              'Workers can read and search freely, but every file edit, bash command, and risky action prompts you before running.',
                          },
                          {
                            value: 'auto',
                            label: 'Auto-approve',
                            description:
                              'Workers run with no approval prompts. Workspace sandbox settings still apply, and catastrophic-command hard floors remain.',
                          },
                        ]}
                        onchange={(value) =>
                          setSubAgentApproval(value as 'manager' | 'user' | 'auto')}
                      />

                      {#if (agentSettingsStore.settings.subAgentApproval ?? 'manager') === 'auto'}
                        <div
                          class="flex gap-2 rounded-xl border border-[var(--color-warning)] bg-[var(--color-warning-bg)] p-3 text-[11px] text-[var(--color-warning)]"
                        >
                          <AlertTriangle size={16} class="shrink-0" />
                          <span
                            >Automatic approval removes worker approval prompts. Workspace sandbox
                            settings still apply. Only enable this for trusted, isolated work.
                            Catastrophic commands (rm -rf /, mkfs, etc.) are still blocked by the
                            hard floor.</span
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
                            bash command, and risky action will pause for your approval. This gives
                            you control over mutations without slowing down exploration.</span
                          >
                        </div>
                      {/if}
                    </section>

                    <section class="space-y-5 border-t border-[var(--color-border)] p-5">
                      <div class="space-y-1">
                        <h4
                          class="flex items-center gap-2 text-sm font-semibold text-[var(--color-text-primary)]"
                        >
                          <Shield size={16} class="text-[var(--color-accent)]" />
                          Inter-agent messaging
                        </h4>
                        <p class="text-xs text-[var(--color-text-muted)]">
                          Agents can message other agents within this project, and managers can
                          message the manager of another open project. Sub-agents always route
                          through their own manager.
                        </p>
                      </div>

                      <ChoiceCardGroup
                        label="Inter-agent messaging"
                        value={agentSettingsStore.settings.agentMessaging ?? 'open'}
                        columns="sm:grid-cols-3"
                        options={[
                          {
                            value: 'open',
                            label: 'Open',
                            description:
                              'Messages are delivered automatically with no approval prompt. A full audit log stays in the messages panel.',
                          },
                          {
                            value: 'approval-cross-project',
                            label: 'Approve cross project',
                            description:
                              'Messages within the same project flow freely. Messages to another project manager wait for your approval first.',
                          },
                          {
                            value: 'off',
                            label: 'Off',
                            description:
                              'Disable the agent mailbox entirely. Agents keep their normal manager and worker delegation.',
                          },
                        ]}
                        onchange={(value) =>
                          setAgentMessaging(value as 'open' | 'approval-cross-project' | 'off')}
                      />
                    </section>

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
                          Override the permission preset for individual tools. <strong>Allow</strong
                          >
                          always runs without prompting.
                          <strong>Block</strong> denies the tool entirely.
                          <strong>Ask</strong> always prompts for approval.
                        </p>
                      </div>

                      <KorySelect
                        value={toolAccessTier}
                        options={toolAccessTierOptions}
                        label="Permission tier to customize"
                        description="Select which tier these tool overrides apply to. Allow, Ask, or Block below is saved for that tier"
                        onchange={(value) => (toolAccessTier = value)}
                      />

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
                                {@const state = getToolAccessStateForTier(
                                  tool.name,
                                  toolAccessTier,
                                )}
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
                                          setToolAccessStateForTier(
                                            tool.name,
                                            toolAccessTier,
                                            opt as ToolAccessState,
                                          )}
                                        class="rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors duration-150 {isActive
                                          ? opt === 'allow'
                                            ? 'bg-[var(--color-success-bg)] text-[var(--color-success)]'
                                            : opt === 'block'
                                              ? 'bg-[var(--color-error-bg)] text-[var(--color-error)]'
                                              : 'bg-[var(--color-surface-1)] text-[var(--color-text-primary)]'
                                          : 'text-[var(--color-text-muted)] hover:bg-[var(--color-surface-1)]/60 hover:text-[var(--color-text-secondary)]'}"
                                      >
                                        {opt === 'allow'
                                          ? 'Allow'
                                          : opt === 'block'
                                            ? 'Block'
                                            : 'Ask'}
                                      </button>
                                    {/each}
                                  </div>
                                </div>
                              {/each}
                            </div>
                          </div>
                        {/each}
                      </div>

                      {#if ((agentSettingsStore.settings as any).toolPermissionsByTier?.[toolAccessTier]?.allow.length ?? 0) > 0 || ((agentSettingsStore.settings as any).toolPermissionsByTier?.[toolAccessTier]?.block.length ?? 0) > 0 || ((agentSettingsStore.settings as any).toolPermissionsByTier?.[toolAccessTier]?.ask?.length ?? 0) > 0}
                        <div
                          class="flex items-center justify-between border-t border-[var(--color-border)] pt-3"
                        >
                          <span class="text-[10px] text-[var(--color-text-muted)]">
                            {(agentSettingsStore.settings as any).toolPermissionsByTier?.[
                              toolAccessTier
                            ]?.allow.length ?? 0} allowed · {(agentSettingsStore.settings as any)
                              .toolPermissionsByTier?.[toolAccessTier]?.ask?.length ?? 0} ask · {(
                              agentSettingsStore.settings as any
                            ).toolPermissionsByTier?.[toolAccessTier]?.block.length ?? 0} blocked in {toolAccessTier}
                          </span>
                          <button
                            type="button"
                            class="text-[10px] text-[var(--color-text-muted)] underline hover:text-[var(--color-text-secondary)]"
                            onclick={async () => {
                              const next = {
                                ...((agentSettingsStore.settings as any).toolPermissionsByTier ??
                                  {}),
                              };
                              delete next[toolAccessTier];
                              const patch: Record<string, unknown> = {
                                toolPermissionsByTier: next,
                              };
                              if (toolAccessTier === 'custom') {
                                (patch as any).toolAllowlist = [];
                                (patch as any).toolBlocklist = [];
                              }
                              await agentSettingsStore.saveSettings(patch as any, {
                                quietSuccess: true,
                              });
                            }}
                          >
                            Reset {toolAccessTier} to ask
                          </button>
                        </div>
                      {/if}
                    </section>
                  </div>
                  {#key editorDraftScope}
                    <ComputerUseSettings
                      settings={agentSettingsStore.settings.computerUse ??
                        defaultComputerUseSettings()}
                      saving={agentSettingsStore.settingsSaving}
                      onstopped={() => agentSettingsStore.loadSettings()}
                      onchange={(computerUse) =>
                        agentSettingsStore.saveSettings({ computerUse }, { quietSuccess: true })}
                    />
                  {/key}
                {:else if section.id === 'quality' && expandedSections.quality}
                  <div id="agent-panel-quality" class="quality-content">
                    <section class="quality-primary">
                      <div class="quality-copy">
                        <div class="quality-title-row">
                          <Shield size={16} class="text-[var(--color-accent)]" />
                          <div>
                            <h4>Critic quality gate</h4>
                            <p>
                              Have a second agent verify completion claims before Kory delivers the
                              result. The chat-level Critic control can override this workspace
                              default.
                            </p>
                          </div>
                        </div>
                        <CriticModeSelect
                          value={resolveCriticMode(agentSettingsStore.settings)}
                          onchange={(criticMode) =>
                            agentSettingsStore.saveSettings(
                              { criticMode, criticGateEnabled: criticMode !== 'off' },
                              { quietSuccess: true },
                            )}
                        />
                      </div>
                    </section>

                    <div class="quality-advanced-toggle">
                      <div>
                        <strong>Advanced review settings</strong>
                        <span>
                          {agentSettingsStore.settings.gateStrictness === 'advisory'
                            ? 'Report issues and deliver'
                            : 'Hold delivery until resolved'}
                          · {agentSettingsStore.settings.maxCriticIterations ?? 3} passes max
                        </span>
                      </div>
                      <button
                        type="button"
                        class="text-action"
                        disabled={!agentSettingsStore.settings.criticGateEnabled}
                        aria-expanded={criticAdvancedOpen}
                        onclick={() => (criticAdvancedOpen = !criticAdvancedOpen)}
                        >{criticAdvancedOpen ? 'Hide' : 'Customize'}</button
                      >
                    </div>

                    {#if criticAdvancedOpen}
                      <div class="quality-advanced">
                        <KorySelect
                          label="When Critic finds an issue"
                          value={agentSettingsStore.settings.gateStrictness ?? 'strict'}
                          disabled={!agentSettingsStore.settings.criticGateEnabled}
                          options={[
                            { value: 'strict', label: 'Hold delivery · fix first' },
                            { value: 'advisory', label: 'Deliver with notes' },
                            { value: 'off', label: 'Off · mark work unverified' },
                          ]}
                          onchange={(value) =>
                            agentSettingsStore.saveSettings(
                              { gateStrictness: value as 'strict' | 'advisory' | 'off' },
                              { quietSuccess: true },
                            )}
                        />
                        <div class="quality-passes">
                          <div>
                            <div class="text-xs font-medium text-[var(--color-text-secondary)]">
                              Maximum repair passes
                            </div>
                            <p>
                              Limits delegated repair attempts; it does not invent a passing
                              verdict.
                            </p>
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
                        </div>
                      </div>
                    {/if}
                  </div>
                {:else if section.id === 'workflow' && expandedSections.workflow}
                  <div
                    id="agent-panel-workflow"
                    class="border-t border-[var(--color-border)] divide-y divide-[var(--color-border)]"
                  >
                    <section class="space-y-4 p-5">
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
                          description="How many clarifying questions Kory asks before starting work."
                          value={agentSettingsStore.settings.intentInterview ?? 'adaptive'}
                          options={[
                            {
                              value: 'off',
                              label: 'Off',
                              description: 'Start working immediately without follow-up questions.',
                            },
                            {
                              value: 'adaptive',
                              label: 'Adaptive',
                              description:
                                'Ask a few targeted questions when the task is vague or complex.',
                            },
                            {
                              value: 'deep',
                              label: 'Deep',
                              description:
                                'Conduct a thorough Q&A to fully define the request before acting.',
                            },
                          ]}
                          onchange={(value) =>
                            agentSettingsStore.saveSettings(
                              { intentInterview: value as 'off' | 'adaptive' | 'deep' },
                              { quietSuccess: true },
                            )}
                        />
                        <KorySelect
                          label="Execution strategy"
                          description="How Kory distributes work across one or many agents. This is the workspace default; the composer's Agent Mode pill overrides it per chat."
                          value={agentSettingsStore.settings.agentExecutionMode ?? 'auto'}
                          options={[
                            {
                              value: 'auto',
                              label: 'Auto · choose for the task',
                              description:
                                'Let Kory decide when a single agent or multiple agents fit best.',
                            },
                            {
                              value: 'single',
                              label: 'Single agent',
                              description: 'Run the entire task through one agent.',
                            },
                            {
                              value: 'multi',
                              label: 'Multi-agent when available',
                              description:
                                'Use multiple agents in parallel whenever the task allows it.',
                            },
                          ]}
                          onchange={(value) =>
                            agentSettingsStore.saveSettings(
                              { agentExecutionMode: value as 'auto' | 'single' | 'multi' },
                              { quietSuccess: true },
                            )}
                        />
                        <KorySelect
                          label="Goal planning"
                          description="How Kory breaks tasks into tracked goals before acting."
                          value={agentSettingsStore.settings.goalPlanningDepth ?? 'adaptive'}
                          options={[
                            {
                              value: 'minimal',
                              label: 'Minimal',
                              description: 'Use goals only when the task is large or complex.',
                            },
                            {
                              value: 'adaptive',
                              label: 'Adaptive',
                              description: 'Plan goals based on task size and uncertainty.',
                            },
                            {
                              value: 'structured',
                              label: 'Structured',
                              description:
                                'Always create a step-by-step goal plan before starting work.',
                            },
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
                          description="How Kory may create or install new skills from your sessions."
                          value={agentSettingsStore.settings.skillLearningMode ??
                            'propose-then-verify'}
                          options={[
                            {
                              value: 'human-only',
                              label: 'Human only',
                              description:
                                'Never create or install a skill without your explicit approval.',
                            },
                            {
                              value: 'propose-then-verify',
                              label: 'Propose then verify',
                              description:
                                'Suggest new skills and wait for your approval before installing.',
                            },
                            {
                              value: 'automatic',
                              label: 'Automatic, reversible',
                              description:
                                'Create skills automatically. You can undo or remove them later.',
                            },
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
                        checked={goalDisplayStore.composer}
                        label="Show Goal Mode in composer"
                        description="Keep goal quick controls and full goal detail in the bubble above the chat."
                        onchange={() =>
                          goalDisplayStore.update({ composer: !goalDisplayStore.composer })}
                      />
                    </section>
                  </div>
                {:else if section.id === 'context' && expandedSections.context}
                  <div
                    id="agent-panel-context"
                    class="border-t border-[var(--color-border)] divide-y divide-[var(--color-border)]"
                  >
                    <section class="space-y-4 p-5">
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
                        <KorySelect
                          label="Prompt Cache Keepalive"
                          value={agentSettingsStore.settings.promptCacheKeepaliveMode ?? 'economic'}
                          description="Economic refreshes only when expected cache savings exceed the replay cost. Always keeps eligible lanes armed. Off disables unattended refreshes."
                          options={[
                            { value: 'economic', label: 'Economic · positive value only' },
                            { value: 'always', label: 'Always · keep eligible lanes armed' },
                            { value: 'off', label: 'Off · no unattended refresh' },
                          ]}
                          onchange={(value) =>
                            agentSettingsStore.saveSettings(
                              { promptCacheKeepaliveMode: value as 'economic' | 'always' | 'off' },
                              { quietSuccess: true },
                            )}
                        />

                        <SettingsSwitch
                          checked={agentSettingsStore.settings.contextPruningEnabled ?? true}
                          label="Auto-Collapse Old Tool Output"
                          description="Stub stale file reads, terminal output, and search results while keeping them recoverable."
                          onchange={() => toggleSetting('contextPruningEnabled')}
                        />

                        <SettingsSwitch
                          checked={agentSettingsStore.settings.promptCacheColdPrewarmEnabled ??
                            false}
                          label="Cold Prompt Prewarm"
                          description="While typing before a cache lane exists, optionally warm the provider prefix. This can reduce first-turn latency but may create an extra billable cache write. Warm lane refreshes stay automatic and economics gated."
                          onchange={() => toggleSetting('promptCacheColdPrewarmEnabled')}
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
                          description={`After a completed turn reaches ${agentSettingsStore.settings.autoCompactThreshold ?? 80}% context pressure, schedule recoverable compaction. Warm standing prompts get a bounded allowance; room for the next reply stays protected.`}
                          onchange={() => toggleSetting('autoCompactEnabled')}
                        />

                        <SettingsSwitch
                          checked={agentSettingsStore.settings.reasoningExpandedByDefault ?? false}
                          label="Expand Full Reasoning by Default"
                          description="Show reasoning automatically while keeping every block individually collapsible."
                          onchange={() => toggleSetting('reasoningExpandedByDefault')}
                        />

                        <div
                          class="agent-subpanel rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-4"
                        >
                          <SettingsSwitch
                            checked={(agentSettingsStore.settings.skillContextBudget ?? null) !==
                              null}
                            label="Limit Skill Context"
                            description="Off by default for normal users. Turn this on for cost-sensitive setups to cap injected skill characters per turn; guidance is never blocked."
                            onchange={() => {
                              void agentSettingsStore.saveSettings(
                                {
                                  skillContextBudget:
                                    (agentSettingsStore.settings.skillContextBudget ?? null) !==
                                    null
                                      ? null
                                      : 30000,
                                },
                                { quietSuccess: true },
                              );
                            }}
                          />
                          <div class="mt-3">
                            <NumberStepper
                              value={agentSettingsStore.settings.skillContextBudget ?? 30000}
                              min={4000}
                              max={400000}
                              step={1000}
                              unit="chars"
                              label="Maximum injected skill characters per turn"
                              disabled={(agentSettingsStore.settings.skillContextBudget ?? null) ===
                                null}
                              onchange={(value) =>
                                agentSettingsStore.saveSettings(
                                  { skillContextBudget: value },
                                  { quietSuccess: true },
                                )}
                            />
                          </div>
                          <p class="mt-2 text-[10px] text-[var(--color-text-muted)]">
                            Individual skills carry their own advisory <code>contextBudget</code> in frontmatter.
                            Those are authoring metadata only and never block a turn.
                          </p>
                        </div>

                        <div
                          class="agent-subpanel rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-4"
                        >
                          <label
                            for="ctx-compact-threshold"
                            class="mb-2 block text-xs font-medium text-[var(--color-text-secondary)]"
                            >Compaction Trigger</label
                          >
                          <NumberStepper
                            value={agentSettingsStore.settings.autoCompactThreshold ?? 80}
                            min={10}
                            max={99}
                            step={1}
                            unit="%"
                            label="Context window percentage that triggers compaction"
                            disabled={!(agentSettingsStore.settings.autoCompactEnabled ?? true)}
                            onchange={(value) =>
                              agentSettingsStore.saveSettings(
                                { autoCompactThreshold: value },
                                { quietSuccess: true },
                              )}
                          />
                          <p class="mt-2 text-[10px] text-[var(--color-text-muted)]">
                            Uses the session's context budget. Cached standing instructions can
                            defer this trigger by at most 10 percentage points; cached chat and tool
                            history still count. Real occupancy near the limit can trigger earlier
                            to leave room for the next reply. Approximate CLI usage never triggers
                            compaction.
                          </p>
                        </div>

                        <div
                          class="agent-subpanel rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-4"
                        >
                          <label
                            for="ctx-keep-turns"
                            class="mb-2 block text-xs font-medium text-[var(--color-text-secondary)]"
                            >Keep Recent Turns Full</label
                          >
                          <NumberStepper
                            value={agentSettingsStore.settings.contextKeepRecentTurns ?? 8}
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

                        <div
                          class="agent-subpanel rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-4"
                        >
                          <label
                            for="ctx-min-chars"
                            class="mb-2 block text-xs font-medium text-[var(--color-text-secondary)]"
                            >Minimum Size to Collapse</label
                          >
                          <NumberStepper
                            value={agentSettingsStore.settings.contextPruneMinChars ?? 2000}
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
                            Outputs smaller than this (characters) stay in context. It is not worth
                            collapsing.
                          </p>
                        </div>
                      </div>
                    </section>

                    <section class="space-y-4 p-5">
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
                          description="Persist only requests that explicitly say remember or always. Ordinary conversation never writes project preferences."
                          onchange={() => toggleSetting('agentCanUpdatePreferences')}
                        />
                      </div>
                    </section>
                  </div>
                {:else if section.id === 'research' && expandedSections.research}
                  <div
                    id="agent-panel-research"
                    class="border-t border-[var(--color-border)] divide-y divide-[var(--color-border)]"
                  >
                    <section class="space-y-4 p-5">
                      <div class="flex items-center gap-2 text-[var(--color-warning)]">
                        <FlaskConical size={16} />
                        <h4 class="text-sm font-semibold">Research</h4>
                      </div>

                      <div class="space-y-3">
                        <div
                          class="agent-subpanel rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-4"
                        >
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
                          description="Require verification across 3 to 5 sources for research tasks."
                          onchange={() => toggleSetting('multiSourceResearch')}
                        />
                      </div>
                    </section>
                  </div>
                {:else if section.id === 'routing' && expandedSections.routing}
                  <div
                    id="agent-panel-routing"
                    class="border-t border-[var(--color-border)] divide-y divide-[var(--color-border)]"
                  >
                    <section class="p-5">
                      <div class="routing-explainer">
                        <div class="routing-explainer-title">How Kory chooses a sub-agent</div>
                        <ol>
                          <li>The manager classifies the task into a work category.</li>
                          <li>
                            It considers only the provider:model identities enabled for that
                            category below.
                          </li>
                          <li>
                            It prefers a qualified model on a different provider from the manager,
                            then ranks the remaining candidates for the task.
                          </li>
                        </ol>
                        <p>
                          If no independent candidate is available, Kory reuses the manager model
                          and tells you which provider and model it used. An explicit model selected
                          in the composer still controls the manager itself.
                        </p>
                      </div>
                      <button
                        type="button"
                        class="flex w-full items-start justify-between gap-4 text-left"
                        aria-expanded={showModelAccess}
                        onclick={() => (showModelAccess = !showModelAccess)}
                      >
                        <span>
                          <span class="block text-sm font-semibold text-[var(--color-text-primary)]"
                            >Routing access</span
                          >
                          <span class="mt-1 block text-xs text-[var(--color-text-muted)]"
                            >Choose the provider:model identities available to Kory for each
                            category. Your explicit composer choice still controls the manager.</span
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
                              class="agent-subpanel rounded-xl p-4"
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
                                  {#each availableModels as m (m.id)}
                                    {@const checked = modelsFor(cat.id).includes(m.id)}
                                    <div
                                      class="flex min-w-0 items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-xs transition-colors"
                                      style="background: {checked
                                        ? 'color-mix(in srgb, var(--color-accent) 9%, var(--color-surface-2))'
                                        : 'var(--color-surface-2)'}; border: 1px solid {checked
                                        ? 'color-mix(in srgb, var(--color-accent) 38%, var(--color-border))'
                                        : 'var(--color-border)'};"
                                    >
                                      <span
                                        class="min-w-0 truncate text-[var(--color-text-primary)]"
                                      >
                                        <span class="block truncate font-mono">{m.model}</span>
                                        <span
                                          class="mt-0.5 block truncate text-[10px] text-[var(--color-text-muted)]"
                                          >{m.provider}</span
                                        >
                                      </span>
                                      <SettingsToggle
                                        {checked}
                                        label={`Allow ${m.provider}:${m.model} for ${cat.label}`}
                                        onchange={() => void toggleCategoryModel(cat.id, m.id)}
                                      />
                                    </div>
                                  {/each}
                                </div>
                              {/if}
                            </div>
                          {/each}
                        </div>
                      {/if}
                      <div class="mt-6 border-t border-[var(--color-border)] pt-6">
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
                              class="agent-subpanel rounded-xl overflow-hidden"
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
                      </div>
                    </section>
                  </div>
                {/if}
              </div>
            {/each}
          </div>
        </div>
      </div>
    {:else if agentSettingsStore.activeTab === 'skills'}
      <div class="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <Boxes size={28} class="text-[var(--color-accent)]" />
        <h3 class="text-lg font-semibold">Skills have their own workspace</h3>
        <p class="text-sm text-[var(--color-text-muted)]">
          Write, test, and activate reusable instructions from Knowledge → Skills.
        </p>
      </div>
    {:else if Boolean(agentSettingsStore.skills) && false}
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
                    {skillCreatorMode === 'template'
                      ? 'Start with concrete triggers, non-triggers, a real workflow, and evidence. The draft stays inactive until its trigger tests pass and you activate it.'
                      : 'Write the skill in your own words without completing the routing template. You can edit its generated metadata before activation.'}
                  </p>
                </div>
                <div class="flex shrink-0 items-center gap-1.5">
                  <button
                    type="button"
                    onclick={() =>
                      (skillCreatorMode =
                        skillCreatorMode === 'template' ? 'freeform' : 'template')}
                    class="rounded-md border border-[var(--color-border)] px-2.5 py-1 text-[10px] font-medium text-[var(--color-text-secondary)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
                    >{skillCreatorMode === 'template' ? 'Skip template' : 'Use template'}</button
                  >
                  <button
                    type="button"
                    onclick={() => (showSkillCreator = false)}
                    class="rounded-md px-2 py-1 text-[10px] text-[var(--color-text-muted)] hover:bg-[var(--color-surface-3)]"
                    >Close</button
                  >
                </div>
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
                        allowCustom
                        value=""
                        label="Add broader concept"
                        placeholder="Add a broader discipline…"
                        customLabel="Custom skill ID"
                        customPlaceholder="Type a skill ID…"
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
                        allowCustom
                        value=""
                        label="Add cross-cutting facet"
                        placeholder="Add a professional facet…"
                        customLabel="Custom skill ID"
                        customPlaceholder="Type a skill ID…"
                        options={skillRelationOptions(newSkillFacets)}
                        onchange={(value) => {
                          const relation = normalizeSkillName(value);
                          if (relation)
                            newSkillFacets = [...new Set([...newSkillFacets, relation])];
                        }}
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
                        allowCustom
                        value=""
                        label="Add required skill"
                        placeholder="Add a required skill…"
                        customLabel="Custom skill ID"
                        customPlaceholder="Type a skill ID…"
                        options={skillRelationOptions(newSkillRequires)}
                        onchange={(value) => {
                          const relation = normalizeSkillName(value);
                          if (relation)
                            newSkillRequires = [...new Set([...newSkillRequires, relation])];
                        }}
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
                        allowCustom
                        value=""
                        label="Add conflicting skill"
                        placeholder="Add an incompatible skill…"
                        customLabel="Custom skill ID"
                        customPlaceholder="Type a skill ID…"
                        options={skillRelationOptions(newSkillConflicts)}
                        onchange={(value) => {
                          const relation = normalizeSkillName(value);
                          if (relation)
                            newSkillConflicts = [...new Set([...newSkillConflicts, relation])];
                        }}
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
                    allowCustom
                    value=""
                    label="Add target medium"
                    placeholder="Add a target medium…"
                    customLabel="Custom medium"
                    customPlaceholder="Type your own medium…"
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
            {@const preview = agentSettingsStore.skillResolutionPreview!}
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
                }}
                class="mb-1 w-full rounded-lg border py-2 pr-2.5 text-left transition-colors {selectedSkill?.name ===
                  skill.name &&
                selectedSkill?.source === skill.source &&
                selectedSkill?.state === skill.state
                  ? 'border-[var(--color-accent)] bg-[var(--color-surface-3)]'
                  : 'border-transparent hover:bg-[var(--color-surface-2)]'}"
                style="padding-left: 10px"
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
                  {@const gate = selectedSkillEvaluation!.gate}
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
                    {selectedSkillEvaluation!.cases.length} evaluation cases are derived from the skill’s
                    visible trigger and non-trigger contract. No model score is shown until evidence is
                    recorded.
                  </div>
                {:else}
                  Loading the evidence card…
                {/if}
              </div>
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
      <div class="preferences-settings-scroll h-full min-h-0 overflow-y-auto">
        <div class="preferences-settings-page">
          <header class="preferences-page-header">
            <div>
              <h2>Workflow preferences</h2>
              <p>Plain-language rules and standards Kory should follow in this project.</p>
              {#if prefs?.exists}
                <span class="preferences-file-meta"><CheckCircle size={13} /> {prefs.path}</span>
              {:else}
                <span class="preferences-file-meta warning"
                  ><AlertTriangle size={13} /> Not initialized</span
                >
              {/if}
            </div>
            <div class="preferences-page-actions">
              {#if !prefs?.exists}
                <button
                  type="button"
                  class="preferences-primary-action"
                  onclick={() => agentSettingsStore.initializePreferences()}
                >
                  <Plus size={14} /> Initialize preferences
                </button>
              {:else}
                <button
                  type="button"
                  class="preferences-text-action"
                  onclick={handleResetPreferences}
                  disabled={!preferencesDirty}
                >
                  <RotateCcw size={14} /> Reset
                </button>
                <button
                  type="button"
                  class="preferences-primary-action"
                  onclick={handleSavePreferences}
                  disabled={!preferencesDirty}
                >
                  <Save size={14} /> Save changes
                </button>
              {/if}
            </div>
          </header>

          <section class="preferences-editor-section" aria-labelledby="preferences-editor-title">
            <div class="preferences-section-heading">
              <div>
                <h3 id="preferences-editor-title">Project rules</h3>
                <p>
                  These instructions are supplied to the manager and critic when they work in this
                  project.
                </p>
              </div>
              {#if preferencesDirty}<span class="preferences-unsaved" role="status"
                  >Unsaved changes</span
                >{/if}
            </div>
            {#if !prefs?.exists}
              <div class="preferences-empty-state">
                <FileText size={32} />
                <strong>No preferences file yet</strong>
                <span>Initialize a thoughtful starter template, then make it yours.</span>
              </div>
            {:else}
              <textarea
                bind:value={preferencesContent}
                oninput={(e) => handlePreferencesChange(e.currentTarget.value)}
                placeholder="Define your workflow preferences and rules..."
                class="preferences-editor"
                spellcheck="false"
              ></textarea>
            {/if}
          </section>

          <footer class="preferences-page-footer">
            <span>Stored locally in this project. Changes apply to future agent work.</span>
            {#if prefs?.exists}<span class="preferences-path" title={prefs.path}>{prefs.path}</span
              >{/if}
          </footer>
        </div>
      </div>
    {/if}
  </div>
</div>

<ConfirmDialog
  open={showResetConfirmation}
  title="Restore project agent defaults?"
  message="This replaces the current project's agent permissions, computer-use grants, workflow, quality, context, research, and routing settings with Koryphaios defaults. Preferences and skill files are not changed."
  confirmLabel="Restore defaults"
  variant="warning"
  onCancel={() => (showResetConfirmation = false)}
  onConfirm={() => {
    showResetConfirmation = false;
    void agentSettingsStore.resetSettings();
  }}
/>

<style>
  .agent-settings-shell,
  .preferences-settings-scroll {
    background: var(--color-surface-1);
  }

  .agent-settings-content {
    scrollbar-gutter: stable;
  }

  .agent-settings-page,
  .preferences-settings-page {
    width: min(100%, 980px);
    padding: 22px 0 52px;
    color: var(--color-text-primary);
  }

  .agent-page-header,
  .preferences-page-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 24px;
    margin: 0 0 26px;
    padding: 8px 0 4px;
  }

  .agent-page-actions {
    display: flex;
    flex-shrink: 0;
    align-items: flex-end;
    gap: 12px;
  }

  .agent-page-header h2,
  .preferences-page-header h2 {
    margin: 0;
    font-size: 26px;
    font-weight: 600;
    letter-spacing: -0.04em;
    line-height: 1.15;
  }

  .agent-page-header p,
  .preferences-page-header p {
    max-width: 68ch;
    margin: 9px 0 0;
    color: var(--color-text-secondary);
    font-size: 13px;
    line-height: 1.65;
  }

  .agent-page-summary {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 8px;
    max-width: 360px;
    padding-top: 2px;
  }

  .agent-page-summary span {
    padding: 5px 9px;
    border-radius: 6px;
    background: var(--color-surface-2);
    color: var(--color-text-secondary);
    font-size: 11px;
    white-space: nowrap;
  }

  .agent-reset-action {
    display: inline-flex;
    min-height: 32px;
    align-items: center;
    gap: 6px;
    border-radius: 7px;
    padding: 0 9px;
    color: var(--color-text-muted);
    font-size: 11px;
    white-space: nowrap;
  }

  .agent-reset-action:focus-visible,
  .agent-section-index button:focus-visible {
    outline: 2px solid color-mix(in srgb, var(--color-accent) 70%, transparent);
    outline-offset: 1px;
  }

  .agent-reset-action:hover {
    background: var(--color-error-bg);
    color: var(--color-error);
  }

  .agent-section-index {
    position: sticky;
    z-index: 2;
    top: 0;
    display: flex;
    align-items: center;
    gap: 4px;
    min-height: 42px;
    margin: 0 0 4px;
    padding: 4px;
    overflow-x: auto;
    border: 1px solid color-mix(in srgb, var(--color-text-muted) 15%, transparent);
    border-radius: 9px;
    background: color-mix(in srgb, var(--color-surface-1) 94%, transparent);
    box-shadow: 0 5px 14px color-mix(in srgb, var(--color-surface-0) 18%, transparent);
    backdrop-filter: blur(10px);
  }

  .agent-section-index button {
    flex: 0 0 auto;
    min-height: 30px;
    border-radius: 6px;
    padding: 0 9px;
    color: var(--color-text-muted);
    font-size: 11px;
    font-weight: 550;
    white-space: nowrap;
  }

  .agent-section-index button:hover,
  .agent-section-index button[aria-current='location'] {
    background: var(--color-surface-3);
    color: var(--color-text-primary);
  }

  .agent-section-index button[aria-current='location'] {
    color: var(--color-accent);
  }

  .routing-explainer {
    margin-bottom: 22px;
    padding: 14px 16px;
    border-radius: 8px;
    background: var(--color-surface-2);
    color: var(--color-text-secondary);
    font-size: 12px;
    line-height: 1.55;
  }

  .routing-explainer-title {
    color: var(--color-text-primary);
    font-weight: 600;
  }

  .routing-explainer ol {
    display: grid;
    gap: 4px;
    margin: 8px 0 0;
    padding-left: 18px;
    list-style: decimal;
  }

  .routing-explainer p {
    max-width: 78ch;
    margin: 8px 0 0;
    color: var(--color-text-muted);
  }

  /* Settings are grouped by rhythm and dividers. Cards are reserved for
     actual controls such as presets and editors, never for every row. */
  .agent-settings-content :global(.rounded-2xl.border) {
    overflow: visible;
    border: 0 !important;
    border-top: 1px solid color-mix(in srgb, var(--color-text-muted) 15%, transparent) !important;
    border-radius: 0 !important;
    background: transparent !important;
    box-shadow: none !important;
  }

  :global(.agent-settings-page > .rounded-2xl.border:first-of-type) {
    border-top: 0 !important;
  }

  .agent-settings-content :global(.rounded-2xl.border > button) {
    min-height: 58px;
    padding-inline: 0;
    background: transparent;
  }

  .agent-settings-content :global(.rounded-2xl.border > button:hover) {
    background: transparent;
  }

  .agent-settings-content :global(.rounded-2xl.border > div.border-t) {
    border-top-color: transparent !important;
  }

  .agent-settings-content :global(.rounded-2xl.border section) {
    padding-inline: 0;
  }

  .agent-settings-content :global(.rounded-xl.border),
  .agent-settings-content :global(.rounded-lg.border) {
    border-color: transparent !important;
    border-radius: 8px !important;
    background: var(--color-surface-2) !important;
    box-shadow: none !important;
  }

  .agent-settings-content :global(.agent-subpanel) {
    border-color: transparent !important;
    border-radius: 8px !important;
    background: var(--color-surface-2) !important;
    box-shadow: none !important;
  }

  .agent-settings-content :global(.divide-y > *) {
    border-color: transparent !important;
  }

  .agent-settings-content :global(button[role='switch']:not(.flat)) {
    border-color: transparent !important;
    border-radius: 0 !important;
    background: transparent !important;
    padding-inline: 0 !important;
  }

  .agent-settings-content :global(.computer-settings) {
    overflow: visible !important;
    border: 0 !important;
    border-radius: 0 !important;
    background: transparent !important;
    box-shadow: none !important;
  }

  .quality-content {
    border-top: 1px solid color-mix(in srgb, var(--color-text-muted) 15%, transparent);
  }

  .quality-primary {
    padding: 22px 0 18px;
  }

  .quality-copy {
    max-width: 760px;
  }

  .quality-title-row {
    display: flex;
    align-items: flex-start;
    gap: 10px;
  }

  .quality-title-row h4 {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
  }

  .quality-title-row p {
    max-width: 68ch;
    margin: 5px 0 0;
    color: var(--color-text-muted);
    font-size: 12px;
    line-height: 1.6;
  }

  .quality-primary :global(button[role='switch']) {
    margin-top: 14px;
    padding: 10px 0;
  }

  .quality-advanced-toggle {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    border-top: 1px solid color-mix(in srgb, var(--color-text-muted) 12%, transparent);
    padding: 14px 0;
  }

  .quality-advanced-toggle > div {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 3px;
  }

  .quality-advanced-toggle strong {
    color: var(--color-text-secondary);
    font-size: 12px;
    font-weight: 550;
  }

  .quality-advanced-toggle span {
    color: var(--color-text-muted);
    font-size: 11px;
  }

  .text-action {
    flex: 0 0 auto;
    border-radius: 6px;
    padding: 5px 8px;
    color: var(--color-accent);
    font-size: 11px;
    font-weight: 550;
  }

  .text-action:hover:not(:disabled) {
    background: color-mix(in srgb, var(--color-accent) 10%, transparent);
  }

  .text-action:disabled {
    cursor: not-allowed;
    opacity: 0.4;
  }

  .quality-advanced {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 18px;
    border-top: 1px solid color-mix(in srgb, var(--color-text-muted) 12%, transparent);
    padding: 18px 0 6px;
  }

  .quality-passes {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 18px;
    min-width: 0;
  }

  .quality-passes p {
    max-width: 34ch;
    margin: 5px 0 0;
    color: var(--color-text-muted);
    font-size: 10px;
    line-height: 1.5;
  }

  @media (max-width: 640px) {
    .quality-advanced {
      grid-template-columns: minmax(0, 1fr);
    }
  }

  .preferences-file-meta {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-top: 14px;
    color: var(--color-success);
    font-size: 11px;
  }

  .preferences-file-meta.warning {
    color: var(--color-warning);
  }

  .preferences-page-actions {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    gap: 10px;
    padding-top: 2px;
  }

  .preferences-primary-action,
  .preferences-text-action {
    display: inline-flex;
    min-height: 34px;
    align-items: center;
    gap: 7px;
    border-radius: 7px;
    padding: 0 11px;
    font-size: 12px;
    font-weight: 500;
    transition:
      opacity 150ms ease,
      background-color 150ms ease,
      color 150ms ease;
  }

  .preferences-primary-action {
    background: var(--color-accent);
    color: var(--color-surface-0);
  }

  .preferences-primary-action:hover:not(:disabled) {
    opacity: 0.88;
  }

  .preferences-text-action {
    color: var(--color-text-muted);
  }

  .preferences-text-action:hover:not(:disabled) {
    background: var(--color-surface-2);
    color: var(--color-text-primary);
  }

  .preferences-primary-action:disabled,
  .preferences-text-action:disabled {
    cursor: not-allowed;
    opacity: 0.42;
  }

  .preferences-editor-section {
    border-top: 1px solid color-mix(in srgb, var(--color-text-muted) 15%, transparent);
    padding-top: 22px;
  }

  .preferences-section-heading {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 13px;
  }

  .preferences-section-heading h3 {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
  }

  .preferences-section-heading p {
    margin: 5px 0 0;
    color: var(--color-text-muted);
    font-size: 12px;
    line-height: 1.6;
  }

  .preferences-unsaved {
    color: var(--color-warning);
    font-size: 11px;
    white-space: nowrap;
  }

  .preferences-editor {
    display: block;
    width: 100%;
    min-height: min(62vh, 680px);
    resize: vertical;
    border: 0;
    border-radius: 8px;
    padding: 18px 20px;
    background: var(--color-surface-0);
    color: var(--color-text-primary);
    font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
    font-size: 12px;
    line-height: 1.75;
    outline: 1px solid color-mix(in srgb, var(--color-text-muted) 14%, transparent);
  }

  .preferences-editor:focus {
    outline: 2px solid color-mix(in srgb, var(--color-accent) 70%, transparent);
    outline-offset: 1px;
  }

  .preferences-empty-state {
    display: flex;
    min-height: 360px;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 9px;
    border-radius: 8px;
    background: var(--color-surface-0);
    color: var(--color-text-muted);
    outline: 1px solid color-mix(in srgb, var(--color-text-muted) 12%, transparent);
    text-align: center;
  }

  :global(.preferences-empty-state svg) {
    margin-bottom: 5px;
    color: var(--color-text-muted);
  }

  .preferences-empty-state strong {
    color: var(--color-text-primary);
    font-size: 13px;
  }

  .preferences-empty-state span {
    font-size: 12px;
  }

  .preferences-page-footer {
    display: flex;
    justify-content: space-between;
    gap: 16px;
    margin-top: 14px;
    color: var(--color-text-muted);
    font-size: 11px;
  }

  .preferences-path {
    max-width: 48%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  @media (max-width: 720px) {
    .agent-page-header,
    .preferences-page-header {
      flex-direction: column;
      gap: 14px;
    }

    .agent-page-summary {
      justify-content: flex-start;
      max-width: none;
    }

    .agent-page-actions {
      width: 100%;
      flex-wrap: wrap;
      align-items: flex-start;
    }

    .agent-reset-action {
      margin-left: auto;
    }

    .preferences-page-actions {
      width: 100%;
    }

    .preferences-page-actions > *:last-child {
      margin-left: auto;
    }

    .preferences-page-footer {
      flex-direction: column;
      gap: 5px;
    }

    .preferences-path {
      max-width: 100%;
    }
  }
</style>
