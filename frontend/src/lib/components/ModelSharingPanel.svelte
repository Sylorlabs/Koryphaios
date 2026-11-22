<script lang="ts">
  import { apiFetch, parseJsonResponse } from '$lib/api.svelte';
  import { apiUrl } from '$lib/utils/api-url';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { loadProvidersFromApi } from '$lib/stores/providers.svelte';
  import { copyText } from '$lib/utils/clipboard';
  import Share2 from 'lucide-svelte/icons/share-2';
  import ShieldAlert from 'lucide-svelte/icons/shield-alert';
  import ShieldCheck from 'lucide-svelte/icons/shield-check';
  import ShieldX from 'lucide-svelte/icons/shield-x';
  import Loader2 from 'lucide-svelte/icons/loader-2';
  import Link2 from 'lucide-svelte/icons/link-2';
  import HardDrive from 'lucide-svelte/icons/hard-drive';
  import Lock from 'lucide-svelte/icons/lock';
  import Search from 'lucide-svelte/icons/search';
  import SlidersHorizontal from 'lucide-svelte/icons/sliders-horizontal';
  import {
    SANDBOX_PRESETS,
    type ProviderShareRisk,
    type SandboxPolicy,
    type SandboxPreset,
  } from '@koryphaios/shared';
  import SettingsSwitch from './SettingsSwitch.svelte';
  import SettingsToggle from './SettingsToggle.svelte';
  import ModelSelectionDialog from './ModelSelectionDialog.svelte';
  import ProviderIcon from './icons/ProviderIcon.svelte';
  let { hostName = 'Host' }: { hostName?: string } = $props();

  interface ShareCandidate {
    provider: string;
    label: string;
    modelCount: number;
    available: boolean;
    sharingBlockedReason?: string;
    agentic: boolean;
    risk: ProviderShareRisk;
    reason: string;
    models: Array<{ id: string; name: string }>;
  }

  let candidates = $state<ShareCandidate[]>([]);
  let sharedSet = $state<Set<string>>(new Set());
  let sharedModels = $state<Record<string, string[]>>({});
  let configuringProvider = $state<ShareCandidate | null>(null);
  let loadingHost = $state(false);
  let savingHost = $state(false);
  let providerSearch = $state('');
  let modelSharing = $state(false);
  let sharingBusy = $state(false);
  let sharingError = $state<string | null>(null);
  let modelInviteUrl = $state<string | null>(null);
  let modelCode = $state<string | null>(null);
  let modelHostName = $state('');
  let publishedHostName = $state<string | null>(null);
  let hostNameEdited = $state(false);
  let sharingRestored = $state(false);
  let connectError = $state<string | null>(null);
  $effect(() => {
    if (!hostNameEdited && !sharingRestored) modelHostName = hostName;
  });

  let joinCode = $state('');
  let connecting = $state(false);
  let remote = $state<{ connected: boolean; hostName: string | null; catalog: any } | null>(null);

  // Sandbox policy for remote CLI turns.
  let sandbox = $state<SandboxPolicy | null>(null);
  let sandboxCaps = $state<{ osIsolation: boolean; mechanism: string; platform: string } | null>(
    null,
  );
  let savingSandbox = $state(false);
  const sharingAnyCli = $derived(candidates.some((c) => c.agentic && c.available && sharedSet.has(c.provider)));
  const shareableSelection = $derived(candidates.some((c) => c.available && sharedSet.has(c.provider) && modelsFor(c).length > 0));


  const riskMeta: Record<ProviderShareRisk, { icon: any; color: string; label: string }> = {
    ok: { icon: ShieldCheck, color: 'var(--color-success)', label: 'Safe to share' },
    caution: { icon: ShieldAlert, color: 'var(--color-warning)', label: 'May violate ToS' },
    prohibited: { icon: ShieldX, color: 'var(--color-error)', label: 'Violates ToS' },
  };

  async function loadHost() {
    loadingHost = true;
    try {
      const res = await apiFetch(apiUrl('/api/collab/providers/shared'));
      const data = await parseJsonResponse<{
        ok?: boolean;
        data?: {
          shared: string[];
          sharedModels?: Record<string, string[]>;
          candidates: ShareCandidate[];
        };
      }>(res);
      if (data.ok && data.data) {
        candidates = data.data.candidates.map((candidate) => ({
          ...candidate,
          models: candidate.models ?? [],
        }));
        sharedSet = new Set(data.data.shared);
        // The candidate list already carries the models this user enabled for
        // themselves, and `modelsFor()` falls back to it, so an untouched
        // provider starts in sync with their own picker. Only an explicit
        // Configure/enable choice is recorded in `sharedModels`; after that the
        // saved selection is used as-is and never re-synced from the user's own
        // model list.
        sharedModels = data.data.sharedModels ?? {};
      }
    } catch (err: unknown) {
      console.warn(
        'Failed to load shared providers:',
        err instanceof Error ? err.message : String(err),
      );
      /* backend offline — panel stays empty */
    } finally {
      loadingHost = false;
    }
  }

  async function loadRemote() {
    try {
      const res = await apiFetch(apiUrl('/api/collab/providers/remote-status'));
      const data = await parseJsonResponse<{ ok?: boolean; data?: typeof remote }>(res);
      if (data.ok) remote = data.data ?? null;
    } catch (err: unknown) {
      console.warn(
        'Failed to load remote provider status:',
        err instanceof Error ? err.message : String(err),
      );
      /* ignore */
    }
  }

  async function loadSharing() {
    try {
      const res = await apiFetch(apiUrl('/api/collab/providers/sharing'));
      const data = await parseJsonResponse<{ ok?: boolean; data?: { active: boolean; joinCode?: string | null; hostName?: string | null } }>(res);
      if (data.ok) {
        modelSharing = data.data?.active === true;
        modelCode = modelSharing ? data.data?.joinCode ?? null : null;
        publishedHostName = modelSharing ? data.data?.hostName ?? null : null;
        if (!hostNameEdited && publishedHostName) modelHostName = publishedHostName;
        sharingRestored = true;
      }
    } catch {
      // The explicit action below reports service failures.
    }
  }

  async function shareModels() {
    sharingBusy = true;
    sharingError = null;
    try {
      if (!await saveHost(true)) return;
      const res = await apiFetch(apiUrl('/api/collab/providers/sharing/start'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hostName: modelHostName.trim() }),
      });
      const data = await parseJsonResponse<{ ok?: boolean; error?: string; data?: { inviteUrl: string; joinCode: string; hostName: string } }>(res);
      if (!res.ok || !data.ok || !data.data?.joinCode) {
        sharingError = data.error || 'Could not start model sharing. Check the relay connection.';
        return;
      }
      modelSharing = true;
      modelInviteUrl = data.data.inviteUrl;
      modelCode = data.data.joinCode;
      publishedHostName = data.data.hostName;
      modelHostName = data.data.hostName;
      try {
        await copyText(modelCode);
        toastStore.success(`${publishedHostName}'s model-sharing code copied`);
      } catch {
        toastStore.info('Model sharing is active. Copy the code shown below.');
      }
    } catch {
      sharingError = 'Could not share models. Check the connection and try again.';
    } finally {
      sharingBusy = false;
    }
  }

  async function stopSharingModels() {
    sharingBusy = true;
    sharingError = null;
    try {
      const res = await apiFetch(apiUrl('/api/collab/providers/sharing/stop'), { method: 'POST' });
      if (!res.ok) throw new Error();
      modelSharing = false;
      modelInviteUrl = null;
      modelCode = null;
      publishedHostName = null;
      toastStore.info('Model sharing stopped');
    } catch {
      sharingError = 'Could not stop model sharing. Try again.';
    } finally {
      sharingBusy = false;
    }
  }

  async function loadSandbox() {
    try {
      const res = await apiFetch(apiUrl('/api/collab/providers/sandbox'));
      const data = await parseJsonResponse<{
        ok?: boolean;
        data?: { policy: SandboxPolicy; capabilities: typeof sandboxCaps };
      }>(res);
      if (data.ok && data.data) {
        sandbox = data.data.policy;
        sandboxCaps = data.data.capabilities;
      }
    } catch (err: unknown) {
      console.warn(
        'Failed to load sandbox policy:',
        err instanceof Error ? err.message : String(err),
      );
      /* ignore */
    }
  }

  function applyPreset(preset: Exclude<SandboxPreset, 'custom'>) {
    sandbox = { ...SANDBOX_PRESETS[preset] };
    void saveSandbox();
  }

  function setSandbox<K extends keyof SandboxPolicy>(key: K, value: SandboxPolicy[K]) {
    if (!sandbox) return;
    sandbox = { ...sandbox, [key]: value, preset: 'custom' };
    void saveSandbox();
  }

  async function saveSandbox() {
    if (!sandbox) return;
    savingSandbox = true;
    try {
      await apiFetch(apiUrl('/api/collab/providers/sandbox'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ policy: sandbox }),
      });
    } catch (err: unknown) {
      console.warn(
        'Failed to save sandbox policy:',
        err instanceof Error ? err.message : String(err),
      );
      toastStore.error('Could not save sandbox policy');
    } finally {
      savingSandbox = false;
    }
  }

  $effect(() => {
    void loadHost();
    void loadRemote();
    void loadSandbox();
    void loadSharing();
  });

  const SANDBOX_TOGGLES: Array<{
    key: keyof SandboxPolicy;
    label: string;
    hint: string;
  }> = [
    {
      key: 'filesystemIsolation',
      label: 'Filesystem jail',
      hint: 'CLI can only touch the shared project. It cannot reach your home, keys, or other files.',
    },
    {
      key: 'allowNetwork',
      label: 'Network access',
      hint: 'Let the CLI reach the internet (package installs, API calls).',
    },
    {
      key: 'allowWebSearch',
      label: 'Web search',
      hint: "The CLI's own web search / fetch tools.",
    },
    {
      key: 'allowEdits',
      label: 'Edit files',
      hint: 'CLI may write files (edits go back to the guest, not you).',
    },
    {
      key: 'allowShell',
      label: 'Run shell commands',
      hint: 'CLI may run commands on YOUR machine inside the jail.',
    },
  ];

  const PRESET_META: Array<{ id: Exclude<SandboxPreset, 'custom'>; label: string; hint: string }> =
    [
      {
        id: 'balanced',
        label: 'Balanced',
        hint: 'Jailed, but network + web + shell + edits on. Recommended.',
      },
      { id: 'hardened', label: 'Hardened', hint: 'No network, no shell. Read + edit only.' },
      { id: 'readonly', label: 'Read only', hint: 'Analysis only. No edits, shell, or network.' },
      { id: 'trusted', label: 'Trusted', hint: 'No jail, everything on. Full trust only.' },
    ];

  function toggleShare(c: ShareCandidate) {
    const enabling = !sharedSet.has(c.provider);
    if (enabling && c.risk === 'prohibited') {
      toastStore.warning(
        `${c.label} violates the provider's Terms of Service. Sharing is at your own risk.`,
      );
    } else if (enabling && c.risk === 'caution') {
      toastStore.warning(
        `Sharing ${c.label} may violate the provider's terms. Use at your own risk.`,
      );
    }
    const next = new Set(sharedSet);
    if (next.has(c.provider)) next.delete(c.provider);
    else {
      next.add(c.provider);
      if (!sharedModels[c.provider])
        sharedModels = { ...sharedModels, [c.provider]: c.models.map((model) => model.id) };
    }
    sharedSet = next;
  }

  function modelsFor(candidate: ShareCandidate): string[] {
    return sharedModels[candidate.provider] ?? candidate.models.map((model) => model.id);
  }

  async function saveHost(quiet = false): Promise<boolean> {
    savingHost = true;
    try {
      const res = await apiFetch(apiUrl('/api/collab/providers/shared'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providers: [...sharedSet], models: sharedModels }),
      });
      if (res.ok) {
        if (!quiet) toastStore.success('Shared providers updated');
        return true;
      }
      toastStore.error('Could not update shared providers');
      return false;
    } catch (err: unknown) {
      console.warn(
        'Failed to save shared providers:',
        err instanceof Error ? err.message : String(err),
      );
      toastStore.error('Could not update shared providers');
      return false;
    } finally {
      savingHost = false;
    }
  }

  async function connect() {
    const code = joinCode.trim();
    if (!code) return;
    connecting = true;
    connectError = null;
    try {
      const res = await apiFetch(apiUrl('/api/collab/providers/connect'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ joinCode: code }),
      });
      const data = await parseJsonResponse<{
        ok?: boolean;
        error?: string;
        data?: { hostName: string | null };
      }>(res);
      if (data.ok) {
        toastStore.success(
          `Connected to ${data.data?.hostName ?? 'host'}. Their models are now in your picker`,
        );
        joinCode = '';
        await loadRemote();
        await loadProvidersFromApi();
      } else {
        connectError = data.error || 'Could not connect to host';
      }
    } catch (err: unknown) {
      connectError = 'Could not connect to the shared-model host. Check the code and your connection.';
    } finally {
      connecting = false;
    }
  }

  async function disconnect() {
    try {
      await apiFetch(apiUrl('/api/collab/providers/disconnect'), { method: 'POST' });
      remote = null;
      await loadRemote();
      await loadProvidersFromApi();
      toastStore.info('Disconnected from host');
    } catch (err: unknown) {
      console.warn(
        'Failed to disconnect from host:',
        err instanceof Error ? err.message : String(err),
      );
      toastStore.error('Could not disconnect');
    }
  }

  const anyRisky = $derived(candidates.some((c) => sharedSet.has(c.provider) && c.risk !== 'ok'));
  const filteredCandidates = $derived.by(() => {
    const query = providerSearch.trim().toLowerCase();
    return candidates
      .filter(
        (candidate) =>
          !query ||
          candidate.label.toLowerCase().includes(query) ||
          candidate.provider.toLowerCase().includes(query),
      )
      .sort(
        (left, right) =>
          Number(right.available) - Number(left.available) || left.label.localeCompare(right.label),
      );
  });

  function candidateDescription(candidate: ShareCandidate): string {
    if (candidate.sharingBlockedReason) return candidate.sharingBlockedReason;
    if (!candidate.available)
      return 'Not connected. Configure this provider in Providers before sharing it.';
    const modelText = `${candidate.modelCount} model${candidate.modelCount === 1 ? '' : 's'}`;
    return candidate.agentic
      ? `${modelText} · CLI runs in a temporary sandbox on this computer.`
      : `${modelText} · ${candidate.reason}`;
  }

  const remoteApiCount = $derived(
    remote?.catalog?.providers?.filter((p: any) => !p.agentic).length ?? 0,
  );
  const remoteCliCount = $derived(
    remote?.catalog?.providers?.filter((p: any) => p.agentic).length ?? 0,
  );
