<script lang="ts">
  import { apiFetch, parseJsonResponse } from '$lib/api.svelte';
  import { apiUrl } from '$lib/utils/api-url';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { loadProvidersFromApi } from '$lib/stores/providers.svelte';
  import { collaborationStore } from '$lib/stores/collaboration.svelte';
  import { Share2, MonitorSmartphone, ShieldAlert, ShieldCheck, ShieldX, Loader2, Link2, HardDrive, Lock, Wifi, Terminal, FilePenLine, Globe } from 'lucide-svelte';
  import { SANDBOX_PRESETS, type ProviderShareRisk, type SandboxPolicy, type SandboxPreset } from '@koryphaios/shared';

  interface ShareCandidate {
    provider: string;
    label: string;
    modelCount: number;
    agentic: boolean;
    risk: ProviderShareRisk;
    reason: string;
  }

  let candidates = $state<ShareCandidate[]>([]);
  let sharedSet = $state<Set<string>>(new Set());
  let loadingHost = $state(false);
  let savingHost = $state(false);

  let joinCode = $state('');
  let connecting = $state(false);
  let remote = $state<{ connected: boolean; hostName: string | null; catalog: any } | null>(null);

  // Sandbox policy for remote CLI turns.
  let sandbox = $state<SandboxPolicy | null>(null);
  let sandboxCaps = $state<{ osIsolation: boolean; mechanism: string; platform: string } | null>(null);
  let savingSandbox = $state(false);
  const sharingAnyCli = $derived(candidates.some((c) => c.agentic && sharedSet.has(c.provider)));

  const hosting = $derived(!!collaborationStore.activeCollab);

  const riskMeta: Record<ProviderShareRisk, { icon: any; color: string; label: string }> = {
    ok: { icon: ShieldCheck, color: '#22c55e', label: 'Safe to share' },
    caution: { icon: ShieldAlert, color: '#f59e0b', label: 'May violate ToS' },
    prohibited: { icon: ShieldX, color: '#ef4444', label: 'Violates ToS' },
  };

  async function loadHost() {
    loadingHost = true;
    try {
      const res = await apiFetch(apiUrl('/api/collab/providers/shared'));
      const data = await parseJsonResponse<{ ok?: boolean; data?: { shared: string[]; candidates: ShareCandidate[] } }>(res);
      if (data.ok && data.data) {
        candidates = data.data.candidates;
        sharedSet = new Set(data.data.shared);
      }
    } catch {
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
    } catch {
      /* ignore */
    }
  }

  async function loadSandbox() {
    try {
      const res = await apiFetch(apiUrl('/api/collab/providers/sandbox'));
      const data = await parseJsonResponse<{ ok?: boolean; data?: { policy: SandboxPolicy; capabilities: typeof sandboxCaps } }>(res);
      if (data.ok && data.data) {
        sandbox = data.data.policy;
        sandboxCaps = data.data.capabilities;
      }
    } catch {
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
    } catch {
      toastStore.error('Could not save sandbox policy');
    } finally {
      savingSandbox = false;
    }
  }

  $effect(() => {
    void loadHost();
    void loadRemote();
    void loadSandbox();
  });

  const SANDBOX_TOGGLES: Array<{ key: keyof SandboxPolicy; label: string; hint: string; icon: any }> = [
    { key: 'filesystemIsolation', label: 'Filesystem jail', hint: 'CLI can only touch the shared project — not your home, keys, or other files.', icon: Lock },
    { key: 'allowNetwork', label: 'Network access', hint: 'Let the CLI reach the internet (package installs, API calls).', icon: Wifi },
    { key: 'allowWebSearch', label: 'Web search', hint: "The CLI's own web search / fetch tools.", icon: Globe },
    { key: 'allowEdits', label: 'Edit files', hint: 'CLI may write files (edits go back to the guest, not you).', icon: FilePenLine },
    { key: 'allowShell', label: 'Run shell commands', hint: 'CLI may run commands — on YOUR machine (inside the jail).', icon: Terminal },
  ];

  const PRESET_META: Array<{ id: Exclude<SandboxPreset, 'custom'>; label: string; hint: string }> = [
    { id: 'balanced', label: 'Balanced', hint: 'Jailed, but network + web + shell + edits on. Recommended.' },
    { id: 'hardened', label: 'Hardened', hint: 'No network, no shell. Read + edit only.' },
    { id: 'readonly', label: 'Read-only', hint: 'Analysis only — no edits, shell, or network.' },
    { id: 'trusted', label: 'Trusted', hint: 'No jail, everything on. Full trust only.' },
  ];

  function toggleShare(c: ShareCandidate) {
    const enabling = !sharedSet.has(c.provider);
    if (enabling && c.risk === 'prohibited') {
      toastStore.warning(`${c.label} violates the provider's Terms of Service — sharing is at your own risk.`);
    } else if (enabling && c.risk === 'caution') {
      toastStore.warning(`Sharing ${c.label} may violate the provider's terms — use at your own risk.`);
    }
    const next = new Set(sharedSet);
    if (next.has(c.provider)) next.delete(c.provider);
    else next.add(c.provider);
    sharedSet = next;
  }

  async function saveHost() {
    savingHost = true;
    try {
      const res = await apiFetch(apiUrl('/api/collab/providers/shared'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providers: [...sharedSet] }),
      });
      if (res.ok) toastStore.success('Shared providers updated');
      else toastStore.error('Could not update shared providers');
    } catch {
      toastStore.error('Could not update shared providers');
    } finally {
      savingHost = false;
    }
  }

  async function connect() {
    const code = joinCode.trim();
    if (!code) return;
    connecting = true;
    try {
      const res = await apiFetch(apiUrl('/api/collab/providers/connect'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ joinCode: code }),
      });
      const data = await parseJsonResponse<{ ok?: boolean; error?: string; data?: { hostName: string | null } }>(res);
      if (data.ok) {
        toastStore.success(`Connected to ${data.data?.hostName ?? 'host'} — their models are now in your picker`);
        joinCode = '';
        await loadRemote();
        await loadProvidersFromApi();
      } else {
        toastStore.error(data.error || 'Could not connect to host');
      }
    } catch (err: any) {
      toastStore.error(err.message || 'Could not connect to host');
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
    } catch {
      toastStore.error('Could not disconnect');
    }
  }

  const anyRisky = $derived(candidates.some((c) => sharedSet.has(c.provider) && c.risk !== 'ok'));
