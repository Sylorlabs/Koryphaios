<script lang="ts">
  import { agentSettingsStore, DEFAULT_AGENT_SETTINGS } from '$lib/stores/agent-settings.svelte';
  import SettingsSwitch from './SettingsSwitch.svelte';
  import { providersStore } from '$lib/stores/providers.svelte';
  import NumberStepper from './NumberStepper.svelte';
  import KorySelect from './KorySelect.svelte';
  import SettingsPageIntro from './SettingsPageIntro.svelte';
  import { goalDisplayStore } from '$lib/stores/goal-display.svelte';
  import {
    Bot,
    Shield,
    FileText,
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
    ChevronRight,
    StickyNote,
    Wrench,
    LockKeyhole,
    GitBranch,
    Brain,
    Route,
    Search,
  } from 'lucide-svelte';

  // Props
  interface Props {
    onClose?: () => void;
    focusPermissions?: boolean;
  }

  let { onClose, focusPermissions = false }: Props = $props();

  type ControlSection = 'permissions' | 'quality' | 'workflow' | 'context' | 'research' | 'routing';
  let selectedControlSection = $state<ControlSection>('permissions');

  const CONTROL_SECTIONS = [
    { id: 'permissions', label: 'Permissions & autonomy', description: 'Approvals and change limits', icon: LockKeyhole },
    { id: 'quality', label: 'Quality & Critic', description: 'Review and verification', icon: Gavel },
    { id: 'workflow', label: 'Workflow', description: 'Planning and learning', icon: GitBranch },
    { id: 'context', label: 'Context & memory', description: 'Context and persistence', icon: Brain },
    { id: 'research', label: 'Research', description: 'Search and source policy', icon: Search },
    { id: 'routing', label: 'Routing & guidance', description: 'Models and manager notes', icon: Route },
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
  let showModelAccess = $state(false);

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
    agentSettingsStore.skills.filter((skill) => skill.state === 'active').length,
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
      notesPlaceholder: 'e.g. State the plan for multi-step work. Keep the manager informed of real blockers.',
    },
    {
      id: 'frontend',
      label: 'Frontend work',
      notesPlaceholder: 'e.g. Reuse Koryphaios components and theme tokens. Check keyboard and narrow-window states.',
    },
    {
      id: 'backend',
      label: 'Backend work',
      notesPlaceholder: 'e.g. Preserve API contracts. Add focused route tests and fail closed on missing authorization.',
    },
    {
      id: 'review',
      label: 'Review',
      notesPlaceholder: 'e.g. Prioritize correctness, regressions, and security. Report findings with paths and severity.',
    },
    {
      id: 'test',
      label: 'Testing',
      notesPlaceholder: 'e.g. Run focused tests first, then the relevant integration gate. Cover failure states too.',
    },
    {
      id: 'critic',
      label: 'Critic',
      notesPlaceholder: 'e.g. Challenge unsupported claims and missing evidence. Pass only proven acceptance criteria.',
    },
  ];
  const availableModels = $derived.by(() =>
    providersStore.statusList
      .filter((p) => p.enabled && p.authenticated)
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

  // Enforcement level options - uses semantic theme colors
  const enforcementLevels = [
    {
      value: 'strict',
      label: 'Strict',
      description: 'Critic blocks ANY rule violation',
      icon: AlertOctagon,
      color: 'var(--color-error)',
      bgColor: 'var(--color-error-bg, rgba(239, 68, 68, 0.1))',
    },
    {
      value: 'moderate',
      label: 'Moderate',
      description: 'Critic blocks critical violations, warns on others',
      icon: AlertTriangle,
      color: 'var(--color-warning)',
      bgColor: 'var(--color-warning-bg, rgba(245, 158, 11, 0.1))',
    },
    {
      value: 'lenient',
      label: 'Lenient',
      description: 'Critic only blocks critical violations',
      icon: Eye,
      color: 'var(--color-info, #3b82f6)',
      bgColor: 'var(--color-info-bg, rgba(59, 130, 246, 0.1))',
    },
  ] as const;
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
    {:else if agentSettingsStore.activeTab === 'settings'}
      <div class="flex h-full min-h-0 flex-col overflow-hidden">
        <SettingsPageIntro title="Agent settings" description="Choose one area at a time. Changes are saved to this workspace as soon as you make them.">
          <span class="rounded-full bg-[var(--color-surface-3)] px-2.5 py-1 text-[10px] text-[var(--color-text-muted)]">
            {agentSettingsStore.settings.agentExecutionMode} execution
          </span>
          <span class="rounded-full bg-[var(--color-surface-3)] px-2.5 py-1 text-[10px] text-[var(--color-text-muted)]">
            critic {agentSettingsStore.settings.criticGateEnabled ? 'on' : 'off'}
          </span>
          <button type="button" class="rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-xs text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-3)]" onclick={() => agentSettingsStore.setActiveTab('preferences')}>Preferences</button>
          <button type="button" class="rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-xs text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-3)]" onclick={() => agentSettingsStore.setActiveTab('skills')}>Skills</button>
        </SettingsPageIntro>
        <div class="h-full min-h-0 overflow-y-auto p-4 sm:p-6">
        <div class="mx-auto max-w-7xl space-y-5">
          <section class="grid gap-2 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-1)] p-4 sm:grid-cols-3">
            <div class="rounded-xl bg-[var(--color-surface-2)] px-3 py-2.5">
              <div class="text-sm font-semibold capitalize text-[var(--color-text-primary)]">{agentSettingsStore.settings.permissionMode === 'plan' ? 'guarded' : agentSettingsStore.settings.permissionMode ?? 'guarded'}</div>
              <div class="mt-1 text-[10px] text-[var(--color-text-muted)]">Permission mode</div>
            </div>
            <div class="rounded-xl bg-[var(--color-surface-2)] px-3 py-2.5">
              <div class="text-sm font-semibold text-[var(--color-text-primary)]">{agentSettingsStore.settings.criticGateEnabled ? 'Enabled' : 'Disabled'}</div>
              <div class="mt-1 text-[10px] text-[var(--color-text-muted)]">Critic review</div>
            </div>
            <div class="rounded-xl bg-[var(--color-surface-2)] px-3 py-2.5">
              <div class="text-sm font-semibold text-[var(--color-success)]">Auto-saved</div>
              <div class="mt-1 text-[10px] text-[var(--color-text-muted)]">Workspace settings</div>
            </div>
          </section>

          <div class="grid min-w-0 gap-5 lg:grid-cols-[230px_minmax(0,1fr)]">
            <aside class="min-w-0" aria-label="Agent settings categories">
              <div class="flex gap-2 overflow-x-auto pb-1 lg:sticky lg:top-0 lg:block lg:space-y-1 lg:overflow-visible lg:pb-0">
                {#each CONTROL_SECTIONS as section (section.id)}
                  <button
                    type="button"
                    aria-pressed={selectedControlSection === section.id}
                    onclick={() => (selectedControlSection = section.id)}
                    class="flex min-h-12 shrink-0 items-center gap-3 rounded-xl px-3 text-left transition-colors lg:w-full {selectedControlSection === section.id ? 'bg-[var(--color-surface-3)] text-[var(--color-text-primary)]' : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-2)]'}"
                  >
                    <section.icon size={16} class="shrink-0" />
                    <span class="min-w-0">
                      <span class="block text-xs font-medium">{section.label}</span>
                      <span class="mt-0.5 hidden text-[10px] text-[var(--color-text-muted)] lg:block">{section.description}</span>
                    </span>
                  </button>
                {/each}
                <div class="hidden border-t border-[var(--color-border)] pt-3 lg:mt-4 lg:block">
                  <button
                    type="button"
                    onclick={() => agentSettingsStore.resetSettings()}
                    class="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-xs text-[var(--color-text-muted)] transition-colors hover:bg-red-500/10 hover:text-red-400"
                  >
                    <RotateCcw size={14} /> Reset agent settings
                  </button>
                </div>
              </div>
            </aside>
            <main class="min-w-0">
        <div class="grid gap-5">
          <div class="space-y-6">
            {#if selectedControlSection === 'permissions'}
              <section class="space-y-5 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-1)] p-5">
                <div>
                  <div class="flex items-center gap-2">
                    <LockKeyhole size={17} class="text-[var(--color-accent)]" />
                    <h4 class="text-sm font-semibold text-[var(--color-text-primary)]">Permissions & autonomy</h4>
                  </div>
                  <p class="mt-1 text-xs leading-relaxed text-[var(--color-text-muted)]">Choose a preset or build a custom approval policy for this workspace.</p>
                </div>

                <div class="grid gap-2 sm:grid-cols-2 xl:grid-cols-6" role="radiogroup" aria-label="Permission mode">
                  {#each [
                    { value: 'guarded', label: 'Guarded', description: 'Ask only when risk is high' },
                    { value: 'edits', label: 'Accept edits', description: 'Apply edits; ask for other actions' },
                    { value: 'ask', label: 'Ask', description: 'Confirm every action' },
                    { value: 'custom', label: 'Custom', description: 'Use the rules below' },
                    { value: 'yolo', label: 'YOLO', description: 'No approval or risk checks' },
                  ] as mode (mode.value)}
                    {@const active = (agentSettingsStore.settings.permissionMode === 'plan' ? 'guarded' : agentSettingsStore.settings.permissionMode ?? 'guarded') === mode.value}
                    <button
                      type="button"
                      role="radio"
                      aria-checked={active}
                      onclick={() => agentSettingsStore.saveSettings({ permissionMode: mode.value as 'yolo' | 'guarded' | 'edits' | 'ask' | 'plan' | 'custom' }, { quietSuccess: true })}
                      class="min-h-24 rounded-xl border p-3 text-left transition-colors {active ? 'border-[var(--color-accent)] bg-[var(--color-surface-3)]' : 'border-[var(--color-border)] bg-[var(--color-surface-2)] hover:border-[var(--color-border-bright)]'}"
                    >
                      <span class="flex items-center justify-between gap-2 text-xs font-semibold text-[var(--color-text-primary)]">
                        {mode.label}
                        {#if active}<CheckCircle size={14} class="text-[var(--color-accent)]" />{/if}
                      </span>
                      <span class="mt-2 block text-[10px] leading-relaxed text-[var(--color-text-muted)]">{mode.description}</span>
                    </button>
                  {/each}
                </div>

                {#if agentSettingsStore.settings.permissionMode === 'custom'}
                  <div class="space-y-3 border-t border-[var(--color-border)] pt-4">
                    <div>
                      <h5 class="text-xs font-semibold text-[var(--color-text-primary)]">Custom approval rules</h5>
                      <p class="mt-1 text-[10px] text-[var(--color-text-muted)]">Fine-tune when Kory continues and when it pauses for you.</p>
                    </div>
                    <div class="grid gap-3 sm:grid-cols-2">
                      <SettingsSwitch
                        checked={agentSettingsStore.settings.autoRunTools}
                        label="Start routine work automatically"
                        description="Begin normal tool-using work without an upfront proceed prompt."
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
                      <SettingsSwitch
                        checked={agentSettingsStore.settings.agentMemoryEnabled}
                        label="Allow memory updates"
                        description="Let agents update the project memory files they use between runs."
                        onchange={() => toggleSetting('agentMemoryEnabled')}
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
                  <Gavel size={16} style="color: var(--color-error);" />
                  Guardrails
                </h4>
                <p class="text-xs text-[var(--color-text-muted)]">
                  Choose how strictly the Critic enforces rules. Rules are always applied.
                </p>
              </div>

              <div class="grid gap-3 lg:grid-cols-3">
                {#each enforcementLevels as level (level.value)}
                  <button
                    onclick={() =>
                      agentSettingsStore.saveSettings({ ruleEnforcementLevel: level.value })}
                    class="flex h-full flex-col gap-3 rounded-xl border p-4 text-left transition-all
                      {agentSettingsStore.settings.ruleEnforcementLevel === level.value
                      ? 'border-[var(--color-accent)] shadow-sm'
                      : 'border-[var(--color-border)] bg-[var(--color-surface-2)] hover:bg-[var(--color-surface-3)]'}"
                    style={agentSettingsStore.settings.ruleEnforcementLevel === level.value
                      ? `background: ${level.bgColor};`
                      : ''}
                  >
                    <div class="flex items-center justify-between gap-3">
                      <div class="flex items-center gap-2">
                        <div
                          class="rounded-lg p-2"
                          style={`background: color-mix(in srgb, ${level.color} 14%, transparent); color: ${level.color};`}
                        >
                          <level.icon size={18} />
                        </div>
                        <span class="text-sm font-medium text-[var(--color-text-primary)]"
                          >{level.label}</span
                        >
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
            {/if}

            {#if selectedControlSection === 'quality'}
            <section
              class="space-y-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-1)] p-5"
            >
              <div class="space-y-1">
                <h4
                  class="flex items-center gap-2 text-sm font-semibold text-[var(--color-text-primary)]"
                >
                  <Shield size={16} class="text-purple-400" />
                  Guardrail workflow
                </h4>
                <p class="text-xs text-[var(--color-text-muted)]">
                  Repository mutations always fail closed. These controls tune additional review for non-mutating work.
                </p>
              </div>

              <div class="grid gap-3 sm:grid-cols-2">
                <SettingsSwitch
                  checked={agentSettingsStore.settings.criticGateEnabled}
                  label="Review Non-Mutating Work"
                  description="Also run Critic review for answers and research. Code and file changes are always gated."
                  onchange={() => toggleSetting('criticGateEnabled')}
                />

                <SettingsSwitch
                  checked={agentSettingsStore.settings.criticEnforcesPreferences}
                  label="Critic Enforces Preferences"
                  description="Apply preferences.md as a hard workflow contract."
                  onchange={() => toggleSetting('criticEnforcesPreferences')}
                />

              </div>

              <div class="grid gap-3 sm:grid-cols-2">
                <KorySelect
                  label="Answer/research strictness"
                  value={agentSettingsStore.settings.gateStrictness ?? 'strict'}
                  options={[
                    { value: 'strict', label: 'Fail closed' },
                    { value: 'advisory', label: 'Advisory' },
                    { value: 'off', label: 'Off — mutations still gated' },
                  ]}
                  onchange={(value) =>
                    agentSettingsStore.saveSettings(
                      { gateStrictness: value as 'strict' | 'advisory' | 'off' },
                      { quietSuccess: true },
                    )}
                />
                <KorySelect
                  label="Model qualification"
                  value={agentSettingsStore.settings.modelQualification ?? 'enforce'}
                  options={[
                    { value: 'enforce', label: 'Enforce qualified roles' },
                    { value: 'warn', label: 'Warn only' },
                    { value: 'off', label: 'Off' },
                  ]}
                  onchange={(value) =>
                    agentSettingsStore.saveSettings(
                      { modelQualification: value as 'enforce' | 'warn' | 'off' },
                      { quietSuccess: true },
                    )}
                />
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
                  Control clarification, consequential plan approval, local feedback, and reversible
                  learning.
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
                  label="Plan approval"
                  value={agentSettingsStore.settings.planApproval ?? 'material'}
                  options={[
                    { value: 'always', label: 'Always' },
                    { value: 'material', label: 'Material decisions' },
                    { value: 'never', label: 'Never' },
                  ]}
                  onchange={(value) =>
                    agentSettingsStore.saveSettings(
                      { planApproval: value as 'always' | 'material' | 'never' },
                      { quietSuccess: true },
                    )}
                />
                <KorySelect
                  label="Feedback sharing"
                  value={agentSettingsStore.settings.feedbackSharing ?? 'local'}
                  options={[
                    { value: 'local', label: 'Local only' },
                    { value: 'sanitized-opt-in', label: 'Sanitized opt-in' },
                  ]}
                  onchange={(value) =>
                    agentSettingsStore.saveSettings(
                      { feedbackSharing: value as 'local' | 'sanitized-opt-in' },
                      { quietSuccess: true },
                    )}
                />
                <KorySelect
                  label="Goal planning"
                  value={agentSettingsStore.settings.goalPlanningDepth ?? 'adaptive'}
                  options={[{ value: 'minimal', label: 'Minimal' }, { value: 'adaptive', label: 'Adaptive' }, { value: 'structured', label: 'Structured' }]}
                  onchange={(value) => agentSettingsStore.saveSettings({ goalPlanningDepth: value as 'minimal' | 'adaptive' | 'structured' }, { quietSuccess: true })}
                />
                <KorySelect
                  label="Skill learning"
                  value={agentSettingsStore.settings.skillLearningMode ?? 'propose-then-verify'}
                  options={[
                    { value: 'human-only', label: 'Human only' },
                    { value: 'propose-then-verify', label: 'Propose then verify' },
                    { value: 'automatic', label: 'Automatic, reversible' },
                  ]}
                  onchange={(value) =>
                    agentSettingsStore.saveSettings(
                      {
                        skillLearningMode: value as
                          | 'human-only'
                          | 'propose-then-verify'
                          | 'automatic',
                      },
                      { quietSuccess: true },
                    )}
                />
              </div>
              <SettingsSwitch
                checked={agentSettingsStore.settings.designDiscovery ?? true}
                label="Design Discovery"
                description="Resolve audience, medium, hierarchy, accessibility, references, and dislikes before ambiguous interface work."
                onchange={() => toggleSetting('designDiscovery')}
              />
              <SettingsSwitch
                checked={goalDisplayStore.sidebar}
                label="Show Active Goals in sidebar"
                description="Keep the compact cross-chat goal list visible in the session sidebar."
                onchange={() => goalDisplayStore.update({ sidebar: !goalDisplayStore.sidebar })}
              />
              <SettingsSwitch
                checked={goalDisplayStore.composer}
                label="Show goal context in composer"
                description="Place the optional goal selector to the right of model and reasoning controls."
                onchange={() => goalDisplayStore.update({ composer: !goalDisplayStore.composer })}
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
                  Keep thresholds ready, then explicitly turn them on for runs that need an approval boundary.
                </p>
              </div>

              <SettingsSwitch
                checked={agentSettingsStore.settings.autonomyLimitsEnabled}
                label="Enable autonomy limits"
                description={agentSettingsStore.settings.autonomyLimitsEnabled
                  ? `Active: approval is required before edits exceeding ${agentSettingsStore.settings.approvalThresholdFiles} files or ${agentSettingsStore.settings.approvalThresholdLines} lines.`
                  : 'Off by default. The values below are saved but do not constrain runs until you enable this switch.'}
                onchange={() => toggleSetting('autonomyLimitsEnabled')}
              />

              <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div class="rounded-xl bg-[var(--color-surface-2)] p-4">
                  <label for="max-files" class="mb-2 block text-xs text-[var(--color-text-muted)]"
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
                  <label for="max-lines" class="mb-2 block text-xs text-[var(--color-text-muted)]"
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

            {#if selectedControlSection === 'context'}
            <section
              class="space-y-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-1)] p-5"
            >
              <div class="space-y-1">
                <h4 class="text-sm font-semibold text-[var(--color-text-primary)]">
                  Context & memory
                </h4>
                <p class="text-xs text-[var(--color-text-muted)]">
                  Everything the agent does is archived locally; stale tool outputs are collapsed
                  out of its context and stay recoverable via fetch_context. Nothing is ever lost.
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
                  checked={agentSettingsStore.settings.reasoningExpandedByDefault ?? false}
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
                    Outputs smaller than this (characters) stay in context — not worth collapsing.
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
                <h4 class="text-sm font-semibold text-[var(--color-text-primary)]">Memory policy</h4>
                <p class="text-xs text-[var(--color-text-muted)]">
                  Control whether the agent can persist what it learns.
                </p>
              </div>

              <div class="space-y-3">
                <SettingsSwitch
                  checked={agentSettingsStore.settings.agentMemoryEnabled}
                  label="Agent Can Update Memory"
                  description="Allow agents to update project memory files."
                  onchange={() => toggleSetting('agentMemoryEnabled')}
                />

                <SettingsSwitch
                  checked={agentSettingsStore.settings.agentCanUpdatePreferences}
                  label="Agent Can Update Preferences"
                  description="Allow agents to update preferences.md from learned workflow patterns."
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
                          aria-pressed={agentSettingsStore.settings.localWebSearch === option.value}
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
              <button type="button" class="flex w-full items-start justify-between gap-4 text-left" aria-expanded={showModelAccess} onclick={() => showModelAccess = !showModelAccess}>
                <span>
                  <span class="block text-sm font-semibold text-[var(--color-text-primary)]">Routing access</span>
                  <span class="mt-1 block text-xs text-[var(--color-text-muted)]">Restrict auto-routing by category. Your explicit composer choice always wins.</span>
                </span>
                <ChevronRight size={16} class="shrink-0 text-[var(--color-text-muted)] transition-transform {showModelAccess ? 'rotate-90' : ''}" />
              </button>
              {#if showModelAccess}
              <div class="mt-4 space-y-5">
                {#each MODEL_ACCESS_CATEGORIES as cat (cat.id)}
                  <div
                    class="rounded-xl p-4"
                    style="background: var(--color-surface-0); border: 1px solid var(--color-border);"
                  >
                    <span class="mb-3 block text-xs font-medium text-[var(--color-text-secondary)]"
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
                          <button
                            type="button"
                            role="switch"
                            aria-checked={checked}
                            aria-label={`Allow ${m} for ${cat.label}`}
                            onclick={() => void toggleCategoryModel(cat.id, m)}
                            class="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 text-left text-xs transition-colors"
                            style="background: {checked
                              ? 'var(--color-accent)' + '18'
                              : 'var(--color-surface-2)'}; border: 1px solid {checked
                              ? 'var(--color-accent)' + '60'
                              : 'var(--color-border)'};"
                          >
                            <span
                              class="grid h-4 w-4 shrink-0 place-items-center rounded border"
                              style="border-color: {checked
                                ? 'var(--color-accent)'
                                : 'var(--color-border)'}; background: {checked
                                ? 'var(--color-accent)'
                                : 'var(--color-surface-3)'};"
                              aria-hidden="true"
                              >{#if checked}<CheckCircle size={11} class="text-white" />{/if}</span
                            >
                            <span
                              class="min-w-0 truncate font-mono text-[var(--color-text-primary)]"
                              >{m}</span
                            >
                          </button>
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
                Per-group standing guidance injected into every conversation. Expand a group to edit
                its notes.
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
                            notesDrafts[cat.id] = { text: e.currentTarget.value, dirty: true };
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
            </main>
          </div>
        </div>
        </div>
      </div>
    {:else if agentSettingsStore.activeTab === 'skills'}
      <div class="flex h-full min-h-0 flex-col">
        <section class="border-b border-[var(--color-border)] bg-[var(--color-surface-2)] p-3">
          <div class="mb-3 flex items-center justify-between gap-3">
            <div><h3 class="text-sm font-semibold text-[var(--color-text-primary)]">Skills</h3><p class="mt-1 text-xs text-[var(--color-text-muted)]">Manage, test, and create local instructions available to the agent.</p></div>
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
              <button type="button" onclick={() => agentSettingsStore.setActiveTab('settings')} class="rounded-lg px-3 py-1.5 text-xs text-[var(--color-text-muted)] hover:bg-[var(--color-surface-3)]">Back to controls</button>
            </div>
          </div>
          {#if showSkillCreator}
            <div class="mb-3 rounded-xl border border-[var(--color-accent)]/40 bg-[var(--color-surface-1)] p-3">
              <div class="mb-3 flex items-start justify-between gap-3">
                <div>
                  <h4 class="text-xs font-semibold text-[var(--color-text-primary)]">Create a skill draft</h4>
                  <p class="mt-1 text-[10px] leading-relaxed text-[var(--color-text-muted)]">Start with concrete triggers, non-triggers, a real workflow, and evidence. The draft stays inactive until its trigger tests pass and you activate it.</p>
                </div>
                <button type="button" onclick={() => (showSkillCreator = false)} class="rounded-md px-2 py-1 text-[10px] text-[var(--color-text-muted)] hover:bg-[var(--color-surface-3)]">Close</button>
              </div>
              <div class="grid gap-3 lg:grid-cols-2">
                <label class="text-[10px] font-medium text-[var(--color-text-secondary)]">
                  Skill name
                  <input
                    value={newSkillName}
                    oninput={(event) => (newSkillName = normalizeSkillName(event.currentTarget.value))}
                    placeholder="release-notes-review"
                    class="mt-1 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-0)] px-3 py-2 text-xs text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none"
                  />
                </label>
                <div class="text-[10px] font-medium text-[var(--color-text-secondary)]">
                  Save for
                  <div class="mt-1 flex rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-0)] p-1">
                    {#each ['personal', 'project'] as source (source)}
                      <button
                        type="button"
                        onclick={() => (newSkillSource = source as 'personal' | 'project')}
                        class="flex-1 rounded-md px-3 py-1.5 text-xs capitalize transition-colors {newSkillSource === source ? 'bg-[var(--color-accent)] text-white' : 'text-[var(--color-text-muted)] hover:bg-[var(--color-surface-3)]'}"
                      >{source}</button>
                    {/each}
                  </div>
                </div>
                <label class="text-[10px] font-medium text-[var(--color-text-secondary)] lg:col-span-2">
                  What it does and when to use it
                  <input bind:value={newSkillDescription} placeholder="Review release notes for accuracy, user impact, and missing migration guidance." class="mt-1 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-0)] px-3 py-2 text-xs text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none" />
                </label>
                <label class="text-[10px] font-medium text-[var(--color-text-secondary)]">
                  Trigger phrases <span class="font-normal text-[var(--color-text-muted)]">· one per line</span>
                  <textarea bind:value={newSkillTriggers} rows="2" placeholder={'release notes\nchangelog review'} class="mt-1 w-full resize-none rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-0)] px-3 py-2 text-xs text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none"></textarea>
                </label>
                <label class="text-[10px] font-medium text-[var(--color-text-secondary)]">
                  Domains <span class="font-normal text-[var(--color-text-muted)]">· one per line</span>
                  <textarea bind:value={newSkillDomains} rows="2" placeholder={'release\ncommunication'} class="mt-1 w-full resize-none rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-0)] px-3 py-2 text-xs text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none"></textarea>
                </label>
                <label class="text-[10px] font-medium text-[var(--color-text-secondary)]">
                  Should trigger <span class="font-normal text-[var(--color-text-muted)]">· at least two, one per line</span>
                  <textarea bind:value={newSkillPositiveExample} rows="3" placeholder={'Review these release notes before launch\nCheck this changelog for missing migration guidance'} class="mt-1 w-full resize-none rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-0)] px-3 py-2 text-xs text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none"></textarea>
                </label>
                <label class="text-[10px] font-medium text-[var(--color-text-secondary)]">
                  Should not trigger <span class="font-normal text-[var(--color-text-muted)]">· at least two, one per line</span>
                  <textarea bind:value={newSkillNegativeExample} rows="3" placeholder={'Fix this runtime crash\nDesign a settings screen'} class="mt-1 w-full resize-none rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-0)] px-3 py-2 text-xs text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none"></textarea>
                </label>
                <label class="text-[10px] font-medium text-[var(--color-text-secondary)] lg:col-span-2">
                  Instructions
                  <textarea bind:value={newSkillInstructions} rows="5" placeholder={'Describe the workflow in order. Include decisions, constraints, failure and recovery behavior, and what must be verified before completion.'} class="mt-1 w-full resize-y rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-0)] px-3 py-2 font-mono text-xs leading-relaxed text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none"></textarea>
                </label>
                <label class="text-[10px] font-medium text-[var(--color-text-secondary)] lg:col-span-2">
                  Completion evidence <span class="font-normal text-[var(--color-text-muted)]">· one item per line</span>
                  <textarea bind:value={newSkillEvidence} rows="2" placeholder={'Factual review complete\nRendered output verified'} class="mt-1 w-full resize-none rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-0)] px-3 py-2 text-xs text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none"></textarea>
                </label>
              </div>
              <div class="mt-3 flex items-center justify-between gap-3">
                <p class="text-[10px] text-[var(--color-text-muted)]">Personal skills follow you. Project skills live with this workspace.</p>
                <button
                  type="button"
                  onclick={() => void createSkill()}
                  disabled={!normalizeSkillName(newSkillName) || newSkillDescription.trim().length < 12 || newSkillInstructions.trim().length < 40 || splitSkillLines(newSkillPositiveExample).length < 2 || splitSkillLines(newSkillNegativeExample).length < 2 || (!newSkillTriggers.trim() && !newSkillPositiveExample.trim())}
                  class="rounded-lg bg-[var(--color-accent)] px-4 py-2 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40"
                >Create draft</button>
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
              >Preview selection</button
            >
          </div>
          {#if agentSettingsStore.skillResolutionPreview}
            {@const preview = agentSettingsStore.skillResolutionPreview}
            <div class="mt-2 text-[10px] text-[var(--color-text-muted)]">
              {preview.selected.length} selected · {preview.totalContextCost} context characters ·
              {preview.blocked ? 'blocked pending a decision' : 'ready'}
            </div>
            {#if preview.selected.length}
              <div class="mt-2 flex flex-wrap gap-1.5">
                {#each preview.selected as item (item.skill.hash)}
                  <span
                    title={`${item.reason}${item.representation === 'full' ? '' : ` · ${item.omittedDetailChars} detailed characters omitted to fit context`}`}
                    class="rounded px-2 py-1 text-[10px] {item.representation === 'full' ? 'bg-[var(--color-accent)]/10 text-[var(--color-accent)]' : 'bg-[var(--color-warning)]/10 text-[var(--color-warning)]'}"
                    >{item.skill.name} · {item.representation} · {item.contextCost}</span
                  >
                {/each}
              </div>
            {/if}
            {#if preview.compressedByBudget.length}
              <div class="mt-2 rounded-lg border border-[var(--color-warning)]/30 bg-[var(--color-warning)]/5 p-2 text-[10px] leading-relaxed text-[var(--color-text-secondary)]">
                Context-aware compression is active. Koryphaios retained each affected skill’s operating contract, safety boundaries, and completion evidence while omitting extended rationale and examples:
                {preview.compressedByBudget.map((item) => `${item.name} (${item.representation}, ${item.contextCost}/${item.fullContextCost} chars)`).join(' · ')}
              </div>
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
                style={`padding-left: ${10 + Math.min(skill.metadata.depth, 4) * 12}px`}
              >
                <div class="flex items-center justify-between gap-2">
                  <span class="truncate text-xs font-medium text-[var(--color-text-primary)]"
                    >{skill.name}</span
                  ><span
                    class="rounded px-1.5 py-0.5 text-[9px] {skill.state === 'active'
                      ? 'bg-[var(--color-success)]/15 text-[var(--color-success)]'
                      : 'bg-[var(--color-warning)]/15 text-[var(--color-warning)]'}"
                    >{skill.state}</span
                  >
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
                {#if selectedSkill.metadata.parent}<span
                    class="rounded bg-[var(--color-accent)]/10 px-1.5 py-0.5 text-[var(--color-accent)]"
                    >parent: {selectedSkill.metadata.parent}</span
                  >{/if}
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
                    >{gate.candidateRuns} observed runs · {gate.distinctProviders} providers · {gate.distinctModels} models · {gate.humanBlindReviews} blinded review{gate.humanBlindReviews ===
                    1
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
                    <div class="flex flex-wrap gap-1.5">
                      <button
                        type="button"
                        onclick={() =>
                          void agentSettingsStore.applyBundledSkillUpdate(
                            selectedSkill,
                            'keep-local',
                          )}
                        class="rounded bg-[var(--color-surface-3)] px-2 py-1 text-[10px] text-[var(--color-text-secondary)]"
                        >Keep local</button
                      >
                      <button
                        type="button"
                        onclick={() =>
                          void agentSettingsStore.applyBundledSkillUpdate(selectedSkill, 'merge')}
                        class="rounded bg-[var(--color-warning)] px-2 py-1 text-[10px] text-white"
                        >Merge to draft</button
                      >
                      <button
                        type="button"
                        onclick={() =>
                          void agentSettingsStore.applyBundledSkillUpdate(selectedSkill, 'replace')}
                        class="rounded bg-[var(--color-error)] px-2 py-1 text-[10px] text-white"
                        >Replace with bundled</button
                      >
                      <button
                        type="button"
                        onclick={() => (showSkillComparison = false)}
                        class="rounded border border-[var(--color-border)] px-2 py-1 text-[10px] text-[var(--color-text-secondary)]"
                        >Close</button
                      >
                    </div>
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
              <button type="button" onclick={() => agentSettingsStore.setActiveTab('settings')} class="px-2 py-1 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]">Back to controls</button>
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
                    {preferencesDirty
                    ? 'bg-yellow-500/20 text-yellow-400 hover:bg-yellow-500/30'
                    : 'bg-[var(--color-surface-3)] text-[var(--color-text-muted)]'}"
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
    {/if}
  </div>
</div>
