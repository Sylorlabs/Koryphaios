<script lang="ts">
  import CriticModeSelect from './CriticModeSelect.svelte';
  import { resolveCriticMode } from '@koryphaios/shared';
  /**
   * First-launch walkthrough.
   *
   * A short, skippable guided setup shown once per device. Every choice writes
   * straight to the real stores (theme, agent settings) so there is no
   * separate "onboarding state" to reconcile — closing the walkthrough at any
   * point simply leaves whatever was chosen so far, and "Skip" leaves the
   * Koryphaios defaults untouched.
   */
  import { onMount } from 'svelte';
  import { fade, fly, scale } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import SettingsSwitch from './SettingsSwitch.svelte';
  import ColorPickerModal from './ColorPickerModal.svelte';
  import ThemeModeEditor from './ThemeModeEditor.svelte';
  import CliChatImportPanel from './CliChatImportPanel.svelte';
  import { cliChatImportStore } from '$lib/stores/cli-chat-import.svelte';
  import { onboardingStore } from '$lib/stores/onboarding.svelte';
  import { theme, type ThemeScheme } from '$lib/stores/theme.svelte';
  import { agentSettingsStore, type AgentSettings } from '$lib/stores/agent-settings.svelte';
  import { providersStore } from '$lib/stores/providers.svelte';
  import Settings2 from 'lucide-svelte/icons/settings-2';
  import Palette from 'lucide-svelte/icons/palette';
  import MessageSquareText from 'lucide-svelte/icons/message-square-text';
  import ShieldCheck from 'lucide-svelte/icons/shield-check';
  import Plug from 'lucide-svelte/icons/plug';
  import FolderGit2 from 'lucide-svelte/icons/folder-git-2';
  import MonitorSmartphone from 'lucide-svelte/icons/monitor-smartphone';
  import Smartphone from 'lucide-svelte/icons/smartphone';
  import Monitor from 'lucide-svelte/icons/monitor';
  import Rocket from 'lucide-svelte/icons/rocket';
  import ArrowRight from 'lucide-svelte/icons/arrow-right';
  import ArrowLeft from 'lucide-svelte/icons/arrow-left';
  import Check from 'lucide-svelte/icons/check';
  import X from 'lucide-svelte/icons/x';

  interface Props {
    /** Temporarily hide the walkthrough while a nested setup surface is open. */
    suspended?: boolean;
    /** Open Settings → Providers without finishing the walkthrough. */
    onOpenProviders: () => void;
    /** Open Settings → Link device without finishing the walkthrough. */
    onOpenDevices: () => void;
  }

  let { suspended = false, onOpenProviders, onOpenDevices }: Props = $props();

  type StepId =
    | 'welcome'
    | 'appearance'
    | 'style'
    | 'autonomy'
    | 'providers'
    | 'port-chats'
    | 'devices'
    | 'done';

  interface Step {
    id: StepId;
    label: string;
    icon: typeof Palette;
  }

  const steps: Step[] = [
    { id: 'welcome', label: 'Welcome', icon: Settings2 },
    { id: 'appearance', label: 'Appearance', icon: Palette },
    { id: 'style', label: 'Response style', icon: MessageSquareText },
    { id: 'autonomy', label: 'Autonomy', icon: ShieldCheck },
    { id: 'providers', label: 'Providers', icon: Plug },
    { id: 'port-chats', label: 'Port chats', icon: FolderGit2 },
    { id: 'devices', label: 'Link device', icon: MonitorSmartphone },
    { id: 'done', label: 'Ready', icon: Rocket },
  ];

  let index = $state(0);
  let direction = $state<1 | -1>(1);
  let dialog = $state<HTMLDivElement | null>(null);
  let accentPickerOpen = $state(false);
  let accentPickerTarget = $state<'primary' | 'secondary'>('primary');
  let accentPickerScheme = $state<ThemeScheme>('dark');
  let cliImportPanel = $state<CliChatImportPanel | null>(null);
  let portedChatsCount = $state(0);

  const step = $derived(steps[index]);
  const isFirst = $derived(index === 0);
  const isLast = $derived(index === steps.length - 1);
  const progress = $derived(((index + 1) / steps.length) * 100);

  // ── Option catalogs ───────────────────────────────────────────────────────

  const interviewOptions: Array<{
    value: AgentSettings['intentInterview'];
    label: string;
    description: string;
  }> = [
    {
      value: 'off',
      label: 'Just go',
      description: 'Kory makes reasonable assumptions and starts.',
    },
    {
      value: 'adaptive',
      label: 'Ask when unclear',
      description: 'A quick question only when the goal is ambiguous.',
    },
    {
      value: 'deep',
      label: 'Interview me',
      description: 'Kory pins down intent, constraints, and scope up front.',
    },
  ];

  const planOptions: Array<{
    value: AgentSettings['planApproval'];
    label: string;
    description: string;
  }> = [
    { value: 'never', label: 'Never pause', description: 'Plans execute without a review stop.' },
    {
      value: 'material',
      label: 'Material changes',
      description: 'Pause for approval only when a plan touches a lot.',
    },
    { value: 'always', label: 'Every plan', description: 'Approve each plan before work starts.' },
  ];

  const permissionOptions: Array<{
    value: AgentSettings['permissionMode'];
    label: string;
    tagline: string;
    description: string;
    recommended?: boolean;
  }> = [
    {
      value: 'guarded',
      label: 'Guarded',
      tagline: 'Recommended',
      description: 'Routine edits continue. Risky commands and destructive actions ask first.',
      recommended: true,
    },
    {
      value: 'ask',
      label: 'Ask',
      tagline: 'Careful',
      description: 'Approve file writes and shell commands before Kory runs them.',
    },
    {
      value: 'edits',
      label: 'Accept edits',
      tagline: 'Automatic edits',
      description: 'Apply file edits automatically. Ask before other actions.',
    },
    {
      value: 'yolo',
      label: 'YOLO',
      tagline: 'Fast',
      description: 'Routine prompts stay out of the way. Destructive commands still ask first.',
    },
  ];

  // ── Derived state from real stores ────────────────────────────────────────

  const settings = $derived(agentSettingsStore.settings);
  // Until the authoritative settings arrive, the cards would show (and merge
  // onto) DEFAULT_AGENT_SETTINGS. Hold the controls until the load completes.
  const settingsReady = $derived(
    agentSettingsStore.settingsLoaded && !agentSettingsStore.isLoading,
  );

  onMount(() => {
    if (!agentSettingsStore.settingsLoaded) void agentSettingsStore.loadSettings();
    if (providersStore.statusList.length === 0) void providersStore.loadProvidersFromApi();
    // Scanning every CLI's chat storage takes seconds; start it on the welcome
    // step so the Port chats step already has its list when the user reaches it.
    void cliChatImportStore.prefetch();
  });

  const connectedProviders = $derived(
    providersStore.statusList.filter(
      (provider) =>
        provider.connectionState === 'verified' || provider.connectionState === 'detected',
    ),
  );

  const summary = $derived.by(() => {
    const presetLabel = (id: string) =>
      theme.presets.find((entry) => entry.id === id)?.label ?? id;
    const modeLabel =
      theme.mode === 'system'
        ? 'Adaptive'
        : theme.mode === 'dark'
          ? 'Always dark'
          : 'Always light';
    const themeSummary =
      theme.mode === 'system'
        ? `${modeLabel} · ${presetLabel(theme.dark.preset)} / ${presetLabel(theme.light.preset)}`
        : theme.mode === 'dark'
          ? `${modeLabel} · ${presetLabel(theme.dark.preset)}`
          : `${modeLabel} · ${presetLabel(theme.light.preset)}`;
    const interview = interviewOptions.find((o) => o.value === settings.intentInterview)?.label;
    const plan = planOptions.find((o) => o.value === settings.planApproval)?.label;
    const permission = permissionOptions.find((o) => o.value === settings.permissionMode)?.label;
    return [
      {
        label: 'Theme',
        value: themeSummary,
      },
      { label: 'Response style', value: `${interview} · ${plan}` },
      {
        label: 'Autonomy',
        value: `${permission} · Critic ${resolveCriticMode(settings)}`,
      },
      {
        label: 'Providers',
        value:
          connectedProviders.length > 0
            ? `${connectedProviders.length} detected`
            : 'None yet. Connect from Settings',
      },
      {
        label: 'Ported chats',
        value:
          portedChatsCount > 0
            ? `${portedChatsCount} ${portedChatsCount === 1 ? 'chat' : 'chats'} imported`
            : 'None imported',
      },
    ];
  });

  // ── Actions ───────────────────────────────────────────────────────────────

  function go(next: number) {
    if (next < 0 || next >= steps.length || next === index) return;
    direction = next > index ? 1 : -1;
    index = next;
  }

  async function nextStep() {
    if (step.id === 'port-chats' && cliImportPanel) {
      await cliImportPanel.importSelectedIfPending();
    }
    if (isLast) finish();
    else go(index + 1);
  }

  function previousStep() {
    go(index - 1);
  }

  function finish() {
    onboardingStore.complete();
  }

  function skip() {
    onboardingStore.skip();
  }

  function applySetting<K extends keyof AgentSettings>(key: K, value: AgentSettings[K]) {
    if (!settingsReady) return;
    void agentSettingsStore.saveSettings({ [key]: value } as Partial<AgentSettings>, {
      quietSuccess: true,
    });
  }

  function connectProviders() {
    onOpenProviders();
  }

  function openAccentPicker(scheme: ThemeScheme, target: 'primary' | 'secondary') {
    accentPickerScheme = scheme;
    accentPickerTarget = target;
    accentPickerOpen = true;
  }

  function handleKeydown(event: KeyboardEvent) {
    const target = event.target as HTMLElement | null;
    const typing = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA';
    if (typing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      skip();
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      event.stopPropagation();
      void nextStep();
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      event.stopPropagation();
      previousStep();
    }
  }

  $effect(() => {
    // Keep keyboard focus inside the dialog so arrow keys / Escape work.
    dialog?.focus();
  });
