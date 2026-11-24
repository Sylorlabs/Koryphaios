<script lang="ts">
  import { onMount, tick } from 'svelte';
  import {
    agentSettingsStore,
    DEFAULT_AGENT_SETTINGS,
    DEFAULT_SANDBOX_SETTINGS,
  } from '$lib/stores/agent-settings.svelte';
  import SettingsSwitch from './SettingsSwitch.svelte';
  import SettingsScopeBar from './settings/SettingsScopeBar.svelte';
  import SettingsPage from './settings/SettingsPage.svelte';
  import ComputerUseSettings from './ComputerUseSettings.svelte';
  import SettingRow from './agent-settings/SettingRow.svelte';
  import SettingGroup from './agent-settings/SettingGroup.svelte';
  import SegmentedChoice from './agent-settings/SegmentedChoice.svelte';
  import PatternListEditor from './agent-settings/PatternListEditor.svelte';
  import {
    defaultComputerUseSettings,
    MESSAGING_TIERS,
    type MessagingPermissionLevel,
    type MessagingTierKey,
  } from '@koryphaios/shared';
  import {
    messagingCellState,
    messagingTierOverridden,
    withMessagingCell,
    withoutMessagingTier,
  } from '../utils/messaging-permissions';
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
  type AdvancedGroup = 'safety' | 'agents' | 'workflow' | 'quality' | 'context' | 'research';
  const GROUP_STORAGE_KEY = 'kory.agentSettings.expandedGroups';
  const COLLAPSED_GROUPS: Record<AdvancedGroup, boolean> = {
    safety: false,
    agents: false,
    workflow: false,
    quality: false,
    context: false,
    research: false,
  };
  function loadExpandedGroups(): Record<AdvancedGroup, boolean> {
    try {
      const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(GROUP_STORAGE_KEY);
      const parsed = raw ? (JSON.parse(raw) as Partial<Record<AdvancedGroup, unknown>>) : {};
      const next = { ...COLLAPSED_GROUPS };
      for (const key of Object.keys(next) as AdvancedGroup[]) next[key] = parsed[key] === true;
      return next;
    } catch {
      return { ...COLLAPSED_GROUPS };
    }
  }
  let expandedGroups = $state<Record<AdvancedGroup, boolean>>(loadExpandedGroups());
  function persistExpandedGroups() {
    try {
      localStorage.setItem(GROUP_STORAGE_KEY, JSON.stringify(expandedGroups));
    } catch {
      // Storage can be unavailable (private mode); the layout still works.
    }
  }
  function toggleGroup(id: AdvancedGroup) {
    expandedGroups = { ...expandedGroups, [id]: !expandedGroups[id] };
    persistExpandedGroups();
  }

  /** Earlier builds addressed this page by section; keep those ids working. */
  const LEGACY_SECTION_GROUPS: Record<string, AdvancedGroup | 'essentials'> = {
    permissions: 'essentials',
    workflow: 'workflow',
    context: 'context',
    quality: 'quality',
    routing: 'agents',
    research: 'research',
  };

  async function openGroup(id: AdvancedGroup | 'essentials' | string, anchorId?: string) {
    const group = (LEGACY_SECTION_GROUPS[id] ?? id) as AdvancedGroup | 'essentials';
    if (group !== 'essentials' && group in expandedGroups && !expandedGroups[group]) {
      expandedGroups = { ...expandedGroups, [group]: true };
      persistExpandedGroups();
    }
    await tick();
    const target = document.getElementById(anchorId ?? `agent-group-${group}`);
    target?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    target?.querySelector<HTMLElement>('button, [tabindex]')?.focus({ preventScroll: true });
  }

  const AGENT_TABS: readonly { id: AgentTab; label: string; icon: typeof Bot }[] = [
    { id: 'settings', label: 'Behavior', icon: Bot },
    { id: 'preferences', label: 'Preferences', icon: FileText },
  ];

  const ADVANCED_GROUPS: readonly {
    id: AdvancedGroup;
    title: string;
    description: string;
    icon: typeof Bot;
  }[] = [
    {
      id: 'safety',
      title: 'Permissions & safety',
      description: 'Change limits, sandbox checks, shell command lists, per-tool access and computer use.',
      icon: LockKeyhole,
    },
    {
      id: 'agents',
      title: 'Agents & coordination',
      description: 'Messaging between chats, which models each kind of sub-agent may use, and notes for the manager.',
      icon: Users,
    },
    {
      id: 'workflow',
      title: 'Workflow & planning',
      description: 'Clarifying questions, single or multi-agent execution, goal planning and skill learning.',
      icon: GitBranch,
    },
    {
      id: 'quality',
      title: 'Quality & Critic',
      description: 'What happens when the Critic finds a problem and how many repair rounds it gets.',
      icon: Gavel,
    },
    {
      id: 'context',
      title: 'Context & memory',
      description: 'Prompt cache, tool output, compaction, skills in context, file access and memory.',
      icon: Brain,
    },
    {
      id: 'research',
      title: 'Research',
      description: 'Web search behaviour and multi-source research.',
      icon: Search,
    },
  ];

  const APPROVAL_PRESET_OPTIONS = [
    { value: 'guarded', label: 'Guarded', description: 'File edits run automatically; Kory asks only before risky actions.' },
    { value: 'edits', label: 'Accept edits', description: 'File edits run automatically; every other action that changes something asks first.' },
    { value: 'ask', label: 'Ask', description: 'Reads run automatically; file edits and anything that changes state ask for approval.' },
    { value: 'custom', label: 'Custom', description: 'Use your own rules, set right below.' },
    { value: 'yolo', label: 'YOLO', description: 'No Kory approval prompts. Explicit blocks, hard safety floors and native failures still apply.' },
  ];
  const SANDBOX_OPTIONS = [
    { value: 'auto', label: 'Auto', description: 'Sandbox planning, Critic and sub-agent commands; the manager runs unconfined.' },
    { value: 'always', label: 'Always', description: 'Sandbox every agent shell command, including the manager’s.' },
    { value: 'off', label: 'Off', description: 'No sandbox. Catastrophic-command checks and approval prompts still apply.' },
  ];
  const SUB_AGENT_APPROVAL_OPTIONS = [
    { value: 'manager', label: 'Manager decides', description: 'In Guarded the manager reviews sub-agent actions; other presets ask you as usual.' },
    { value: 'user', label: 'I decide', description: 'Sub-agents read and search freely; every edit, shell command and risky action asks you.' },
    { value: 'auto', label: 'Auto-approve', description: 'Sub-agents never prompt. Sandbox settings and hard safety floors still apply.' },
  ];
  const WORKTREE_OPTIONS = [
    { value: 'auto', label: 'Auto', description: 'The manager decides per task, and checks other chats working in the same folder before editing.' },
    { value: 'always', label: 'On', description: 'Every sub-agent works in its own git worktree, merged back when it finishes.' },
    { value: 'never', label: 'Off', description: 'Sub-agents edit the chat’s folder directly; parallel sub-agents can collide.' },
  ];

  $effect(() => {
    if (!focusPermissions || !active) return;
    void openGroup('essentials');
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

  const MESSAGING_ROLES = ['manager', 'subAgents'] as const;

  const MESSAGING_TIER_LABELS: Record<MessagingTierKey, string> = {
    yolo: 'YOLO',
    guarded: 'Guarded',
    edits: 'Accept edits',
    ask: 'Ask',
    custom: 'Custom',
  };

  function messagingCell(
    tier: MessagingTierKey,
    role: 'manager' | 'subAgents',
  ): MessagingPermissionLevel {
    return messagingCellState(agentSettingsStore.settings.messagingPermissionsByTier, tier, role);
  }

  function messagingTierHasOverride(tier: MessagingTierKey): boolean {
    return messagingTierOverridden(agentSettingsStore.settings.messagingPermissionsByTier, tier);
  }

  async function setMessagingCell(
    tier: MessagingTierKey,
    role: 'manager' | 'subAgents',
    level: MessagingPermissionLevel,
  ) {
    await agentSettingsStore.saveSettings(
      {
        messagingPermissionsByTier: withMessagingCell(
          agentSettingsStore.settings.messagingPermissionsByTier,
          tier,
          role,
          level,
        ),
      },
      { quietSuccess: true },
    );
  }

  async function resetMessagingTier(tier: MessagingTierKey) {
    await agentSettingsStore.saveSettings(
      {
        messagingPermissionsByTier: withoutMessagingTier(
          agentSettingsStore.settings.messagingPermissionsByTier,
          tier,
        ),
      },
      { quietSuccess: true },
    );
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
        { name: 'get_model_pricing', label: 'Model pricing' },
        { name: 'get_usage_summary', label: 'Usage summary' },
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
        { name: 'manage_context', label: 'Manage context' },
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

  function sectionSummary(id: 'permissions' | 'workflow' | 'context' | 'quality' | 'routing' | 'research'): string {
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

  function groupSummary(id: AdvancedGroup): string {
    const settings = agentSettingsStore.settings;
    switch (id) {
      case 'safety': {
        const allow = settings.bashCommandAllowlist?.length ?? 0;
        const block = settings.bashCommandBlocklist?.length ?? 0;
        return `Autonomy limits ${settings.autonomyLimitsEnabled ? 'on' : 'off'} · Sandbox ${settings.sandbox?.mode ?? 'auto'} · ${allow} allowed / ${block} blocked commands · Computer use ${settings.computerUse?.enabled ? 'on' : 'off'}`;
      }
      case 'agents': {
        const customized = Object.keys(settings.messagingPermissionsByTier ?? {}).length;
        return `Messaging ${customized ? `customized for ${customized} mode${customized === 1 ? '' : 's'}` : 'defaults'} · ${sectionSummary('routing')}`;
      }
      default:
        return sectionSummary(id);
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

  // Per-tool agent-context policy. The transcript keeps every tool output;
  // this only decides how much of it enters the agent's context window.
  let toolContextTarget = $state<string>('bash');
  const toolContextOptions = $derived.by(() =>
    TOOL_CATALOG.flatMap((group) =>
      group.tools.map((tool) => ({ value: tool.name, label: `${tool.label} · ${tool.name}` })),
    ),
  );
  const toolContextMode = $derived.by(
    () => agentSettingsStore.settings.toolContextPolicies?.[toolContextTarget] ?? 'full',
  );
  async function setToolContextMode(mode: 'full' | 'summary' | 'hidden') {
    const next = { ...(agentSettingsStore.settings.toolContextPolicies ?? {}) };
    if (mode === 'full') delete next[toolContextTarget];
    else next[toolContextTarget] = mode;
    await agentSettingsStore.saveSettings(
      { toolContextPolicies: next },
      { quietSuccess: true },
    );
  }

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
    'get_model_pricing',
    'get_usage_summary',
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

  let openToolCategories = $state(new Set<string>());
  function toggleToolCategory(category: string) {
    const next = new Set(openToolCategories);
    if (next.has(category)) next.delete(category);
    else next.add(category);
    openToolCategories = next;
  }
  function toolCategoryCounts(tools: readonly { name: string }[], tier: string) {
    const counts = { allow: 0, ask: 0, block: 0 };
    for (const tool of tools) {
      const state = getToolAccessStateForTier(tool.name, tier);
      if (state === 'allow') counts.allow += 1;
      else if (state === 'block') counts.block += 1;
      else counts.ask += 1;
    }
    return counts;
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

{#snippet projectScope()}
  <SettingsScopeBar compact contextLabel="Scope:" projectLabel="Project" projectSelector="current" />
{/snippet}

<div class="agent-settings-shell flex h-full min-h-0 min-w-0 flex-col">
  <!-- The tab strip spans the pane but its tabs sit on the page column's left
       edge, so tabs, title and content all share one edge. -->
  <nav
    class="agent-gutter shrink-0 border-b border-[var(--color-border)] bg-[var(--color-surface-1)]"
    aria-label="Agent behavior sections"
  >
    <div class="agent-column flex h-11 items-end gap-6">
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
          <p class="mt-2 text-[11px] leading-relaxed text-[var(--color-text-muted)]">
            Koryphaios has not substituted defaults for the current project.
          </p>
          <button
            type="button"
            class="mt-4 rounded-xl bg-[var(--color-accent)] px-4 py-2 text-xs font-semibold text-[var(--color-on-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/70"
            onclick={() => void agentSettingsStore.loadAll()}>Retry</button
          >
        </div>
      </div>
    {:else if agentSettingsStore.activeTab === 'settings'}
      <div class="flex h-full min-h-0 flex-col overflow-hidden">
        {#if agentSettingsStore.settingsError}
          <div class="agent-gutter shrink-0">
          <div class="agent-column mt-3">
          <div
            class="flex items-start justify-between gap-3 rounded-xl border border-[var(--color-error)]/35 bg-[var(--color-error)]/10 px-4 py-3"
            role="alert"
          >
            <div>
              <div class="text-xs font-semibold text-[var(--color-error)]">
                Setting was not saved
              </div>
              <div class="mt-1 text-[11px] text-[var(--color-text-secondary)]">
                {agentSettingsStore.settingsError} The last server-confirmed value was restored.
              </div>
            </div>
            <button
              type="button"
              class="shrink-0 rounded-lg border border-[var(--color-border)] px-2.5 py-1.5 text-[11px] text-[var(--color-text-secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/60"
              onclick={() => void agentSettingsStore.loadSettings()}>Reload</button
            >
          </div>
          </div>
          </div>
        {/if}
        <div class="agent-settings-content h-full min-h-0 overflow-y-auto">
          <SettingsPage
            title="Agent behavior"
            description="Set the workspace defaults for how Kory plans, acts, verifies, and remembers."
            width="wide"
          >
            {#snippet meta()}
                <div class="agent-page-summary" aria-label="Current agent posture">
                  <button type="button" title="Approval preset" onclick={() => void openGroup('essentials')}
                    >{permissionTierOptions.find((option) => option.value === permissionModeValue)?.label ??
                      permissionModeValue}</button
                  >
                  <button type="button" title="Critic quality gate" onclick={() => void openGroup('quality')}
                    >Critic {resolveCriticMode(agentSettingsStore.settings)}</button
                  >
                  <button type="button" title="Execution sandbox" onclick={() => void openGroup('safety')}
                    >Sandbox: {agentSettingsStore.settings.sandbox?.mode ?? 'auto'}</button
                  >
                  <button
                    type="button"
                    title="Computer use"
                    onclick={() => void openGroup('safety', 'agent-computer-use')}
                    >Computer: {agentSettingsStore.settings.computerUse?.enabled ? 'On' : 'Off'}</button
                  >
                </div>
                {@render projectScope()}
            {/snippet}
            {#snippet actions()}
                <button
                  type="button"
                  class="agent-reset-action"
                  onclick={() => (showResetConfirmation = true)}
                >
                  <RotateCcw size={14} /> Reset agent settings
                </button>
            {/snippet}
            <section class="agent-essentials" id="agent-group-essentials" aria-labelledby="agent-essentials-title">
              <div class="agent-block-heading">
                <h3 id="agent-essentials-title">Essentials</h3>
                <p>The defaults every new chat starts from. Approval, Critic and Worktree can still be changed per chat from the composer.</p>
              </div>
              <div class="agent-card">
                <SettingRow
                  label="Approval preset"
                  description="How often Kory pauses to ask you before acting."
                >
                  <SegmentedChoice
                    label="Approval preset"
                    value={agentSettingsStore.settings.permissionMode ?? 'guarded'}
                    options={APPROVAL_PRESET_OPTIONS}
                    onchange={(value) => handlePermissionTierChange(value)}
                  />
                  {#snippet below()}
{#if agentSettingsStore.settings.permissionMode === 'custom'}
                        <div class="space-y-3 rounded-xl bg-[var(--color-surface-2)] p-3">
                          <div>
                            <h5 class="text-xs font-semibold text-[var(--color-text-primary)]">
                              Custom approval rules
                            </h5>
                            <p class="mt-1 text-[11px] text-[var(--color-text-muted)]">
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
                  {/snippet}
                </SettingRow>
                <SettingRow
                  label="Execution sandbox"
                  description="How strictly agent shell commands are confined. Fine-grained checks are under Permissions & safety."
                >
                  <SegmentedChoice
                    label="Execution sandbox mode"
                    value={agentSettingsStore.settings.sandbox?.mode ?? 'auto'}
                    options={SANDBOX_OPTIONS}
                    onchange={(value) => setSandboxMode(value as 'auto' | 'always' | 'off')}
                  />
                </SettingRow>
                <SettingRow
                  label="Sub-agent approval"
                  description="Who approves the tools that sub-agents (specialist workers the manager starts) run."
                >
                  <SegmentedChoice
                    label="Sub-agent approval"
                    value={agentSettingsStore.settings.subAgentApproval ?? 'manager'}
                    options={SUB_AGENT_APPROVAL_OPTIONS}
                    onchange={(value) => setSubAgentApproval(value as 'manager' | 'user' | 'auto')}
                  />
                  {#snippet below()}
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
                  {/snippet}
                </SettingRow>
                <SettingRow
                  label="Worktree for new chats"
                  description="Whether sub-agents work in isolated git worktrees. Each chat can override this from the composer's Worktree pill."
                >
                  <SegmentedChoice
                    label="Worktree for new chats"
                    value={agentSettingsStore.settings.worktreeMode ?? 'auto'}
                    options={WORKTREE_OPTIONS}
                    onchange={(value) =>
                      agentSettingsStore.saveSettings(
                        { worktreeMode: value as 'auto' | 'always' | 'never' },
                        { quietSuccess: true },
                      )}
                  />
                </SettingRow>
                <SettingRow
                  label="Critic quality gate"
                  description="A second agent checks that work is really done before Kory delivers it. Review details are under Quality & Critic."
                >
                  <div class="w-48">
                    <CriticModeSelect
                      compact
                      value={resolveCriticMode(agentSettingsStore.settings)}
                      onchange={(criticMode) =>
                        agentSettingsStore.saveSettings(
                          { criticMode, criticGateEnabled: criticMode !== 'off' },
                          { quietSuccess: true },
                        )}
                    />
                  </div>
                </SettingRow>
                <SettingRow
                  label="Computer use"
                  description="Let agents see and control apps on this computer, within the per-app rules you set."
                >
                  <div class="flex items-center gap-3">
                    <span class="agent-status-pill" data-on={agentSettingsStore.settings.computerUse?.enabled ? 'true' : 'false'}
                      >{agentSettingsStore.settings.computerUse?.enabled ? 'On' : 'Off'}</span
                    >
                    <button
                      type="button"
                      class="agent-text-button"
                      onclick={() => void openGroup('safety', 'agent-computer-use')}>Configure</button
                    >
                  </div>
                </SettingRow>
              </div>
            </section>

            <section class="agent-advanced" aria-labelledby="agent-advanced-title">
              <div class="agent-block-heading">
                <h3 id="agent-advanced-title">Advanced</h3>
                <p>Every other control, grouped by what it affects. Collapsed groups show their current state.</p>
              </div>
              <div class="space-y-2">
                {#each ADVANCED_GROUPS as group (group.id)}
                  <SettingGroup
                    id={group.id}
                    title={group.title}
                    description={group.description}
                    summary={groupSummary(group.id)}
                    icon={group.icon}
                    expanded={expandedGroups[group.id]}
                    ontoggle={() => toggleGroup(group.id)}
                  >
                    {#if group.id === 'safety'}
                    <div class="agent-subgroup">
                      <div class="agent-subheading">Change limits</div>
                      <SettingRow
                        label="Autonomy limits"
                        description={agentSettingsStore.settings.autonomyLimitsEnabled
                          ? agentSettingsStore.settings.permissionMode === 'guarded'
                            ? 'On: risky non-edit actions past these limits ask first. Guarded still applies file edits automatically.'
                            : `On: Kory asks before an edit that touches more than ${agentSettingsStore.settings.approvalThresholdFiles} files or ${agentSettingsStore.settings.approvalThresholdLines} lines.`
                          : 'Off: the limits below are saved but not enforced. Turn this on to make Kory ask before large changes.'}
                      >
                        <SettingsToggle
                          label="Autonomy limits"
                          checked={agentSettingsStore.settings.autonomyLimitsEnabled}
                          onchange={() => toggleSetting('autonomyLimitsEnabled')}
                        />
                      </SettingRow>
                      <SettingRow label="Most files per change" description="Edits touching more files than this ask first.">
                        <div class="w-40">
                          <NumberStepper
                            compact
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
                        </div>
                      </SettingRow>
                      <SettingRow label="Most lines per change" description="Edits changing more lines than this ask first.">
                        <div class="w-40">
                          <NumberStepper
                            compact
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
                        </div>
                      </SettingRow>
                    </div>
                    <div class="agent-subgroup">
                      <div class="agent-subheading">Sandbox checks</div>
                      <p class="agent-subnote">
                        {(agentSettingsStore.settings.sandbox?.mode ?? 'auto') === 'off'
                          ? 'The execution sandbox is Off (see Essentials), so these checks are saved but not applied.'
                          : 'What the sandbox enforces while it is active. Turn one off to relax just that rule.'}
                      </p>
                      <SettingRow label="Only known development commands" description="Allow only common development tools (git, npm, bun, cargo and similar).">
                        <SettingsToggle
                          label="Only known development commands"
                          disabled={(agentSettingsStore.settings.sandbox?.mode ?? 'auto') === 'off'}
                          checked={agentSettingsStore.settings.sandbox?.commandWhitelist ?? true}
                          onchange={() => toggleSandboxFlag('commandWhitelist')}
                        />
                      </SettingRow>
                      <SettingRow label="Block shell chaining" description="Block pipes, command substitution and chaining. Turn off to allow commands like git add && git commit.">
                        <SettingsToggle
                          label="Block shell chaining"
                          disabled={(agentSettingsStore.settings.sandbox?.mode ?? 'auto') === 'off'}
                          checked={agentSettingsStore.settings.sandbox?.metacharacters ?? true}
                          onchange={() => toggleSandboxFlag('metacharacters')}
                        />
                      </SettingRow>
                      <SettingRow label="Stay inside the project" description="Block commands whose working directory is outside the project folder.">
                        <SettingsToggle
                          label="Stay inside the project"
                          disabled={(agentSettingsStore.settings.sandbox?.mode ?? 'auto') === 'off'}
                          checked={agentSettingsStore.settings.sandbox?.pathConfinement ?? true}
                          onchange={() => toggleSandboxFlag('pathConfinement')}
                        />
                      </SettingRow>
                      <SettingRow label="Block network tools" description="Block curl, wget and other network commands.">
                        <SettingsToggle
                          label="Block network tools"
                          disabled={(agentSettingsStore.settings.sandbox?.mode ?? 'auto') === 'off'}
                          checked={agentSettingsStore.settings.sandbox?.network ?? true}
                          onchange={() => toggleSandboxFlag('network')}
                        />
                      </SettingRow>
                      <SettingRow label="Block container tools" description="Block docker, podman and similar tools.">
                        <SettingsToggle
                          label="Block container tools"
                          disabled={(agentSettingsStore.settings.sandbox?.mode ?? 'auto') === 'off'}
                          checked={agentSettingsStore.settings.sandbox?.containerTools ?? true}
                          onchange={() => toggleSandboxFlag('containerTools')}
                        />
                      </SettingRow>
                    </div>
                      <section class="space-y-4 p-5">
                        <div class="space-y-1">
                          <h4 class="text-sm font-semibold text-[var(--color-text-primary)]">Shell command lists</h4>
                          <p class="text-xs text-[var(--color-text-muted)]">
                            Glob patterns matched against a command's base name (for example <code>git*</code>). Allowed commands skip the shell safety prompt; blocked commands are refused without asking. The safety prompt's "add to list" choices land here too.
                          </p>
                        </div>
                        <div class="grid gap-4 md:grid-cols-2">
                          <div class="space-y-2">
                            <div class="text-xs font-semibold text-[var(--color-text-secondary)]">Always allow</div>
                            <PatternListEditor
                              label="Always-allowed shell commands"
                              tone="allow"
                              patterns={agentSettingsStore.settings.bashCommandAllowlist ?? []}
                              emptyText="No always-allowed commands."
                              onchange={(patterns) =>
                                agentSettingsStore.saveSettings(
                                  { bashCommandAllowlist: patterns },
                                  { quietSuccess: true },
                                )}
                            />
                          </div>
                          <div class="space-y-2">
                            <div class="text-xs font-semibold text-[var(--color-text-secondary)]">Always block</div>
                            <PatternListEditor
                              label="Always-blocked shell commands"
                              tone="block"
                              placeholder="e.g. rm*"
                              patterns={agentSettingsStore.settings.bashCommandBlocklist ?? []}
                              emptyText="No always-blocked commands."
                              onchange={(patterns) =>
                                agentSettingsStore.saveSettings(
                                  { bashCommandBlocklist: patterns },
                                  { quietSuccess: true },
                                )}
                            />
                          </div>
                        </div>
                      </section>
                    <section
                      class="space-y-4 p-5"
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
                        {#each TOOL_CATALOG as group (group.category)}
                          {@const counts = toolCategoryCounts(group.tools, toolAccessTier)}
                          {@const open = openToolCategories.has(group.category)}
                          <div
                            class="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)]"
                          >
                            <button
                              type="button"
                              class="flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2 text-left hover:bg-[var(--color-surface-3)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-accent)]/60"
                              aria-expanded={open}
                              onclick={() => toggleToolCategory(group.category)}
                            >
                              <span
                                class="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]"
                                >{group.category}</span
                              >
                              <span class="flex items-center gap-2 text-[11px] text-[var(--color-text-muted)]">
                                <span
                                  >{group.tools.length} tools · {counts.allow} allow · {counts.ask} ask{counts.block
                                    ? ` · ${counts.block} blocked`
                                    : ''}</span
                                >
                                <ChevronRight size={13} class="transition-transform {open ? 'rotate-90' : ''}" />
                              </span>
                            </button>
                            {#if open}
                            <div class="grid gap-1.5 px-3 pb-3 sm:grid-cols-2">
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
                            {/if}
                          </div>
                        {/each}
                      </div>

                      {#if ((agentSettingsStore.settings as any).toolPermissionsByTier?.[toolAccessTier]?.allow.length ?? 0) > 0 || ((agentSettingsStore.settings as any).toolPermissionsByTier?.[toolAccessTier]?.block.length ?? 0) > 0 || ((agentSettingsStore.settings as any).toolPermissionsByTier?.[toolAccessTier]?.ask?.length ?? 0) > 0}
                        <div
                          class="flex items-center justify-between border-t border-[var(--color-border)] pt-3"
                        >
                          <span class="text-[11px] text-[var(--color-text-muted)]">
                            {(agentSettingsStore.settings as any).toolPermissionsByTier?.[
                              toolAccessTier
                            ]?.allow.length ?? 0} allowed · {(agentSettingsStore.settings as any)
                              .toolPermissionsByTier?.[toolAccessTier]?.ask?.length ?? 0} ask · {(
                              agentSettingsStore.settings as any
                            ).toolPermissionsByTier?.[toolAccessTier]?.block.length ?? 0} blocked in {toolAccessTier}
                          </span>
                          <button
                            type="button"
                            class="text-[11px] text-[var(--color-text-muted)] underline hover:text-[var(--color-text-secondary)]"
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
                      <div id="agent-computer-use" class="p-5">
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
                      </div>
                    {:else if group.id === 'agents'}
                    <section class="space-y-5 border-t border-[var(--color-border)] p-5">
                      <div class="space-y-1">
                        <h4
                          class="flex items-center gap-2 text-sm font-semibold text-[var(--color-text-primary)]"
                        >
                          <Shield size={16} class="text-[var(--color-accent)]" />
                          Inter-agent messaging
                        </h4>
                        <p class="text-xs text-[var(--color-text-muted)]">
                          Who may message other chats, per permission mode. Every agent can always
                          read other chats and message agents in its own chat. Ask holds the
                          message for your approval in the messages panel.
                        </p>
                      </div>

                      <div class="space-y-2">
                        <div
                          class="grid grid-cols-[1fr_auto_auto_auto] items-center gap-x-3 gap-y-2"
                        >
                          <span></span>
                          <span
                            class="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]"
                            >Managers</span
                          >
                          <span
                            class="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]"
                            >Sub-agents</span
                          >
                          <span></span>
                          {#each MESSAGING_TIERS as tier (tier)}
                            <span class="text-xs text-[var(--color-text-primary)]"
                              >{MESSAGING_TIER_LABELS[tier]}</span
                            >
                            {#each MESSAGING_ROLES as msgRole (msgRole)}
                              {@const state = messagingCell(tier, msgRole)}
                              {@const overridden =
                                agentSettingsStore.settings.messagingPermissionsByTier?.[tier]?.[
                                  msgRole
                                ] !== undefined}
                              <div
                                class="flex shrink-0 gap-0.5 rounded-lg bg-[var(--color-surface-3)] p-0.5 {overridden
                                  ? 'ring-1 ring-[var(--color-accent)]/50'
                                  : ''}"
                              >
                                {#each ['allow', 'ask', 'block'] as opt (opt)}
                                  {@const isActive = state === opt}
                                  <button
                                    type="button"
                                    onclick={() =>
                                      setMessagingCell(
                                        tier,
                                        msgRole,
                                        opt as MessagingPermissionLevel,
                                      )}
                                    class="rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors duration-150 {isActive
                                      ? opt === 'allow'
                                        ? 'bg-[var(--color-success-bg)] text-[var(--color-success)]'
                                        : opt === 'block'
                                          ? 'bg-[var(--color-error-bg)] text-[var(--color-error)]'
                                          : 'bg-[var(--color-surface-1)] text-[var(--color-text-primary)]'
                                      : 'text-[var(--color-text-muted)] hover:bg-[var(--color-surface-1)]/60 hover:text-[var(--color-text-secondary)]'}"
                                  >
                                    {opt === 'allow' ? 'Allow' : opt === 'block' ? 'Block' : 'Ask'}
                                  </button>
                                {/each}
                              </div>
                            {/each}
                            <span class="w-14 text-right">
                              {#if messagingTierHasOverride(tier)}
                                <button
                                  type="button"
                                  onclick={() => resetMessagingTier(tier)}
                                  class="text-[11px] font-medium text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
                                  >Reset</button
                                >
                              {/if}
                            </span>
                          {/each}
                        </div>
                        <p class="text-[11px] text-[var(--color-text-muted)]">
                          Outlined cells override the preset default; Reset restores both columns
                          for that mode.
                        </p>
                      </div>
                    </section>
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
                                <span class="text-[11px] text-[var(--color-text-muted)] italic"
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
                                          class="mt-0.5 block truncate text-[11px] text-[var(--color-text-muted)]"
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
                                      class="rounded-full px-2 py-0.5 text-[11px] font-medium"
                                      style="background: var(--color-accent); color: var(--color-on-accent);"
                                      >unsaved</span
                                    >
                                  {/if}
                                  {#if hasGroupNotes(cat.id)}
                                    <span
                                      class="rounded-full px-2 py-0.5 text-[11px]"
                                      style="background: var(--color-success); color: var(--color-on-success);"
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
                    {:else if group.id === 'workflow'}
                    <div class="agent-subgroup">
                      <SettingRow
                        label="Clarifying questions"
                        description="How much Kory asks before it starts working on a request."
                      >
                        <SegmentedChoice
                          label="Clarifying questions"
                          value={agentSettingsStore.settings.intentInterview ?? 'adaptive'}
                          options={[
                            { value: 'off', label: 'Off', description: 'Start right away, no follow-up questions.' },
                            { value: 'adaptive', label: 'Adaptive', description: 'Ask a few targeted questions when the task is vague or complex.' },
                            { value: 'deep', label: 'Deep', description: 'Talk the request through fully before acting.' },
                          ]}
                          onchange={(value) =>
                            agentSettingsStore.saveSettings(
                              { intentInterview: value as 'off' | 'adaptive' | 'deep' },
                              { quietSuccess: true },
                            )}
                        />
                      </SettingRow>
                      <SettingRow
                        label="Single or multi-agent"
                        description="Whether Kory works alone or splits work across sub-agents. Each chat can override this from the composer's Agent Mode pill."
                      >
                        <SegmentedChoice
                          label="Execution strategy"
                          value={agentSettingsStore.settings.agentExecutionMode ?? 'auto'}
                          options={[
                            { value: 'auto', label: 'Auto', description: 'Kory decides per task whether sub-agents help.' },
                            { value: 'single', label: 'Single agent', description: 'One agent does the whole task; no sub-agents.' },
                            { value: 'multi', label: 'Multi-agent', description: 'Use parallel sub-agents whenever the task allows it.' },
                          ]}
                          onchange={(value) =>
                            agentSettingsStore.saveSettings(
                              { agentExecutionMode: value as 'auto' | 'single' | 'multi' },
                              { quietSuccess: true },
                            )}
                        />
                      </SettingRow>
                    </div>
                    <div class="agent-subgroup">
                      <div class="agent-subheading">Goals</div>
                      <SettingRow
                        label="Goal planning"
                        description="How much Kory breaks a task into a tracked checklist before acting."
                      >
                        <SegmentedChoice
                          label="Goal planning"
                          value={agentSettingsStore.settings.goalPlanningDepth ?? 'adaptive'}
                          options={[
                            { value: 'minimal', label: 'Minimal', description: 'Plan only large or complex tasks.' },
                            { value: 'adaptive', label: 'Adaptive', description: 'Plan as much as the task size and uncertainty need.' },
                            { value: 'structured', label: 'Structured', description: 'Always write a step-by-step plan before starting.' },
                          ]}
                          onchange={(value) =>
                            agentSettingsStore.saveSettings(
                              { goalPlanningDepth: value as 'minimal' | 'adaptive' | 'structured' },
                              { quietSuccess: true },
                            )}
                        />
                      </SettingRow>
                      <SettingRow
                        label="Start goals automatically"
                        description="Begin a new goal right away with the composer's model and keep going until it is done, paused, stopped or blocked. Off: goals wait until you press Start."
                      >
                        <SettingsToggle
                          label="Start goals automatically"
                          checked={agentSettingsStore.settings.automaticGoalDriving ?? true}
                          onchange={() => toggleSetting('automaticGoalDriving')}
                        />
                      </SettingRow>
                      <SettingRow
                        label="Show Goal Mode in the composer"
                        description="Keep goal quick controls and goal details in the bubble above the chat."
                      >
                        <SettingsToggle
                          label="Show Goal Mode in the composer"
                          checked={goalDisplayStore.composer}
                          onchange={() => goalDisplayStore.update({ composer: !goalDisplayStore.composer })}
                        />
                      </SettingRow>
                    </div>
                    <div class="agent-subgroup">
                      <div class="agent-subheading">Skills</div>
                      <SettingRow
                        label="Skill learning"
                        description="Whether Kory may turn what it learns in your sessions into reusable skills."
                      >
                        <SegmentedChoice
                          label="Skill learning"
                          value={agentSettingsStore.settings.skillLearningMode ?? 'propose-then-verify'}
                          options={[
                            { value: 'human-only', label: 'Only me', description: 'Never create or install a skill without your explicit approval.' },
                            { value: 'propose-then-verify', label: 'Propose', description: 'Suggest new skills and wait for your approval before installing.' },
                            { value: 'automatic', label: 'Automatic', description: 'Create skills automatically; you can undo or remove them later.' },
                          ]}
                          onchange={(value) =>
                            agentSettingsStore.saveSettings(
                              { skillLearningMode: value as 'human-only' | 'propose-then-verify' | 'automatic' },
                              { quietSuccess: true },
                            )}
                        />
                      </SettingRow>
                    </div>
                    {:else if group.id === 'quality'}
                    <div class="agent-subgroup">
                      {#if !agentSettingsStore.settings.criticGateEnabled}
                        <p class="agent-subnote pt-3">
                          The Critic is Off (see Essentials), so these settings are saved but not used.
                        </p>
                      {/if}
                      <SettingRow
                        label="When the Critic finds a problem"
                        description="What Kory does with a result the Critic could not verify."
                      >
                        <SegmentedChoice
                          label="When Critic finds an issue"
                          disabled={!agentSettingsStore.settings.criticGateEnabled}
                          value={agentSettingsStore.settings.gateStrictness ?? 'strict'}
                          options={[
                            { value: 'strict', label: 'Hold & fix', description: 'Hold delivery and repair the work until the Critic passes it.' },
                            { value: 'advisory', label: 'Deliver with notes', description: 'Deliver anyway, with the Critic’s findings attached.' },
                            { value: 'off', label: 'Mark unverified', description: 'Deliver without holding; the work is marked unverified.' },
                          ]}
                          onchange={(value) =>
                            agentSettingsStore.saveSettings(
                              { gateStrictness: value as 'strict' | 'advisory' | 'off' },
                              { quietSuccess: true },
                            )}
                        />
                      </SettingRow>
                      <SettingRow
                        label="Maximum repair rounds"
                        description="How many times Kory may try to fix work the Critic rejects. Running out never counts as a pass."
                      >
                        <div class="w-40">
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
                      </SettingRow>
                    </div>
                    {:else if group.id === 'context'}
                    <div class="agent-subgroup">
                      <div class="agent-subheading">Prompt cache</div>
                      <SettingRow
                        label="Cache keepalive"
                        description="Keeps the provider's prompt cache warm between turns so long chats stay cheap. Economic refreshes only when the expected savings beat the refresh cost; Always keeps every eligible cache warm; Off never refreshes on its own."
                      >
                        <div class="w-64">
                          <KorySelect
                            label="Cache keepalive"
                            value={agentSettingsStore.settings.promptCacheKeepaliveMode ?? 'economic'}
                            options={[
                              { value: 'economic', label: 'Economic' },
                              { value: 'always', label: 'Always' },
                              { value: 'off', label: 'Off' },
                            ]}
                            onchange={(value) =>
                              agentSettingsStore.saveSettings(
                                { promptCacheKeepaliveMode: value as 'economic' | 'always' | 'off' },
                                { quietSuccess: true },
                              )}
                          />
                        </div>
                      </SettingRow>
                      <SettingRow
                        label="Warm the cache while you type"
                        description="Before the first turn, prepare the provider's prompt cache while you are still typing. Faster first replies; may add one extra billable cache write."
                      >
                        <SettingsToggle
                          label="Warm the cache while you type"
                          checked={agentSettingsStore.settings.promptCacheColdPrewarmEnabled ?? false}
                          onchange={() => toggleSetting('promptCacheColdPrewarmEnabled')}
                        />
                      </SettingRow>
                    </div>

                    <div class="agent-subgroup">
                      <div class="agent-subheading">Tool output</div>
                      <SettingRow
                        label="Collapse old tool output"
                        description="Replace stale file reads, terminal output and search results in the agent's context with short stubs. The full output stays in the transcript and the agent can fetch it back."
                      >
                        <SettingsToggle
                          label="Collapse old tool output"
                          checked={agentSettingsStore.settings.contextPruningEnabled ?? true}
                          onchange={() => toggleSetting('contextPruningEnabled')}
                        />
                      </SettingRow>
                      <SettingRow
                        label="Recent turns kept in full"
                        description="Tool output from this many of the latest turns is never collapsed."
                      >
                        <div class="w-40">
                          <NumberStepper
                            compact
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
                        </div>
                      </SettingRow>
                      <SettingRow
                        label="Smallest output worth collapsing"
                        description="Outputs shorter than this many characters always stay in context."
                      >
                        <div class="w-40">
                          <NumberStepper
                            compact
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
                        </div>
                      </SettingRow>
                      <SettingRow
                        label="What the agent sees from each tool"
                        description="Per tool: the full result, a model-written summary, or only the tool name, time and size. The transcript always keeps the full output, and an agent can change this for its own chat."
                        stacked
                      >
                        <div class="grid gap-3 sm:grid-cols-2">
                            <KorySelect
                              label="Tool"
                              value={toolContextTarget}
                              options={toolContextOptions}
                              onchange={(value) => (toolContextTarget = value)}
                            />
                            <KorySelect
                              label="Agent sees"
                              value={toolContextMode}
                              options={[
                                {
                                  value: 'full',
                                  label: 'Full output',
                                  description:
                                    'The bounded result enters the agent context (subject to auto-collapse).',
                                },
                                {
                                  value: 'summary',
                                  label: 'Summary only',
                                  description:
                                    'A model compresses the result before the agent sees it. Full text stays in the transcript.',
                                },
                                {
                                  value: 'hidden',
                                  label: 'Name, time and size only',
                                  description:
                                    'The agent sees that the tool ran and when, never the output, unless it fetches it.',
                                },
                              ]}
                              onchange={(value) =>
                                setToolContextMode(value as 'full' | 'summary' | 'hidden')}
                            />
                          </div>
                      </SettingRow>
                    </div>

                    <div class="agent-subgroup">
                      <div class="agent-subheading">Compaction</div>
                      <SettingRow
                        label="Automatic compaction"
                        description="When a finished turn leaves the context window fuller than the trigger below, summarise older history so the chat can keep going. Nothing is deleted; it stays recoverable."
                      >
                        <SettingsToggle
                          label="Automatic compaction"
                          checked={agentSettingsStore.settings.autoCompactEnabled ?? true}
                          onchange={() => toggleSetting('autoCompactEnabled')}
                        />
                      </SettingRow>
                      <SettingRow
                        label="Compaction trigger"
                        description="How full the context window may get before compaction runs. Cached standing instructions can push this back by at most 10 points; it can also run earlier to leave room for the next reply."
                      >
                        <div class="w-40">
                          <NumberStepper
                            compact
                            value={agentSettingsStore.settings.autoCompactThreshold ?? 80}
                            min={10}
                            max={99}
                            unit="%"
                            label="Context window percentage that triggers compaction"
                            disabled={!(agentSettingsStore.settings.autoCompactEnabled ?? true)}
                            onchange={(value) =>
                              agentSettingsStore.saveSettings(
                                { autoCompactThreshold: value },
                                { quietSuccess: true },
                              )}
                          />
                        </div>
                      </SettingRow>
                    </div>

                    <div class="agent-subgroup">
                      <div class="agent-subheading">Skills in context</div>
                      <SettingRow
                        label="Limit skill context"
                        description="Cap how many characters of skill instructions are added to each turn. Off for most people; useful for cost-sensitive setups. Guidance is shortened, never blocked."
                      >
                        <div class="flex items-center gap-3">
                          <div class="w-44">
                            <NumberStepper
                              compact
                              value={agentSettingsStore.settings.skillContextBudget ?? 30000}
                              min={4000}
                              max={400000}
                              step={1000}
                              unit="chars"
                              label="Maximum injected skill characters per turn"
                              disabled={(agentSettingsStore.settings.skillContextBudget ?? null) === null}
                              onchange={(value) =>
                                agentSettingsStore.saveSettings(
                                  { skillContextBudget: value },
                                  { quietSuccess: true },
                                )}
                            />
                          </div>
                          <SettingsToggle
                            label="Limit skill context"
                            checked={(agentSettingsStore.settings.skillContextBudget ?? null) !== null}
                            onchange={() => {
                              void agentSettingsStore.saveSettings(
                                {
                                  skillContextBudget:
                                    (agentSettingsStore.settings.skillContextBudget ?? null) !== null
                                      ? null
                                      : 30000,
                                },
                                { quietSuccess: true },
                              );
                            }}
                          />
                        </div>
                      </SettingRow>
                    </div>

                    <div class="agent-subgroup">
                      <div class="agent-subheading">Visibility & files</div>
                      <SettingRow
                        label="Context awareness"
                        description="Give the agent a live report of how full its context window is, so it can tidy up or compact deliberately."
                      >
                        <SettingsToggle
                          label="Context awareness"
                          checked={agentSettingsStore.settings.contextSelfAwareness ?? true}
                          onchange={() => toggleSetting('contextSelfAwareness')}
                        />
                      </SettingRow>
                      <SettingRow
                        label="Expand reasoning by default"
                        description="Show the agent's reasoning open in the chat. Each block can still be collapsed."
                      >
                        <SettingsToggle
                          label="Expand reasoning by default"
                          checked={agentSettingsStore.settings.reasoningExpandedByDefault ?? false}
                          onchange={() => toggleSetting('reasoningExpandedByDefault')}
                        />
                      </SettingRow>
                      <SettingRow
                        label="Files outside your home folder"
                        description="Let chat image previews and file viewers open files on external drives and mounts."
                      >
                        <SettingsToggle
                          label="Files outside your home folder"
                          checked={agentSettingsStore.settings.allowExternalPaths ?? false}
                          onchange={() => toggleSetting('allowExternalPaths')}
                        />
                      </SettingRow>
                    </div>

                    <div class="agent-subgroup">
                      <div class="agent-subheading">Memory</div>
                      <SettingRow
                        label="Remember explicit requests"
                        description="Save a request to project preferences only when you say remember or always. Ordinary conversation never writes preferences. Agent memory files are managed under Memory."
                      >
                        <SettingsToggle
                          label="Remember explicit requests"
                          checked={agentSettingsStore.settings.agentCanUpdatePreferences}
                          onchange={() => toggleSetting('agentCanUpdatePreferences')}
                        />
                      </SettingRow>
                    </div>
                    {:else if group.id === 'research'}
                    <div class="agent-subgroup">
                      <SettingRow
                        label="Local web search"
                        description="Experimental. Today only Off has an effect: it turns off web search for providers that honour this setting (currently Grok Build). Fallback and On currently behave the same."
                      >
                        <SegmentedChoice
                          label="Local web search mode"
                          value={agentSettingsStore.settings.localWebSearch ?? 'fallback'}
                          options={[
                            { value: 'off', label: 'Off', description: 'Turn off web search where the provider honours this setting.' },
                            { value: 'fallback', label: 'Fallback', description: 'Default. Web search stays available.' },
                            { value: 'on', label: 'On', description: 'Web search stays available.' },
                          ]}
                          onchange={(value) =>
                            agentSettingsStore.saveSettings(
                              { localWebSearch: value as 'off' | 'on' | 'fallback' },
                              { quietSuccess: true },
                            )}
                        />
                      </SettingRow>
                      <SettingRow
                        label="Multi-source research"
                        description="For research tasks, check at least 3 to 5 different sources and note where they agree or disagree."
                      >
                        <SettingsToggle
                          label="Multi-source research"
                          checked={agentSettingsStore.settings.multiSourceResearch}
                          onchange={() => toggleSetting('multiSourceResearch')}
                        />
                      </SettingRow>
                    </div>
                    {/if}
                  </SettingGroup>
                {/each}
              </div>
            </section>
          </SettingsPage>
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
                class="inline-flex items-center gap-1.5 rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-xs font-semibold text-[var(--color-on-accent)] hover:opacity-90"
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
                  <p class="mt-1 text-[11px] leading-relaxed text-[var(--color-text-muted)]">
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
                    class="rounded-md border border-[var(--color-border)] px-2.5 py-1 text-[11px] font-medium text-[var(--color-text-secondary)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
                    >{skillCreatorMode === 'template' ? 'Skip template' : 'Use template'}</button
                  >
                  <button
                    type="button"
                    onclick={() => (showSkillCreator = false)}
                    class="rounded-md px-2 py-1 text-[11px] text-[var(--color-text-muted)] hover:bg-[var(--color-surface-3)]"
                    >Close</button
                  >
                </div>
              </div>
              <div class="grid gap-3 lg:grid-cols-2">
                <label class="text-[11px] font-medium text-[var(--color-text-secondary)]">
                  Skill name
                  <input
                    value={newSkillName}
                    oninput={(event) =>
                      (newSkillName = normalizeSkillName(event.currentTarget.value))}
                    placeholder="release-notes-review"
                    class="mt-1 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-0)] px-3 py-2 text-xs text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none"
                  />
                </label>
                <div class="text-[11px] font-medium text-[var(--color-text-secondary)]">
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
                          ? 'bg-[var(--color-accent)] text-[var(--color-on-accent)]'
                          : 'text-[var(--color-text-muted)] hover:bg-[var(--color-surface-3)]'}"
                        >{source}</button
                      >
                    {/each}
                  </div>
                </div>
                <label
                  class="text-[11px] font-medium text-[var(--color-text-secondary)] lg:col-span-2"
                >
                  What it does and when to use it
                  <input
                    bind:value={newSkillDescription}
                    placeholder="Review release notes for accuracy, user impact, and missing migration guidance."
                    class="mt-1 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-0)] px-3 py-2 text-xs text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none"
                  />
                </label>
                <label class="text-[11px] font-medium text-[var(--color-text-secondary)]">
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
                <label class="text-[11px] font-medium text-[var(--color-text-secondary)]">
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
                    <h5 class="text-[11px] font-semibold text-[var(--color-text-primary)]">
                      Professional relationships
                    </h5>
                    <p class="mt-1 text-[11px] leading-relaxed text-[var(--color-text-muted)]">
                      Broader concepts form the hierarchy. Facets add cross-cutting practice;
                      requirements are mandatory dependencies; conflicts cannot be selected
                      together.
                    </p>
                  </div>
                  <div class="grid gap-3 lg:grid-cols-2">
                    <div class="space-y-1.5">
                      <span class="text-[11px] font-medium text-[var(--color-text-secondary)]"
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
                            class="inline-flex items-center gap-1 rounded-md bg-[var(--color-accent)]/10 px-2 py-1 text-[11px] text-[var(--color-accent)]"
                            >{relation}<XCircle size={11} /></button
                          >
                        {/each}
                      </div>
                    </div>
                    <div class="space-y-1.5">
                      <span class="text-[11px] font-medium text-[var(--color-text-secondary)]"
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
                            class="inline-flex items-center gap-1 rounded-md bg-[var(--color-surface-3)] px-2 py-1 text-[11px] text-[var(--color-text-secondary)]"
                            >{relation}<XCircle size={11} /></button
                          >
                        {/each}
                      </div>
                    </div>
                    <div class="space-y-1.5">
                      <span class="text-[11px] font-medium text-[var(--color-text-secondary)]"
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
                            class="inline-flex items-center gap-1 rounded-md bg-[var(--color-surface-3)] px-2 py-1 text-[11px] text-[var(--color-text-secondary)]"
                            >{relation}<XCircle size={11} /></button
                          >
                        {/each}
                      </div>
                    </div>
                    <div class="space-y-1.5">
                      <span class="text-[11px] font-medium text-[var(--color-text-secondary)]"
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
                            class="inline-flex items-center gap-1 rounded-md bg-[var(--color-warning)]/10 px-2 py-1 text-[11px] text-[var(--color-warning)]"
                            >{relation}<XCircle size={11} /></button
                          >
                        {/each}
                      </div>
                    </div>
                  </div>
                </div>
                <div class="space-y-1.5">
                  <span class="text-[11px] font-medium text-[var(--color-text-secondary)]"
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
                        class="inline-flex items-center gap-1 rounded-md bg-[var(--color-surface-3)] px-2 py-1 text-[11px] text-[var(--color-text-secondary)] disabled:cursor-not-allowed disabled:opacity-50"
                        >{medium}<XCircle size={11} /></button
                      >
                    {/each}
                  </div>
                </div>
                <label class="text-[11px] font-medium text-[var(--color-text-secondary)]">
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
                    <div class="mb-2 text-[11px] font-medium text-[var(--color-text-secondary)]">
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
                    <p class="mt-1 text-[11px] text-[var(--color-text-muted)]">
                      Updated from broader concepts and verified server-side against the graph.
                    </p>
                  </div>
                  <div>
                    <div class="mb-2 text-[11px] font-medium text-[var(--color-text-secondary)]">
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
                    <p class="mt-1 text-[11px] text-[var(--color-text-muted)]">
                      Maximum injected characters for this skill, including its prompt header.
                    </p>
                  </div>
                </div>
                <label class="text-[11px] font-medium text-[var(--color-text-secondary)]">
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
                <label class="text-[11px] font-medium text-[var(--color-text-secondary)]">
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
                  class="text-[11px] font-medium text-[var(--color-text-secondary)] lg:col-span-2"
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
                  class="text-[11px] font-medium text-[var(--color-text-secondary)] lg:col-span-2"
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
                <p class="text-[11px] text-[var(--color-text-muted)]">
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
                  class="rounded-lg bg-[var(--color-accent)] px-4 py-2 text-xs font-semibold text-[var(--color-on-accent)] disabled:cursor-not-allowed disabled:bg-[var(--color-surface-3)] disabled:text-[var(--color-text-muted)] disabled:shadow-none"
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
              class="rounded-lg bg-[var(--color-accent)] px-3 py-2 text-xs font-medium text-[var(--color-on-accent)] disabled:cursor-not-allowed disabled:bg-[var(--color-surface-3)] disabled:text-[var(--color-text-muted)] disabled:shadow-none"
              >Preview routing plan</button
            >
          </div>
          {#if agentSettingsStore.skillResolutionPreview}
            {@const preview = agentSettingsStore.skillResolutionPreview!}
            <div class="mt-2 text-[11px] text-[var(--color-text-muted)]">
              Planning-only routing preview · {preview.selected.length} selected ·
              {preview.totalContextCost}/{preview.contextBudget} context characters ({preview.contextOverheadCost}
              manifest/header) ·
              {preview.blocked ? 'routing blocked pending a decision' : 'routing valid'}
            </div>
            <p class="mt-1 text-[11px] leading-relaxed text-[var(--color-text-muted)]">
              {preview.planningLimit} This preview never claims that the current manager turn will fit.
            </p>
            {#if preview.selected.length}
              <div class="mt-2 flex flex-wrap gap-1.5">
                {#each preview.selected as item (item.skill.hash)}
                  <span
                    title={`${item.reason}${item.representation === 'full' ? '' : ` · ${item.omittedDetailChars} detailed characters omitted to fit context`}`}
                    class="rounded px-2 py-1 text-[11px] {item.representation === 'full'
                      ? 'bg-[var(--color-accent)]/10 text-[var(--color-accent)]'
                      : 'bg-[var(--color-warning)]/10 text-[var(--color-warning)]'}"
                    >{item.skill.name} · {item.representation} · {item.contextCost}</span
                  >
                {/each}
              </div>
            {/if}
            {#if preview.compressedByBudget.length}
              <div
                class="mt-2 rounded-lg border border-[var(--color-warning)]/30 bg-[var(--color-warning)]/5 p-2 text-[11px] leading-relaxed text-[var(--color-text-secondary)]"
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
                class="mt-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-1)] p-2 text-[11px]"
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
                class="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/5 p-2 text-[11px]"
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
                      ? 'bg-[var(--color-accent)] text-[var(--color-on-accent)]'
                      : 'bg-[var(--color-surface-3)] text-[var(--color-text-secondary)]'}"
                    >Use {source}</button
                  >
                {/each}
              </div>
            {/each}
            {#if preview.selectionConflicts.length || preview.hierarchyErrors.length || preview.omittedByBudget.length}
              <div class="mt-2 text-[11px] text-[var(--color-error)]">
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
                        class="rounded bg-[var(--color-accent)]/15 px-1.5 py-0.5 text-[11px] text-[var(--color-accent)]"
                        title="A newer bundled version is available. Use Compare to review and merge."
                        >update</span
                      >
                    {/if}
                    <span
                      class="rounded px-1.5 py-0.5 text-[11px] {skill.state === 'active'
                        ? 'bg-[var(--color-success)]/15 text-[var(--color-success)]'
                        : 'bg-[var(--color-warning)]/15 text-[var(--color-warning)]'}"
                      >{skill.state}</span
                    >
                  </div>
                </div>
                <div class="mt-1 text-[11px] text-[var(--color-text-muted)]">
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
                  <div class="truncate text-[11px] text-[var(--color-text-muted)]">
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
                    class="rounded-md bg-[var(--color-accent)] px-2 py-1 text-xs text-[var(--color-on-accent)] disabled:cursor-not-allowed disabled:bg-[var(--color-surface-3)] disabled:text-[var(--color-text-muted)] disabled:shadow-none"
                    >Save draft</button
                  >
                  {#if selectedSkill.state === 'draft'}<button
                      onclick={() => agentSettingsStore.testAndActivateSkill(selectedSkill)}
                      class="rounded-md bg-[var(--color-success)] px-2 py-1 text-xs text-[var(--color-on-success)]"
                      >Test & activate</button
                    >{/if}
                </div>
              </div>
              <div
                class="flex flex-wrap gap-1.5 border-b border-[var(--color-border)] px-4 py-2 text-[11px] text-[var(--color-text-muted)]"
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
                class="border-b border-[var(--color-border)] px-4 py-2 text-[11px] text-[var(--color-text-muted)]"
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
                class="border-b border-[var(--color-border)] px-4 py-2 text-[11px] text-[var(--color-text-muted)]"
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
        <SettingsPage
          title="Workflow preferences"
          description="Plain-language rules and standards Kory should follow in this project."
          width="wide"
        >
          {#snippet meta()}
            {#if prefs?.exists}
              <span class="preferences-file-meta"><CheckCircle size={13} /> {prefs.path}</span>
            {:else}
              <span class="preferences-file-meta warning"
                ><AlertTriangle size={13} /> Not initialized</span
              >
            {/if}
            {@render projectScope()}
          {/snippet}
          {#snippet actions()}
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
          {/snippet}

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
                <FileText size={18} />
                <div>
                  <strong>No preferences file yet</strong>
                  <span>Initialize a thoughtful starter template, then make it yours.</span>
                </div>
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

            <footer class="preferences-page-footer">
              <span>Stored locally in this project. Changes apply to future agent work.</span>
              {#if prefs?.exists}<span class="preferences-path" title={prefs.path}>{prefs.path}</span
                >{/if}
            </footer>
          </section>
        </SettingsPage>
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

  .agent-settings-content,
  .preferences-settings-scroll,
  .agent-gutter {
    scrollbar-gutter: stable;
  }

  /* Non-scrolling strips (tabs, save errors) reserve the same scrollbar
     gutter as the scrolling page so their column lines up with it. */
  .agent-gutter {
    overflow: hidden;
  }

  /* Mirrors SettingsPage width="wide": same max width, centering and inline
     padding, so the tab strip shares the page's left edge. */
  .agent-column {
    width: 100%;
    max-width: calc(1080px + 64px);
    margin-inline: auto;
    padding-inline: 32px;
  }

  @media (max-width: 640px) {
    .agent-column {
      padding-inline: 16px;
    }
  }

  .agent-page-summary {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .agent-page-summary button {
    padding: 5px 9px;
    border-radius: 6px;
    background: var(--color-surface-2);
    color: var(--color-text-secondary);
    font-size: 11px;
    white-space: nowrap;
    transition: background-color 150ms ease-out;
  }

  .agent-page-summary button:hover {
    background: var(--color-surface-3);
    color: var(--color-text-primary);
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

  .agent-reset-action:focus-visible {
    outline: 2px solid color-mix(in srgb, var(--color-accent) 70%, transparent);
    outline-offset: 1px;
  }

  .agent-reset-action:hover {
    background: var(--color-error-bg);
    color: var(--color-error);
  }

  .agent-subheading {
    padding: 14px 20px 2px;
    color: var(--color-text-muted);
    font-size: 10px;
    font-weight: 650;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }

  .agent-subnote {
    margin: 2px 20px 4px;
    color: var(--color-text-muted);
    font-size: 11px;
  }

  .agent-block-heading {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin: 0 0 12px;
  }

  .agent-block-heading h3 {
    margin: 0;
    color: var(--color-text-primary);
    font-size: 14px;
    font-weight: 600;
  }

  .agent-block-heading p {
    margin: 0;
    color: var(--color-text-muted);
    font-size: 12px;
    line-height: 1.55;
  }

  .agent-card {
    overflow: hidden;
    border: 1px solid var(--color-border);
    border-radius: 1rem;
    background: var(--color-surface-1);
  }

  .agent-status-pill {
    border-radius: 999px;
    padding: 2px 9px;
    background: var(--color-surface-3);
    color: var(--color-text-muted);
    font-size: 11px;
    font-weight: 600;
  }

  .agent-status-pill[data-on='true'] {
    background: var(--color-success-bg);
    color: var(--color-success);
  }

  .agent-text-button {
    border-radius: 6px;
    padding: 3px 8px;
    color: var(--color-accent);
    font-size: 12px;
    font-weight: 550;
  }

  .agent-text-button:hover {
    background: var(--color-surface-2);
  }

  .agent-text-button:focus-visible,
  .agent-page-summary button:focus-visible {
    outline: 2px solid color-mix(in srgb, var(--color-accent) 70%, transparent);
    outline-offset: 1px;
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

  .agent-settings-content :global(button[role='switch']:not(.flat):not(.kory-toggle)) {
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

  .preferences-file-meta {
    display: inline-flex;
    min-width: 0;
    align-items: center;
    gap: 6px;
    color: var(--color-success);
    font-size: 11px;
  }

  .preferences-file-meta.warning {
    color: var(--color-warning);
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
    color: var(--color-on-accent);
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

  .preferences-primary-action:disabled {
    cursor: not-allowed;
    background: var(--color-surface-3);
    color: var(--color-text-muted);
    box-shadow: none;
  }

  .preferences-text-action:disabled {
    cursor: not-allowed;
    opacity: 0.42;
  }

  .preferences-editor-section {
    min-width: 0;
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
    color: var(--color-text-primary);
    font-size: 14px;
    font-weight: 600;
  }

  .preferences-section-heading p {
    margin: 4px 0 0;
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
    align-items: flex-start;
    gap: 12px;
    border-radius: 8px;
    padding: 14px 16px;
    background: var(--color-surface-2);
    color: var(--color-text-muted);
  }

  .preferences-empty-state :global(svg) {
    flex-shrink: 0;
    margin-top: 1px;
    color: var(--color-text-muted);
  }

  .preferences-empty-state strong {
    display: block;
    color: var(--color-text-primary);
    font-size: 13px;
    font-weight: 600;
  }

  .preferences-empty-state span {
    display: block;
    margin-top: 2px;
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
    .preferences-page-footer {
      flex-direction: column;
      gap: 5px;
    }

    .preferences-path {
      max-width: 100%;
    }
  }
</style>