</script>

<div class="space-y-6">
  <div>
    <h3 class="text-sm font-semibold text-[var(--color-text-primary)]">Models you share</h3>
    <p class="mt-1 max-w-2xl text-xs leading-5 text-[var(--color-text-muted)]">
      Lend providers for inference without sharing your workspace or files. Only the model call
      travels.
    </p>
  </div>

  <!-- ── HOST: share my providers ── -->
  <section class="space-y-4">
    <div>
      <h4 class="text-[13px] font-semibold text-[var(--color-text-primary)]">Share my models</h4>
      <p class="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">
        Share selected inference models using a code. Host commands, files, native agents and login credentials are outside the code's permissions.
      </p>
    </div>
    <div class="max-w-md">
      <label class="block text-xs font-medium text-[var(--color-text-secondary)]">
        Host name
        <input bind:value={modelHostName} maxlength="80" placeholder="e.g. Micah"
          oninput={() => { hostNameEdited = true; sharingError = null; }}
          class="mt-1.5 min-h-10 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-1)] px-3 py-2 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]" />
      </label>
      <p class="mt-1 text-[11px] text-[var(--color-text-muted)]">Shown beside your models in the recipient's picker.</p>
    </div>

    {#if loadingHost}
      <div class="mt-6 flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
        <Loader2 size={14} class="animate-spin" /> Loading providers…
      </div>
    {:else if candidates.length === 0}
      <p class="mt-6 text-xs text-[var(--color-text-muted)]">
        Connect a provider first. Authenticated providers appear here to share.
      </p>
    {:else}
      <div
        class="flex min-h-10 items-center gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-1)] px-3 py-2"
      >
        <Search size={14} class="shrink-0 text-[var(--color-text-muted)]" />
        <input
          bind:value={providerSearch}
          type="search"
          placeholder="Search all providers…"
          class="min-w-0 flex-1 bg-transparent text-xs text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-muted)]"
          aria-label="Search providers to share"
        />
        <span class="text-[11px] text-[var(--color-text-muted)]"
          >{filteredCandidates.length}/{candidates.length}</span
        >
      </div>
      <div class="max-h-[32rem] overflow-y-auto">
        {#each filteredCandidates as c (c.provider)}
          {@const meta = riskMeta[c.risk]}
          {@const on = sharedSet.has(c.provider)}
          <div class="provider-share-row flex items-start gap-3 rounded-md px-3 py-3 transition-colors hover:bg-[var(--color-surface-2)]">
            <div class="mt-0.5 shrink-0"><ProviderIcon provider={c.provider} size={20} /></div>
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
                <h5 class="text-sm font-medium text-[var(--color-text-primary)]">{c.label}</h5>
                <span class="inline-flex items-center gap-1 text-[11px] text-[var(--color-text-muted)]" title={c.reason}><meta.icon size={11} /> {meta.label}</span>
                {#if c.agentic}<span class="inline-flex items-center gap-1 text-[11px] text-[var(--color-text-muted)]"><HardDrive size={11} /> CLI</span>{/if}
              </div>
              <p class="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">{candidateDescription(c)}</p>
              {#if c.available && c.models.length > 0}
                <div class="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                <button
                  type="button"
                  onclick={() => (configuringProvider = c)}
                  class="inline-flex min-h-8 items-center gap-1.5 rounded-md border border-transparent px-2 text-xs font-medium text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-border-bright)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
                  aria-label={`Configure models for ${c.label}`}
                  aria-haspopup="dialog"
                >
                  <SlidersHorizontal size={13} /> Configure models
                </button>
                <span class="text-[11px] text-[var(--color-text-muted)]">{modelsFor(c).length} of {c.models.length} selected</span>
                </div>
              {/if}
            </div>
            <div class="mt-0.5 shrink-0">
              <SettingsToggle
                checked={on}
                disabled={!c.available && !on}
                label={`Share ${c.label}`}
                onchange={() => toggleShare(c)}
              />
            </div>
          </div>
        {/each}
        {#if filteredCandidates.length === 0}<p
            class="px-3 py-5 text-center text-xs text-[var(--color-text-muted)]"
          >
            No providers match “{providerSearch}”.
          </p>{/if}
      </div>

      {#if anyRisky}
        <div
          class="mt-6 rounded-2xl border p-4 text-[11px] leading-relaxed"
          style="border-color: color-mix(in srgb, var(--color-warning) 40%, transparent); background: color-mix(in srgb, var(--color-warning) 8%, transparent); color: var(--color-text-secondary);"
        >
          <strong style="color: var(--color-warning);">Heads up:</strong> you've selected subscription-backed
          providers. Lending a subscription to another person is account-sharing that several
          providers' terms forbid and actively enforce (bans). Your own
          <em>API keys</em> are the safe way to share. Enable these only if you accept the risk.
        </div>
      {/if}

    {/if}
      <div
        class="mt-6 flex flex-wrap items-start justify-between gap-3 border-t border-[var(--color-border)] pt-4"
      >
        <div class="min-w-0 basis-64 flex-1">
          <p class="text-xs font-medium text-[var(--color-text-primary)]">{modelSharing ? 'Model sharing is active' : 'Share models independently'}</p>
          <p class="mt-1 text-[11px] leading-5 text-[var(--color-text-muted)]">Guests use selected models in their own workspace. Login tokens and API keys stay on your computer.</p>
        </div>
        <div class="flex max-w-full flex-wrap items-center gap-2">
          <button
          type="button"
          onclick={() => saveHost()}
          disabled={savingHost || sharingBusy}
          class="btn btn-secondary px-3 py-2 text-xs"
        >
          {savingHost ? 'Saving…' : 'Save shared providers'}
          </button>
          <button type="button" onclick={shareModels}
            disabled={sharingBusy || savingHost || !shareableSelection || !modelHostName.trim()}
            class="btn btn-primary inline-flex items-center gap-2 px-4 py-2 text-xs">
            <Share2 size={14} /> {sharingBusy ? 'Sharing…' : modelSharing ? 'Update sharing' : 'Share models'}
          </button>
          {#if modelSharing}
            <button type="button" onclick={stopSharingModels} disabled={sharingBusy}
              class="rounded-md border border-transparent px-3 py-2 text-xs text-[var(--color-error)] hover:border-[var(--color-border-bright)]">Stop sharing</button>
          {/if}
        </div>
      </div>
      {#if sharingError}<p role="alert" class="text-xs text-[var(--color-error)]">{sharingError}</p>{/if}
      {#if modelSharing && modelCode}
        <div class="border-t border-[var(--color-border)] pt-4">
          <h5 class="text-xs font-semibold text-[var(--color-text-primary)]">{publishedHostName || 'Host'}'s model-sharing code</h5>
          <div class="mt-2 flex flex-wrap items-center gap-2">
            <input readonly value={modelCode} aria-label="Model-sharing code"
              class="min-h-10 w-40 rounded-lg border border-[var(--color-border-bright)] bg-[var(--color-surface-1)] px-3 py-2 text-center font-mono text-base font-semibold tracking-[0.15em] text-[var(--color-text-primary)] outline-none" />
            <button type="button" onclick={() => copyText(modelCode!)}
              class="btn btn-secondary inline-flex items-center gap-2 px-3 py-2 text-xs"><Link2 size={13} /> Copy code</button>
            {#if modelInviteUrl}<button type="button" onclick={() => copyText(modelInviteUrl!)}
              class="rounded-md border border-transparent px-3 py-2 text-xs text-[var(--color-text-secondary)] hover:border-[var(--color-border-bright)]">Copy invite link</button>{/if}
          </div>
          <p class="mt-2 text-[11px] leading-5 text-[var(--color-text-muted)]">Recipients enter this code under “Use someone's models”. Anyone with the code can use your selected models. Stop sharing revokes it.</p>
        </div>
      {/if}

      {#if sharingAnyCli && sandbox}
        <!-- Sandbox policy — how the shared CLI runs on YOUR machine. -->
        <div class="mt-7 border-t border-[var(--color-border)] pt-7">
          <div class="mb-2 flex items-center gap-2">
            <Lock size={16} class="text-[var(--color-text-muted)]" />
            <span class="text-[13px] font-semibold text-[var(--color-text-primary)]">CLI sandbox</span>
            {#if savingSandbox}<Loader2
                size={11}
                class="animate-spin text-[var(--color-text-muted)]"
              />{/if}
          </div>
          <p class="mb-4 text-[11px] leading-5 text-[var(--color-text-muted)]">
            You're sharing a CLI model, which runs on your PC. Choose how it's confined.
          </p>

          <!-- OS-level enforcement indicator (mechanism-aware) -->
          {#if sandboxCaps}
            <div
              class="mb-4 rounded-xl px-4 py-3 text-[11px] leading-relaxed"
              style="background: {sandboxCaps.osIsolation
                ? 'color-mix(in srgb, var(--color-success) 10%, transparent)'
                : 'color-mix(in srgb, var(--color-warning) 10%, transparent)'};"
            >
              {#if sandboxCaps.mechanism === 'bubblewrap'}
                <span style="color:var(--color-success)"
                  ><strong>Kernel-hardened jail active</strong> (bubblewrap).</span
                >
                The filesystem jail and network block are enforced by the Linux kernel. The CLI cannot
                escape them, even via its own shell.
              {:else if sandboxCaps.mechanism === 'seatbelt'}
                <span style="color:var(--color-success)"
                  ><strong>Kernel-hardened jail active</strong> (macOS Seatbelt).</span
                >
                Writes are confined to the project, your secret stores (.ssh/.aws/Keychains…) are read-blocked
                by the OS, and the network can be cut.
              {:else}
                <span style="color:var(--color-warning)"
                  ><strong
                    >⚠ Warning: OS-level sandbox unavailable on {sandboxCaps.platform === 'win32'
                      ? 'Windows'
                      : sandboxCaps.platform}.</strong
                  ></span
                >
                Windows has no kernel primitive to jail a process's filesystem, so the CLI cannot be fully
                contained. Koryphaios falls back to a <strong>soft jail</strong>. Your other keys
                are scrubbed from the CLI's environment and its home is redirected, so it can't
                reach <code>~/.ssh</code> or cloud creds. A program reading a secret by full
                absolute path isn't blocked. Only share CLI models with people you trust (or use
                Read only or Hardened), or run under WSL2 for a kernel jail.
                <a
                  href="https://koryphaios.com/docs/sandbox#windows"
                  target="_blank"
                  rel="noreferrer"
                  class="inline-block mt-1 font-semibold underline"
                  style="color:var(--color-warning);">Read more →</a
                >
              {/if}
            </div>
          {/if}

          <!-- Presets -->
          <div class="mb-4 flex flex-wrap gap-2">
            {#each PRESET_META as p (p.id)}
              <button
                type="button"
                title={p.hint}
                onclick={() => applyPreset(p.id)}
                class="rounded-lg px-2.5 py-1 text-[11px] font-bold transition-colors"
                style="background: {sandbox.preset === p.id
                  ? 'var(--color-accent)'
                  : 'var(--color-surface-1)'}; color: {sandbox.preset === p.id
                  ? 'var(--color-surface-0)'
                  : 'var(--color-text-secondary)'};">{p.label}</button
              >
            {/each}
            {#if sandbox.preset === 'custom'}
              <span
                class="rounded-lg px-2.5 py-1 text-[11px] font-bold"
                style="background: color-mix(in srgb, var(--color-accent-secondary) 16%, transparent); color:var(--color-accent-secondary);"
                >Custom</span
              >
            {/if}
          </div>

          <!-- Per-option toggles -->
          <div class="space-y-2">
            {#each SANDBOX_TOGGLES as opt (opt.key)}
              {@const on = sandbox[opt.key] === true}
              <SettingsSwitch
                compact
                checked={on}
                label={opt.label}
                description={opt.hint}
                onchange={() => setSandbox(opt.key, !on as any)}
              />
            {/each}
          </div>
          <p class="mt-3 text-[11px] leading-4 text-[var(--color-text-muted)]">
            A guest's access tier can only tighten these, never loosen them. Blocked catastrophic
            commands (rm -rf /, shutdown…) always apply.
            <a
              href="https://koryphaios.com/docs/sandbox"
              target="_blank"
              rel="noreferrer"
              class="underline hover:text-[var(--color-accent)]">How the sandbox works →</a
            >
          </p>
        </div>
      {/if}

  </section>

  <!-- ── CLIENT: use a host's models ── -->
  <section
    class="border-t border-[var(--color-border)] pt-6"
  >
    <h4 class="mb-1 text-[13px] font-semibold text-[var(--color-text-primary)]">Use someone's models</h4>
    <p class="mb-4 text-xs leading-5 text-[var(--color-text-muted)]">
      Enter a host's model-sharing code or model link. Their models appear under the host's chosen name in your model picker and run on
      your own projects and files. You keep your workspace, they supply the inference.
    </p>

    {#if remote?.connected}
      {@const apiCount = remoteApiCount}
      {@const cliCount = remoteCliCount}
      <div
        class="rounded-2xl border border-[var(--color-accent)]/30 bg-[var(--color-surface-1)] p-5"
      >
        <div class="flex items-center justify-between gap-3">
          <div>
            <div class="text-xs font-bold text-[var(--color-text-primary)]">
              Connected to {remote.hostName ?? 'host'}
            </div>
            <p class="text-[11px] text-[var(--color-text-muted)] mt-0.5">
              {apiCount + cliCount} remote model provider(s) in your picker.
            </p>
          </div>
          <button
            type="button"
            onclick={disconnect}
            class="rounded-xl border border-[var(--color-border)] px-3 py-1.5 text-xs font-medium text-[var(--color-error)] hover:bg-[var(--color-error-bg)]"
            >Disconnect</button
          >
        </div>
        <div class="mt-4 space-y-2 text-[11px] leading-4 text-[var(--color-text-muted)]">
          {#if apiCount}
            <div class="flex items-start gap-1.5">
              <ShieldCheck size={11} style="color:var(--color-success)" class="mt-px shrink-0" />
              <span
                ><strong>{apiCount} inference provider(s)</strong>. Only your messages and model calls are sent. The host cannot browse your workspace.</span
              >
            </div>
          {/if}
          {#if cliCount}
            <div class="flex items-start gap-1.5">
              <HardDrive size={11} style="color:var(--color-accent-secondary)" class="mt-px shrink-0" />
              <span
                ><strong>{cliCount} CLI model(s)</strong> (labeled "runs on host"). Your project is copied
                to the host's temp folder to run, then edits come back. You'll confirm before the first
                send.</span
              >
            </div>
          {/if}
        </div>
      </div>
    {:else}
      <div class="flex flex-col gap-3 sm:flex-row sm:items-center">
        <input
          type="text"
          bind:value={joinCode}
          placeholder="Model-sharing code from the host"
          aria-label="Host model-sharing code"
          aria-invalid={!!connectError}
          aria-describedby={connectError ? 'model-connect-error' : undefined}
          oninput={() => (connectError = null)}
          class="input min-h-11 min-w-0 flex-1 text-sm"
          onkeydown={(e) => e.key === 'Enter' && connect()}
        />
        <button
          type="button"
          onclick={connect}
          disabled={connecting || !joinCode.trim()}
          class="btn btn-primary min-h-11 px-6 py-2 text-xs"
        >
          {connecting ? 'Connecting…' : 'Use shared models'}
        </button>
      </div>
      {#if connectError}<p id="model-connect-error" role="alert" class="mt-2 text-xs text-[var(--color-error)]">{connectError}</p>{/if}
    {/if}
  </section>
</div>

{#if configuringProvider}
  {@const candidate = configuringProvider}
  <ModelSelectionDialog
    providerName={candidate.label}
    availableModels={candidate.models}
    selectedModels={modelsFor(candidate)}
    mode="sharing"
    onSave={(selected) => {
      sharedModels = { ...sharedModels, [candidate.provider]: selected };
      configuringProvider = null;
    }}
    onClose={() => (configuringProvider = null)}
  />
{/if}

<style>
  .provider-share-row + .provider-share-row {
    box-shadow: 0 -1px 0 var(--color-border);
  }
</style>