</script>

{#if !suspended}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    class="walkthrough-backdrop fixed inset-0 z-[120] flex items-center justify-center p-4 sm:p-8"
    transition:fade={{ duration: 220 }}
    role="dialog"
    aria-modal="true"
    aria-labelledby="walkthrough-title"
    data-testid="onboarding-walkthrough"
    tabindex="-1"
    bind:this={dialog}
    onkeydown={handleKeydown}
  >
    <div
      class="walkthrough-card relative flex w-full max-w-4xl flex-col overflow-hidden rounded-[18px] border shadow-2xl sm:flex-row"
      style="background: var(--color-surface-1); border-color: var(--color-border); --setup-accent: #D5B261; --setup-accent-hover: #F3DDB0; --setup-on-accent: #17130c;"
      in:scale={{ start: 0.96, duration: 320, easing: cubicOut }}
    >
      <!-- Progress bar (top edge) -->
      <div class="absolute inset-x-0 top-0 h-[3px]" style="background: var(--color-surface-3);">
        <div
          class="walkthrough-progress h-full"
          style="width: {progress}%; background: var(--setup-accent);"
          aria-hidden="true"
        ></div>
      </div>

      <!-- Step rail -->
      <nav
        class="walkthrough-rail hidden w-56 shrink-0 flex-col gap-1 border-r px-4 pb-6 pt-8 sm:flex"
        style="border-color: var(--color-border); background: var(--color-surface-2);"
        aria-label="Walkthrough steps"
      >
        <div
          class="mb-4 flex items-center gap-2 px-2 text-[10px] font-semibold uppercase tracking-[0.16em]"
          style="color: var(--color-text-muted);"
        >
          <Settings2 size={11} /> Setup
        </div>
        {#each steps as entry, i (entry.id)}
          {@const Icon = entry.icon}
          {@const done = i < index}
          {@const active = i === index}
          <button
            type="button"
            class="rail-step flex items-center gap-2.5 border-l-2 px-2.5 py-2 text-left text-xs transition-colors"
            class:is-active={active}
            class:is-done={done}
            onclick={() => go(i)}
            aria-current={active ? 'step' : undefined}
          >
            <span class="rail-dot flex h-6 w-6 shrink-0 items-center justify-center">
              {#if done}<Check size={12} />{:else}<Icon size={12} />{/if}
            </span>
            <span class="truncate font-medium">{entry.label}</span>
          </button>
        {/each}
        <div
          class="mt-auto px-2 pt-6 text-[11px] leading-relaxed"
          style="color: var(--color-text-muted);"
        >
          ← → to move · Esc to skip
        </div>
      </nav>

      <!-- Slide area -->
      <div class="relative flex min-h-[520px] flex-1 flex-col">
        <!-- Top bar: mobile dots + skip -->
        <div class="flex items-center justify-between gap-3 px-6 pt-6 sm:px-8">
          <div class="flex items-center gap-1.5 sm:hidden" aria-hidden="true">
            {#each steps as entry, i (entry.id)}
              <span
                class="h-1.5 rounded-full transition-all duration-300"
                style="width: {i === index ? 18 : 6}px; background: {i <= index
                  ? 'var(--setup-accent)'
                  : 'var(--color-surface-4)'};"
              ></span>
            {/each}
          </div>
          <span class="hidden text-xs sm:block" style="color: var(--color-text-muted);">
            Step {index + 1} of {steps.length}
          </span>
          {#if !isLast}
            <button
              type="button"
              class="skip-button flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors"
              style="color: var(--color-text-muted);"
              onclick={skip}
            >
              <X size={13} />
              {isFirst ? 'Skip and use Koryphaios defaults' : 'Skip the rest'}
            </button>
          {/if}
        </div>

        <!-- Slides: stacked in one grid cell so in/out transitions overlap cleanly -->
        <div class="slide-stage flex-1 px-6 pb-4 pt-4 sm:px-8">
          {#key step.id}
            <section
              class="slide"
              in:fly={{ x: 48 * direction, duration: 340, easing: cubicOut }}
              out:fly={{ x: -32 * direction, duration: 180 }}
            >
              {#if step.id === 'welcome'}
                <div class="flex h-full flex-col items-center justify-center text-center">
                  <div class="welcome-logo mb-6">
                    <img src="/logo-64.png" alt="" class="h-16 w-16 rounded-2xl" />
                  </div>
                  <h2
                    id="walkthrough-title"
                    class="text-3xl font-semibold tracking-tight"
                    style="color: var(--color-text-primary);"
                  >
                    Welcome to Koryphaios
                  </h2>
                  <p
                    class="mt-3 max-w-md text-sm leading-relaxed"
                    style="color: var(--color-text-secondary);"
                  >
                    A local workspace that coordinates the AI agents and providers you already use.
                    Take one minute to make it yours, or start with the defaults.
                  </p>
                  <div class="welcome-actions mt-8 grid w-full max-w-xl grid-cols-5 text-left">
                    {#each steps.slice(1, 6) as entry, quickIndex (entry.id)}
                      {@const Icon = entry.icon}
                      <button
                        type="button"
                        class="welcome-action group flex min-w-0 items-center justify-center gap-2 px-2 py-3 text-[11px] font-medium"
                        style="color: var(--color-text-secondary);"
                        onclick={() => go(quickIndex + 1)}
                        aria-label={`Open ${entry.label} setup`}
                      >
                        <Icon size={13} class="shrink-0" />
                        <span class="truncate">{entry.label}</span>
                      </button>
                    {/each}
                  </div>
                </div>
              {:else if step.id === 'appearance'}
                <h2 id="walkthrough-title" class="slide-title">Make it look like yours</h2>
                <p class="slide-subtitle">
                  Changes apply instantly. You can revisit them in Settings, Appearance.
                </p>
                <div class="mt-5">
                  <ThemeModeEditor compact onChooseAccent={openAccentPicker} />
                </div>
              {:else if step.id === 'style'}
                <h2 id="walkthrough-title" class="slide-title">How should Kory work with you?</h2>
                <p class="slide-subtitle">
                  Tune how much Kory checks in before acting and how much of its thinking you see.
                </p>
                <div class="mt-6 space-y-7" class:is-loading={!settingsReady}>
                  <fieldset disabled={!settingsReady}>
                    <legend class="option-heading">Before starting a task</legend>
                    <div
                      class="option-row mt-2 grid grid-cols-3 border-y"
                      style="border-color: var(--color-border);"
                    >
                      {#each interviewOptions as option (option.value)}
                        {@const active = settings.intentInterview === option.value}
                        <button
                          type="button"
                          class="option-choice"
                          class:is-active={active}
                          onclick={() => applySetting('intentInterview', option.value)}
                          aria-pressed={active}
                        >
                          <span class="option-label">{option.label}</span>
                          <span class="option-description">{option.description}</span>
                        </button>
                      {/each}
                    </div>
                  </fieldset>
                  <fieldset disabled={!settingsReady}>
                    <legend class="option-heading">Plan approval</legend>
                    <div
                      class="option-row mt-2 grid grid-cols-3 border-y"
                      style="border-color: var(--color-border);"
                    >
                      {#each planOptions as option (option.value)}
                        {@const active = settings.planApproval === option.value}
                        <button
                          type="button"
                          class="option-choice"
                          class:is-active={active}
                          onclick={() => applySetting('planApproval', option.value)}
                          aria-pressed={active}
                        >
                          <span class="option-label">{option.label}</span>
                          <span class="option-description">{option.description}</span>
                        </button>
                      {/each}
                    </div>
                  </fieldset>
                  <div
                    class="preference-row border-t pt-2"
                    style="border-color: var(--color-border);"
                  >
                    <SettingsSwitch
                      flat
                      checked={settings.reasoningExpandedByDefault}
                      label="Show reasoning expanded"
                      description="Open Kory's thinking blocks by default instead of collapsed."
                      disabled={!settingsReady}
                      onchange={() =>
                        applySetting(
                          'reasoningExpandedByDefault',
                          !settings.reasoningExpandedByDefault,
                        )}
                    />
                  </div>
                </div>
              {:else if step.id === 'autonomy'}
                <h2 id="walkthrough-title" class="slide-title">
                  How much should Kory do on its own?
                </h2>
                <p class="slide-subtitle">
                  This is the default approval mode for new chats. You can change it per chat from
                  the composer at any time.
                </p>
                <fieldset
                  class="permission-row mt-6 grid grid-cols-2 gap-2"
                  disabled={!settingsReady}
                >
                  {#each permissionOptions as option (option.value)}
                    {@const active = settings.permissionMode === option.value}
                    <button
                      type="button"
                      class="option-choice permission-choice"
                      class:is-active={active}
                      onclick={() => applySetting('permissionMode', option.value)}
                      aria-pressed={active}
                    >
                      <span class="flex items-baseline justify-between gap-2">
                        <span class="option-label text-sm">{option.label}</span>
                        <span
                          class="text-[10px] font-semibold uppercase tracking-[0.08em]"
                          style="color: {option.recommended
                            ? 'var(--setup-accent)'
                            : 'var(--color-text-muted)'};">{option.tagline}</span
                        >
                      </span>
                      <span class="option-description">{option.description}</span>
                    </button>
                  {/each}
                </fieldset>
                <div class="preference-row mt-7">
                  <CriticModeSelect flat value={resolveCriticMode(settings)} disabled={!settingsReady}
                    onchange={(mode) => applySetting('criticMode', mode)} />
                  <p class="option-description mt-1.5">An independent reviewer checks Kory's work before it reaches you.</p>
                </div>
              {:else if step.id === 'providers'}
                <h2 id="walkthrough-title" class="slide-title">
                  Connect the models you already use
                </h2>
                <p class="slide-subtitle">
                  Koryphaios itself is free. Bring your own API keys or coding CLI subscriptions.
                  Anthropic, OpenAI, Gemini, OpenRouter, local endpoints, and more are supported.
                </p>
                <div
                  class="mt-6 flex items-center gap-4 border-y py-4"
                  style="border-color: var(--color-border);"
                >
                  <span
                    class="flex h-10 w-10 shrink-0 items-center justify-center"
                    style="color: var(--color-accent);"
                  >
                    <Plug size={20} />
                  </span>
                  <div class="min-w-0 flex-1">
                    <div class="text-sm font-semibold" style="color: var(--color-text-primary);">
                      {#if connectedProviders.length > 0}
                        {connectedProviders.length}
                        {connectedProviders.length === 1 ? 'provider' : 'providers'} detected on this
                        machine
                      {:else}
                        No providers connected yet
                      {/if}
                    </div>
                    <p
                      class="mt-0.5 text-xs leading-relaxed"
                      style="color: var(--color-text-muted);"
                    >
                      {#if connectedProviders.length > 0}
                        {connectedProviders.map((p) => p.name).join(', ')}. Detection isn't proof of
                        access. Verify them in Settings before unattended work.
                      {:else}
                        You'll need at least one before Kory can respond. Keys are stored locally
                        with permissions restricted to your account.
                      {/if}
                    </p>
                  </div>
                </div>
                <div class="mt-4 flex flex-wrap gap-2">
                  <button type="button" class="btn setup-primary" onclick={connectProviders}>
                    <Plug size={14} /> Connect a provider now
                  </button>
                  <button type="button" class="btn" onclick={() => void nextStep()}>I'll do it later</button>
                </div>
              {:else if step.id === 'port-chats'}
                <h2 id="walkthrough-title" class="slide-title">
                  Port existing chats from your projects
                </h2>
                <p class="slide-subtitle">
                  Koryphaios checks all CLI providers on disk. Expand a project to cherry-pick
                  individual chats or mix providers into your Koryphaios workspace.
                </p>
                <div class="mt-4">
                  <CliChatImportPanel
                    bind:this={cliImportPanel}
                    onImportedChange={(count) => {
                      portedChatsCount = count;
                    }}
                  />
                </div>
              {:else if step.id === 'devices'}
                <h2 id="walkthrough-title" class="slide-title">Take Koryphaios with you</h2>
                <p class="slide-subtitle">
                  One last optional step: link your phone, tablet, or another desktop. You can
                  always do this later in Settings → Link device.
                </p>
                <div class="mt-6 grid gap-4">
                  <div class="device-option">
                    <Smartphone size={22} />
                    <div>
                      <h3>Phone or tablet</h3>
                      <p>
                        Scan your desktop’s QR code or enter its pairing code to steer your linked
                        desktops.
                      </p>
                    </div>
                  </div>
                  <div class="device-option">
                    <Monitor size={22} />
                    <div>
                      <h3>Another desktop</h3>
                      <p>
                        Pair with a code, then use the big + to choose a desktop and workspace for
                        each new chat.
                      </p>
                    </div>
                  </div>
                </div>
                <p class="device-note mt-5">
                  Compare the numbers on both screens before linking. After approval, access across
                  activated devices is on by default, while agent delegation stays off until you
                  enable each direction. Each desktop keeps its own files and permissions.
                </p>
                <div class="mt-5 flex flex-wrap gap-2">
                  <button type="button" class="btn" onclick={onOpenDevices}
                    ><MonitorSmartphone size={16} /> Link a device now</button
                  >
                </div>
              {:else}
                <div class="flex h-full flex-col items-center justify-center text-center">
                  <div
                    class="done-badge mb-5 flex h-14 w-14 items-center justify-center"
                    style="color: var(--color-accent);"
                  >
                    <Rocket size={28} />
                  </div>
                  <h2 id="walkthrough-title" class="slide-title">You're set</h2>
                  <p class="slide-subtitle mx-auto max-w-md">
                    Open a folder or workspace and give Kory something to do. Everything below can
                    be changed later in Settings.
                  </p>
                  <dl
                    class="mt-6 w-full max-w-md border-y text-left"
                    style="border-color: var(--color-border);"
                  >
                    {#each summary as row, i (row.label)}
                      <div
                        class="summary-row flex items-center justify-between gap-4 border-b px-1 py-3 last:border-b-0"
                        style="border-color: var(--color-border); animation-delay: {i * 60}ms;"
                      >
                        <dt class="text-xs" style="color: var(--color-text-muted);">{row.label}</dt>
                        <dd
                          class="truncate text-xs font-medium"
                          style="color: var(--color-text-primary);"
                        >
                          {row.value}
                        </dd>
                      </div>
                    {/each}
                  </dl>
                </div>
              {/if}
            </section>
          {/key}
        </div>

        <!-- Footer nav -->
        <div
          class="flex items-center justify-between gap-3 border-t px-6 py-4 sm:px-8"
          style="border-color: var(--color-border);"
        >
          <button
            type="button"
            class="btn"
            onclick={previousStep}
            disabled={isFirst}
            aria-label="Previous step"
          >
            <ArrowLeft size={14} /> Back
          </button>
          <button type="button" class="btn setup-primary" onclick={() => void nextStep()} data-primary>
            {#if isFirst}
              Set up in a minute <ArrowRight size={14} />
            {:else if isLast}
              <Rocket size={14} /> Start using Koryphaios
            {:else}
              Continue <ArrowRight size={14} />
            {/if}
          </button>
        </div>
      </div>
    </div>
  </div>

  <ColorPickerModal
    open={accentPickerOpen}
    target={accentPickerTarget}
    scheme={accentPickerScheme}
    onClose={() => {
      accentPickerOpen = false;
    }}
  />
{/if}

<style>
  .walkthrough-backdrop {
    background: color-mix(in srgb, var(--color-surface-0, #000) 84%, transparent);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    outline: none;
  }

  .walkthrough-card {
    box-shadow: 0 28px 80px -42px rgba(0, 0, 0, 0.82);
    max-height: calc(100dvh - 32px);
  }

  .walkthrough-progress {
    transition: width 420ms cubic-bezier(0.2, 0.8, 0.2, 1);
  }

  .rail-step {
    border-left-color: transparent;
    color: var(--color-text-muted);
  }
  .rail-step:hover {
    color: var(--color-text-secondary);
  }
  .rail-dot {
    color: var(--color-text-muted);
    transition: color 160ms;
  }
  .rail-step.is-active {
    border-left-color: var(--setup-accent);
    color: var(--color-text-primary);
  }
  .rail-step.is-active .rail-dot {
    color: var(--setup-accent);
  }
  .rail-step.is-done .rail-dot {
    color: var(--color-text-secondary);
  }

  .skip-button:hover {
    background: var(--color-surface-2);
    color: var(--color-text-secondary);
  }

  /* One grid cell so the outgoing and incoming slides overlap during transition. */
  .slide-stage {
    display: grid;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
  }
  .slide {
    grid-area: 1 / 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  .slide-title {
    font-size: 1.5rem;
    line-height: 1.2;
    font-weight: 600;
    letter-spacing: -0.01em;
    color: var(--color-text-primary);
  }
  .slide-subtitle {
    margin-top: 0.5rem;
    font-size: 0.875rem;
    line-height: 1.6;
    color: var(--color-text-secondary);
  }
  .device-option {
    display: flex;
    align-items: flex-start;
    gap: 14px;
    padding: 18px;
    border: 1px solid var(--color-border);
    border-radius: 12px;
    background: var(--color-surface-2);
  }
  .device-option > :global(svg) {
    flex-shrink: 0;
    color: var(--color-accent);
  }
  .device-option h3 {
    font-size: 13px;
    font-weight: 600;
    color: var(--color-text-primary);
  }
  .device-option p,
  .device-note {
    font-size: 12px;
    line-height: 1.6;
    color: var(--color-text-muted);
  }
  .device-option p {
    margin-top: 6px;
  }

  .welcome-actions {
    border-top: 1px solid var(--color-border);
    border-bottom: 1px solid var(--color-border);
  }
  .welcome-action {
    border-right: 1px solid var(--color-border);
    transition:
      background 150ms,
      color 150ms;
  }
  .welcome-action:last-child {
    border-right: 0;
  }
  .welcome-action:hover,
  .welcome-action:focus-visible {
    background: color-mix(in srgb, var(--color-surface-3) 58%, transparent);
    color: var(--color-text-primary) !important;
    outline: none;
  }
  .welcome-action:hover :global(svg),
  .welcome-action:focus-visible :global(svg) {
    color: var(--setup-accent);
  }

  .option-heading {
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--color-text-secondary);
  }

  .option-choice {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    text-align: left;
    min-width: 0;
    padding: 0.9rem 1rem;
    box-shadow: inset 0 -2px 0 transparent;
    transition:
      background 160ms,
      box-shadow 160ms;
  }
  .option-choice + .option-choice {
    border-left: 1px solid var(--color-border);
  }
  .option-choice:hover,
  .option-choice:focus-visible {
    background: color-mix(in srgb, var(--color-surface-3) 58%, transparent);
    outline: none;
  }
  .option-choice.is-active {
    background: color-mix(in srgb, var(--setup-accent) 6%, transparent);
    box-shadow: inset 0 -2px 0 var(--setup-accent);
  }
  .option-choice.is-active .option-label {
    color: var(--setup-accent);
  }
  .permission-choice {
    min-height: 6.5rem;
    padding: 1rem 1.1rem;
    border-radius: 0.75rem;
    background: color-mix(in srgb, var(--color-surface-2) 72%, transparent);
  }
  .permission-row .option-choice + .option-choice {
    border-left: 0;
  }
  .permission-row .option-choice.is-active {
    background: color-mix(in srgb, var(--setup-accent) 8%, var(--color-surface-2));
  }
  .option-label {
    display: block;
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--color-text-primary);
  }
  .option-description {
    display: block;
    font-size: 0.6875rem;
    line-height: 1.5;
    color: var(--color-text-muted);
  }

  fieldset {
    border: 0;
    padding: 0;
    margin: 0;
    min-width: 0;
  }
  fieldset:disabled .option-choice {
    opacity: 0.55;
    cursor: progress;
  }

  :global(.walkthrough-card .setup-primary) {
    background: var(--setup-accent) !important;
    color: var(--setup-on-accent) !important;
    border-color: var(--setup-accent) !important;
    box-shadow: 0 8px 24px rgba(213, 178, 97, 0.16);
  }
  :global(.walkthrough-card .setup-primary:hover:not(:disabled)) {
    background: var(--setup-accent-hover) !important;
  }

  @media (prefers-reduced-motion: reduce) {
    .walkthrough-progress {
      transition: none;
    }
  }
</style>