</script>

<div class="space-y-8">
  <div class="text-center">
    <div class="w-16 h-16 mx-auto mb-4 rounded-3xl flex items-center justify-center" style="background: color-mix(in srgb, #a78bfa 12%, transparent); color: #a78bfa;">
      <Share2 size={30} />
    </div>
    <h3 class="text-2xl font-black text-[var(--color-text-primary)]">Share Models</h3>
    <p class="text-sm text-[var(--color-text-muted)] mt-2">
      Lend your providers for inference — or borrow someone else's. Each side keeps its own workspace and files; only the model call travels.
    </p>
  </div>

  <!-- ── HOST: share my providers ── -->
  <section class="rounded-3xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-6">
    <div class="flex items-center gap-3 mb-1">
      <Share2 size={18} style="color: var(--color-accent);" />
      <h4 class="text-sm font-bold text-[var(--color-text-primary)]">Share my models</h4>
    </div>
    <p class="text-[11px] text-[var(--color-text-muted)] mb-5">
      Pick which providers to lend. The other person uses them on <strong>their own</strong> computer and files —
      only the model call runs here, nothing touches your filesystem.
    </p>

    {#if loadingHost}
      <div class="flex items-center gap-2 text-xs text-[var(--color-text-muted)]"><Loader2 size={14} class="animate-spin" /> Loading providers…</div>
    {:else if candidates.length === 0}
      <p class="text-xs text-[var(--color-text-muted)]">Connect a provider first — authenticated providers appear here to share.</p>
    {:else}
      <div class="space-y-2">
        {#each candidates as c (c.provider)}
          {@const meta = riskMeta[c.risk]}
          {@const on = sharedSet.has(c.provider)}
          <label
            class="flex items-start gap-3 rounded-2xl p-3.5 cursor-pointer transition-colors"
            style="background: {on && c.risk === 'prohibited' ? 'color-mix(in srgb, #ef4444 8%, var(--color-surface-1))' : 'var(--color-surface-1)'};"
          >
            <input type="checkbox" class="mt-1" checked={on} onchange={() => toggleShare(c)} />
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2 flex-wrap">
                <span class="text-xs font-semibold text-[var(--color-text-primary)]">{c.label}</span>
                <span class="text-[10px] text-[var(--color-text-muted)]">{c.modelCount} model{c.modelCount === 1 ? '' : 's'}</span>
                <span class="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-full" style="color: {meta.color}; background: color-mix(in srgb, {meta.color} 14%, transparent);">
                  <meta.icon size={10} /> {meta.label}
                </span>
                {#if c.agentic}
                  <span class="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-full" style="color: #a78bfa; background: color-mix(in srgb, #a78bfa 14%, transparent);">
                    <HardDrive size={10} /> CLI · runs on your PC
                  </span>
                {/if}
              </div>
              <p class="text-[10px] text-[var(--color-text-muted)] mt-0.5">{c.reason}</p>
              {#if c.agentic}
                <p class="text-[10px] mt-1" style="color: #a78bfa;">
                  This is a CLI tool. When someone uses it, <strong>their project files are copied into a temp folder on your PC</strong>
                  and the CLI runs on your machine. Their edits are sent back to them. API providers never do this — files stay on their side.
                </p>
              {/if}
              {#if on && c.risk === 'prohibited'}
                <p class="text-[10px] font-semibold mt-1" style="color: #ef4444;">
                  ⚠ Sharing this violates the provider's Terms of Service. Providers enforce this. Use at your own risk.
                </p>
              {:else if on && c.risk === 'caution'}
                <p class="text-[10px] font-semibold mt-1" style="color: #f59e0b;">
                  ⚠ Sharing this may violate the provider's Terms of Service. Use at your own risk.
                </p>
              {/if}
            </div>
          </label>
        {/each}
      </div>

      {#if anyRisky}
        <div class="mt-4 rounded-2xl border p-3 text-[11px] leading-relaxed" style="border-color: color-mix(in srgb, #f59e0b 40%, transparent); background: color-mix(in srgb, #f59e0b 8%, transparent); color: var(--color-text-secondary);">
          <strong style="color: #f59e0b;">Heads up:</strong> you've selected subscription-backed providers. Lending a subscription to
          another person is account-sharing that several providers' terms forbid and actively enforce (bans). Your own
          <em>API keys</em> are the safe way to share. Enable these only if you accept the risk.
        </div>
      {/if}

      <div class="mt-4 flex justify-end">
        <button type="button" onclick={saveHost} disabled={savingHost} class="btn btn-primary text-xs px-5 py-2">
          {savingHost ? 'Saving…' : 'Save shared providers'}
        </button>
      </div>

      {#if sharingAnyCli && sandbox}
        <!-- Sandbox policy — how the shared CLI runs on YOUR machine. -->
        <div class="mt-5 border-t border-[var(--color-border)] pt-5">
          <div class="flex items-center gap-2 mb-1">
            <Lock size={14} style="color: #a78bfa;" />
            <span class="text-xs font-bold text-[var(--color-text-primary)]">CLI sandbox</span>
            {#if savingSandbox}<Loader2 size={11} class="animate-spin text-[var(--color-text-muted)]" />{/if}
          </div>
          <p class="text-[11px] text-[var(--color-text-muted)] mb-3">
            You're sharing a CLI model, which runs on your PC. Choose how it's confined.
          </p>

          <!-- OS-level enforcement indicator (mechanism-aware) -->
          {#if sandboxCaps}
            <div class="mb-3 rounded-xl px-3 py-2 text-[10px] leading-relaxed" style="background: {sandboxCaps.osIsolation ? 'color-mix(in srgb, #22c55e 10%, transparent)' : 'color-mix(in srgb, #f59e0b 10%, transparent)'};">
              {#if sandboxCaps.mechanism === 'bubblewrap'}
                <span style="color:#22c55e"><strong>Kernel-hardened jail active</strong> (bubblewrap).</span>
                The filesystem jail and network block are enforced by the Linux kernel — the CLI can't escape them, even via its own shell.
              {:else if sandboxCaps.mechanism === 'seatbelt'}
                <span style="color:#22c55e"><strong>Kernel-hardened jail active</strong> (macOS Seatbelt).</span>
                Writes are confined to the project, your secret stores (.ssh/.aws/Keychains…) are read-blocked by the OS, and the network can be cut.
              {:else}
                <span style="color:#f59e0b"><strong>⚠ Warning: OS-level sandbox unavailable on {sandboxCaps.platform === 'win32' ? 'Windows' : sandboxCaps.platform}.</strong></span>
                Windows has no kernel primitive to jail a process's filesystem, so the CLI can't be hard-contained. Koryphaios falls back to a <strong>soft jail</strong> — your other keys are scrubbed from the CLI's environment and its home is redirected, so it can't reach <code>~/.ssh</code> or cloud creds — but a program reading a secret by full absolute path isn't blocked. Only share CLI models with people you trust (or use Read-only/Hardened), or run under WSL2 for a kernel jail.
                <a href="https://koryphaios.com/docs/sandbox#windows" target="_blank" rel="noreferrer" class="inline-block mt-1 font-semibold underline" style="color:#f59e0b;">Read more →</a>
              {/if}
            </div>
          {/if}

          <!-- Presets -->
          <div class="flex flex-wrap gap-1.5 mb-3">
            {#each PRESET_META as p (p.id)}
              <button
                type="button"
                title={p.hint}
                onclick={() => applyPreset(p.id)}
                class="rounded-lg px-2.5 py-1 text-[10px] font-bold transition-colors"
                style="background: {sandbox.preset === p.id ? 'var(--color-accent)' : 'var(--color-surface-1)'}; color: {sandbox.preset === p.id ? 'var(--color-surface-0)' : 'var(--color-text-secondary)'};"
              >{p.label}</button>
            {/each}
            {#if sandbox.preset === 'custom'}
              <span class="rounded-lg px-2.5 py-1 text-[10px] font-bold" style="background: color-mix(in srgb, #a78bfa 16%, transparent); color:#a78bfa;">Custom</span>
            {/if}
          </div>

          <!-- Per-option toggles -->
          <div class="space-y-1.5">
            {#each SANDBOX_TOGGLES as opt (opt.key)}
              {@const on = sandbox[opt.key] === true}
              <button
                type="button"
                onclick={() => setSandbox(opt.key, !on as any)}
                class="w-full flex items-center gap-3 rounded-xl bg-[var(--color-surface-1)] px-3 py-2.5 text-left hover:bg-[var(--color-surface-3)] transition-colors"
              >
                <opt.icon size={13} class="shrink-0" style="color: {on ? 'var(--color-accent)' : 'var(--color-text-muted)'};" />
                <span class="min-w-0 flex-1">
                  <span class="block text-[11px] font-medium text-[var(--color-text-primary)]">{opt.label}</span>
                  <span class="block text-[10px] text-[var(--color-text-muted)]">{opt.hint}</span>
                </span>
                <span class="h-4 w-7 shrink-0 rounded-full p-0.5" style="background: {on ? 'var(--color-accent)' : 'var(--color-surface-4)'};">
                  <span class="block h-3 w-3 rounded-full bg-white transition-transform" style="transform: translateX({on ? '12px' : '0'});"></span>
                </span>
              </button>
            {/each}
          </div>
          <p class="mt-2 text-[10px] text-[var(--color-text-muted)]">
            A guest's access tier can only tighten these, never loosen them. Blocked catastrophic commands (rm -rf /, shutdown…) always apply.
            <a href="https://koryphaios.com/docs/sandbox" target="_blank" rel="noreferrer" class="underline hover:text-[var(--color-accent)]">How the sandbox works →</a>
          </p>
        </div>
      {/if}

      <!-- Dedicated model-sharing link — grants ONLY model access, not session access. -->
      <div class="mt-5 border-t border-[var(--color-border)] pt-5">
        {#if hosting}
          <div class="flex items-center justify-between gap-4 rounded-2xl bg-[var(--color-surface-1)] p-4">
            <div>
              <div class="text-xs font-bold text-[var(--color-text-primary)]">Model-sharing invite</div>
              <p class="mt-1 text-[11px] text-[var(--color-text-muted)]">
                A models-only link — they can use your providers but never see your session or files.
              </p>
            </div>
            <button
              type="button"
              onclick={() => collaborationStore.createInvite('models')}
              class="shrink-0 inline-flex items-center gap-1.5 rounded-xl px-4 py-2 text-xs font-bold"
              style="background: color-mix(in srgb, #a78bfa 16%, transparent); color: #a78bfa;"
            >
              <Link2 size={12} /> Copy model link
            </button>
          </div>
        {:else}
          <p class="text-[11px] text-[var(--color-text-muted)]">
            Start a hosted session (in the Team Collaboration section above) to get a shareable model link.
          </p>
        {/if}
      </div>
    {/if}
  </section>

  <!-- ── CLIENT: use a host's models ── -->
  <section class="rounded-3xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-6">
    <div class="flex items-center gap-3 mb-1">
      <MonitorSmartphone size={18} style="color: var(--color-accent);" />
      <h4 class="text-sm font-bold text-[var(--color-text-primary)]">Use someone's models</h4>
    </div>
    <p class="text-[11px] text-[var(--color-text-muted)] mb-5">
      Paste a host's model link (or join code). Their models appear in your model picker and run on your own
      projects and files — you keep your workspace, they supply the inference.
    </p>

    {#if remote?.connected}
      {@const apiCount = remote.catalog?.providers?.filter((p: any) => !p.agentic).length ?? 0}
      {@const cliCount = remote.catalog?.providers?.filter((p: any) => p.agentic).length ?? 0}
      <div class="rounded-2xl border border-[var(--color-accent)]/30 bg-[var(--color-surface-1)] p-4">
        <div class="flex items-center justify-between gap-3">
          <div>
            <div class="text-xs font-bold text-[var(--color-text-primary)]">Connected to {remote.hostName ?? 'host'}</div>
            <p class="text-[11px] text-[var(--color-text-muted)] mt-0.5">
              {apiCount + cliCount} remote model provider(s) in your picker.
            </p>
          </div>
          <button type="button" onclick={disconnect} class="rounded-xl border border-[var(--color-border)] px-3 py-1.5 text-xs font-medium text-red-400 hover:bg-red-500/10">Disconnect</button>
        </div>
        <div class="mt-3 space-y-1.5 text-[10px] text-[var(--color-text-muted)]">
          {#if apiCount}
            <div class="flex items-start gap-1.5"><ShieldCheck size={11} style="color:#22c55e" class="mt-px shrink-0" /> <span><strong>{apiCount} API model(s)</strong> — run on the host, your files never leave your PC.</span></div>
          {/if}
          {#if cliCount}
            <div class="flex items-start gap-1.5"><HardDrive size={11} style="color:#a78bfa" class="mt-px shrink-0" /> <span><strong>{cliCount} CLI model(s)</strong> (labeled "runs on host") — your project is copied to the host's temp folder to run, then edits come back. You'll confirm before the first send.</span></div>
          {/if}
        </div>
      </div>
    {:else}
      <div class="flex items-center gap-2">
        <input
          type="text"
          bind:value={joinCode}
          placeholder="Model link or join code from the host"
          class="input flex-1 text-sm"
          onkeydown={(e) => e.key === 'Enter' && connect()}
        />
        <button type="button" onclick={connect} disabled={connecting || !joinCode.trim()} class="btn btn-primary text-xs px-5 py-2">
          {connecting ? 'Connecting…' : 'Connect'}
        </button>
      </div>
    {/if}
  </section>
</div>
