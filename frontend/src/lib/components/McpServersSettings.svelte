<script lang="ts">
  import { onMount } from 'svelte';
  import AlertTriangle from 'lucide-svelte/icons/alert-triangle';
  import Check from 'lucide-svelte/icons/check';
  import Globe from 'lucide-svelte/icons/globe';
  import KeyRound from 'lucide-svelte/icons/key-round';
  import LogOut from 'lucide-svelte/icons/log-out';
  import LoaderCircle from 'lucide-svelte/icons/loader-circle';
  import Pencil from 'lucide-svelte/icons/pencil';
  import Plug from 'lucide-svelte/icons/plug';
  import Plus from 'lucide-svelte/icons/plus';
  import RefreshCw from 'lucide-svelte/icons/refresh-cw';
  import Search from 'lucide-svelte/icons/search';
  import Server from 'lucide-svelte/icons/server';
  import Terminal from 'lucide-svelte/icons/terminal';
  import Trash2 from 'lucide-svelte/icons/trash-2';
  import X from 'lucide-svelte/icons/x';
  import {
    mcpServersStore,
    type McpServerInput,
    type McpServerStatus,
    type McpServerTestResult,
    type McpRegistrySearchResult,
  } from '$lib/stores/mcp-servers.svelte';
  import ConfirmDialog from './ConfirmDialog.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { mcpRegistryIconUrl } from '$lib/utils/mcp-registry-icon';
  import KorySelect from './KorySelect.svelte';
  import SettingsPage from './settings/SettingsPage.svelte';

  // ─── Form state ──────────────────────────────────────────────────────────
  let editingName = $state<string | null>(null);
  let formName = $state('');
  let formType = $state<'stdio' | 'sse'>('stdio');
  let formCommand = $state('');
  let formArgs = $state('');
  let formUrl = $state('');
  let formHeaders = $state('');
  /** Env rows: each row has a key and a value. Existing keys are loaded with a
   * masked placeholder; the user types a new value to replace it. */
  let envRows = $state<Array<{ key: string; value: string; masked: boolean }>>([]);
  let formSaving = $state(false);
  let testingName = $state<string | null>(null);
  let testResult = $state<Record<string, McpServerTestResult | null>>({});
  let removeTarget = $state<string | null>(null);
  let envLoading = $state(false);
  /** Server whose OAuth consent screen is open in the user's browser. */
  let awaitingConsent = $state<string | null>(null);
  let consentPollMs = 600;
  /** Server whose own-app-credential form is open. */
  let manualClientFor = $state<string | null>(null);
  let manualClientId = $state('');
  let manualClientSecret = $state('');
  /** Local validation message for the credential form. */
  let manualClientError = $state<string | null>(null);

  // ─── View state: "list" | "browse" | "form" ──────────────────────────────
  type McpView = 'list' | 'browse' | 'form';
  let view = $state<McpView>('list');
  let registrySearchInput = $state('');
  /** Entries whose derived icon failed to load fall back to the transport glyph. */
  let failedRegistryIcons = $state<Record<string, true>>({});

  function registryIconSrc(result: McpRegistrySearchResult): string {
    if (failedRegistryIcons[result.id]) return '';
    return mcpRegistryIconUrl(result);
  }

  function markRegistryIconFailed(id: string): void {
    failedRegistryIcons = { ...failedRegistryIcons, [id]: true };
  }

  const transportOptions = [
    {
      value: 'stdio',
      label: 'stdio',
      description: 'Spawn a local process and communicate over stdin/stdout.',
    },
    {
      value: 'sse',
      label: 'SSE',
      description: 'Connect to a remote server over HTTP Server-Sent Events.',
    },
  ];

  // ─── Lifecycle ───────────────────────────────────────────────────────────
  onMount(() => {
    void mcpServersStore.loadAll();
  });

  // ─── Form helpers ─────────────────────────────────────────────────────────
  function resetForm(): void {
    formName = '';
    formType = 'stdio';
    formCommand = '';
    formArgs = '';
    formUrl = '';
    formHeaders = '';
    envRows = [];
    editingName = null;
  }

  function openAddForm(): void {
    resetForm();
    view = 'form';
  }

  function closeForm(): void {
    view = 'list';
    resetForm();
  }

  function openBrowse(): void {
    view = 'browse';
    void mcpServersStore.loadFeatured();
  }

  function closeBrowse(): void {
    view = 'list';
    mcpServersStore.clearRegistry();
    registrySearchInput = '';
  }

  function handleRegistrySearch(): void {
    const q = registrySearchInput.trim();
    mcpServersStore.registryQuery = q;
    void mcpServersStore.searchRegistry(q);
  }

  function loadMoreRegistry(): void {
    if (mcpServersStore.registryNextCursor) {
      void mcpServersStore.searchRegistry(
        mcpServersStore.registryQuery,
        mcpServersStore.registryNextCursor,
      );
    }
  }

  function addFromRegistry(result: McpRegistrySearchResult): void {
    resetForm();
    // Use the last path segment as a default server name (more readable than
    // the full reverse-DNS id like "io.github.user/server").
    const shortName = result.name.split('/').pop() ?? result.name;
    formName = shortName;
    formType = result.transport;
    if (result.transport === 'stdio') {
      formCommand = result.command ?? '';
      formArgs = result.args.join('\n');
      envRows = result.envVars.map((v) => ({
        key: v.name,
        value: v.defaultValue ?? '',
        masked: false,
      }));
    } else {
      formUrl = result.url ?? '';
      // Seed a real, editable `Key:` line per header. These used to be written
      // as `# Key: description` comment lines, which parseHeaders() skips — so
      // every remote server was added with no auth header at all. The comment
      // line is kept alongside as documentation; parseHeaders() ignores it.
      if (result.headerVars.length > 0) {
        formHeaders = result.headerVars
          .flatMap((h) => {
            const hint = h.description || (h.isSecret ? 'secret value required' : 'set this value');
            return [`# ${h.name}: ${hint}`, `${h.name}:`];
          })
          .join('\n');
      }
    }
    view = 'form';
  }

  function addEnvRow(): void {
    envRows = [...envRows, { key: '', value: '', masked: false }];
  }

  function removeEnvRow(index: number): void {
    envRows = envRows.filter((_, i) => i !== index);
  }

  function updateEnvKey(index: number, key: string): void {
    envRows = envRows.map((row, i) => (i === index ? { ...row, key } : row));
  }

  function updateEnvValue(index: number, value: string): void {
    envRows = envRows.map((row, i) => (i === index ? { ...row, value, masked: false } : row));
  }

  function parseArgs(text: string): string[] {
    return text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  function parseHeaders(text: string): Record<string, string> {
    const headers: Record<string, string> = {};
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const colonIdx = trimmed.indexOf(':');
      if (colonIdx === -1) continue;
      const key = trimmed.slice(0, colonIdx).trim();
      const value = trimmed.slice(colonIdx + 1).trim();
      if (key) headers[key] = value;
    }
    return headers;
  }

  function collectEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const row of envRows) {
      const key = row.key.trim();
      if (!key) continue;
      // Skip masked rows where the user did not type a new value — the
      // backend already holds the secret and we must not send an empty
      // string that would overwrite it.
      if (row.masked && !row.value) continue;
      env[key] = row.value;
    }
    return env;
  }

  function buildInput(): McpServerInput {
    const input: McpServerInput = {
      name: formName.trim(),
      type: formType,
    };
    if (formType === 'stdio') {
      input.command = formCommand.trim() || undefined;
      const args = parseArgs(formArgs);
      if (args.length) input.args = args;
      const env = collectEnv();
      if (Object.keys(env).length) input.env = env;
    } else {
      input.url = formUrl.trim() || undefined;
      // Drop keys the user left blank — an empty `Authorization:` header makes
      // strict servers 400 instead of reporting a clean 401.
      const headers = Object.fromEntries(
        Object.entries(parseHeaders(formHeaders)).filter(([, v]) => v.length > 0),
      );
      if (Object.keys(headers).length) input.headers = headers;
    }
    return input;
  }

  async function handleSubmit(): Promise<void> {
    if (!formName.trim()) {
      return;
    }
    formSaving = true;
    const input = buildInput();
    if (editingName) {
      const ok = await mcpServersStore.updateServer(editingName, input);
      if (ok) closeForm();
    } else {
      const ok = await mcpServersStore.addServer(input);
      if (ok) closeForm();
    }
    formSaving = false;
  }

  async function startEdit(server: McpServerStatus): Promise<void> {
    editingName = server.name;
    formName = server.name;
    formType = server.transport;
    // We cannot pre-fill command/args/url/headers because the backend does not
    // return stored config details — only status. The user re-enters them.
    formCommand = '';
    formArgs = '';
    formUrl = '';
    formHeaders = '';
    envRows = [];
    envLoading = true;
    view = 'form';
    const keys = await mcpServersStore.getEnvKeys(server.name);
    envRows = keys.map((key) => ({ key, value: '', masked: true }));
    envLoading = false;
  }

  async function handleTest(name: string): Promise<void> {
    testingName = name;
    const result = await mcpServersStore.testServer(name);
    testResult = { ...testResult, [name]: result };
    testingName = null;
  }

  async function handleReload(name: string): Promise<void> {
    await mcpServersStore.reloadServer(name);
  }

  function confirmRemove(name: string): void {
    removeTarget = name;
  }

  async function doRemove(): Promise<void> {
    if (!removeTarget) return;
    await mcpServersStore.removeServer(removeTarget);
    removeTarget = null;
  }

  /**
   * Drive one OAuth consent flow: ask the backend to start it, open the
   * provider URL in the user's browser, then poll until the loopback redirect
   * has been exchanged for a token.
   *
   * `manualClient` supplies the user's own app credentials for servers that do
   * not allow automatic registration.
   */
  async function handleAuthorize(
    name: string,
    manualClient?: { clientId: string; clientSecret?: string },
  ): Promise<void> {
    const url = await mcpServersStore.startAuthorization(name, manualClient);
    if (!url) return;
    awaitingConsent = name;
    openExternalUrl(url);
    const deadline = Date.now() + 5 * 60_000;
    while (awaitingConsent === name && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, consentPollMs));
      if (awaitingConsent !== name) break;
      // completeAuthorization resolves false while the user is still in the
      // browser; a real failure surfaces as a toast, so keep polling until the
      // flow succeeds or the deadline passes.
      if (await mcpServersStore.completeAuthorization(name)) {
        awaitingConsent = null;
        return;
      }
    }
    if (awaitingConsent === name) {
      awaitingConsent = null;
      await mcpServersStore.cancelAuthorization(name);
      toastStore.warning('Authorization was not completed');
    }
  }

  async function handleDisconnect(name: string): Promise<void> {
    await mcpServersStore.disconnectAuthorization(name);
  }

  function openManualClientForm(name: string): void {
    manualClientFor = name;
    manualClientId = '';
    manualClientSecret = '';
    manualClientError = null;
    mcpServersStore.clearAuthBlocker(name);
  }

  function closeManualClientForm(): void {
    manualClientFor = null;
    manualClientId = '';
    manualClientSecret = '';
    manualClientError = null;
  }

  /** Start authorization with the credentials the user just entered. */
  async function submitManualClient(name: string): Promise<void> {
    const clientId = manualClientId.trim();
    if (!clientId) {
      manualClientError = 'Enter the client ID from your app.';
      return;
    }
    // Read both fields before resetting the form — clearing the form first wiped
    // the secret we were about to send.
    const clientSecret = manualClientSecret.trim();
    manualClientError = null;
    closeManualClientForm();
    await handleAuthorize(name, { clientId, clientSecret: clientSecret || undefined });
  }

  /**
   * Whether to offer the "enter your own app credentials" form.
   *
   * Two independent triggers, so the user is never bounced to a browser that
   * cannot help them:
   *   • the catalog already knows the provider allows no dynamic registration
   *   • the backend reported that blocker while trying to authorize
   * A server that supports dynamic registration satisfies neither, so it is
   * never asked for credentials it does not need.
   */
  function needsManualClient(server: { name: string; auth?: { kind: string } }): boolean {
    if (server.auth?.kind === 'manual') return true;
    const blocker = mcpServersStore.authBlocker;
    return (
      blocker?.server === server.name && blocker.code === 'dynamic_registration_unavailable'
    );
  }

  /** Whether the server is asking for a header credential rather than a sign-in. */
  function isHeaderAuth(server: { transport: string; auth?: { kind: string } }): boolean {
    return server.transport !== 'stdio' && server.auth?.kind === 'headers';
  }

  function authKind(server: {
    transport: string;
    auth?: { kind: string };
    oauth?: { authorized: boolean };
  }): string {
    if (server.transport === 'stdio') return 'none';
    if (server.oauth?.authorized) return 'none';
    return server.auth?.kind ?? 'unknown';
  }

  function openExternalUrl(url: string): void {
    if (typeof window === 'undefined') return;
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  const formValid = $derived(formName.trim().length > 0);

  const focusRing =
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/60';
  const ghostBtn = `flex min-h-9 items-center gap-1.5 rounded-lg px-2.5 text-xs text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-3)] hover:text-[var(--color-text-primary)] disabled:opacity-50 ${focusRing}`;
  const dangerBtn = `flex min-h-9 items-center gap-1.5 rounded-lg px-2.5 text-xs text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-error-bg)] hover:text-[var(--color-error)] ${focusRing}`;
  const softBtn = `flex min-h-9 shrink-0 items-center gap-1.5 rounded-lg bg-[var(--color-surface-2)] px-3 text-xs font-medium text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-surface-3)] disabled:opacity-50 ${focusRing}`;
  const softSurfaceBtn = `flex min-h-9 items-center gap-1.5 rounded-lg bg-[var(--color-surface-1)] px-3 text-xs font-medium text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-surface-3)] ${focusRing}`;
  const primaryBtn = `flex min-h-9 shrink-0 items-center gap-1.5 rounded-lg bg-[var(--color-accent)] px-3 text-xs font-semibold text-[var(--color-on-accent)] transition-colors hover:bg-[var(--color-accent-hover)] disabled:cursor-not-allowed disabled:bg-[var(--color-surface-3)] disabled:text-[var(--color-text-muted)] disabled:shadow-none ${focusRing}`;

  /**
   * How a browse-list entry should present its sign-in requirement. A user
   * choosing a connector should learn what it will cost them before adding it,
   * not after hitting a 401.
   */
  function authBadge(auth: { kind: string; label: string } | undefined): {
    text: string;
    tone: string;
  } | null {
    if (!auth || auth.kind === 'none') return null;
    switch (auth.kind) {
      case 'oauth':
        return { text: 'Sign in', tone: 'text-[var(--color-success)]' };
      case 'env':
        return { text: 'Needs a key', tone: 'text-[var(--color-warning)]' };
      case 'headers':
        return { text: 'Needs a token', tone: 'text-[var(--color-warning)]' };
      case 'manual':
        return { text: 'Bring your own app', tone: 'text-[var(--color-warning)]' };
      default:
        return { text: 'Sign in', tone: 'text-[var(--color-text-muted)]' };
    }
  }

  const featuredGroups = $derived.by(() => {
    const groups: Array<{ category: string; servers: McpRegistrySearchResult[] }> = [];
    for (const server of mcpServersStore.featuredServers) {
      const category = server.category ?? 'Other';
      let group = groups.find((candidate) => candidate.category === category);
      if (!group) {
        group = { category, servers: [] };
        groups.push(group);
      }
      group.servers.push(server);
    }
    return groups;
  });
</script>

{#snippet transportGlyph(transport: string)}
  {#if transport === 'sse'}
    <Globe size={18} class="text-[var(--color-text-muted)]" />
  {:else}
    <Terminal size={18} class="text-[var(--color-text-muted)]" />
  {/if}
{/snippet}

{#snippet registryRow(result: McpRegistrySearchResult)}
  {@const badge = authBadge(result.auth)}
  <article
    class="grid grid-cols-[20px_minmax(0,1fr)_auto] items-start gap-x-3 rounded-xl px-3 py-3.5 transition-colors hover:bg-[var(--color-surface-2)]"
  >
    <span class="flex h-5 w-5 items-center justify-center">
      {#if registryIconSrc(result)}
        <img
          src={registryIconSrc(result)}
          alt=""
          width="20"
          height="20"
          loading="lazy"
          referrerpolicy="no-referrer"
          draggable="false"
          class="h-5 w-5 rounded-[5px] object-cover"
          onerror={() => markRegistryIconFailed(result.id)}
        />
      {:else}
        {@render transportGlyph(result.transport)}
      {/if}
    </span>
    <div class="min-w-0">
      <div class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <h4 class="text-sm font-semibold text-[var(--color-text-primary)]">{result.title}</h4>
        <span class="text-xs text-[var(--color-text-muted)]">
          {result.transport}{#if result.version && /^\d/.test(result.version)}&nbsp;· v{result.version}{/if}
        </span>
        {#if badge}
          <span class="text-xs font-medium {badge.tone}">· {badge.text}</span>
        {/if}
      </div>
      {#if result.description}
        <p class="mt-1 text-xs leading-relaxed text-[var(--color-text-secondary)]">
          {result.description}
        </p>
      {/if}
      {#if badge && result.auth?.detail}
        <p class="mt-1 text-xs leading-relaxed text-[var(--color-text-muted)]">
          {result.auth.detail}
        </p>
      {/if}
      {#if result.transport === 'stdio' && result.command}
        <p
          class="mt-1.5 truncate font-mono text-[11px] text-[var(--color-text-muted)]"
          title={`${result.command} ${result.args.join(' ')}`}
        >
          {result.command}
          {result.args.join(' ')}
        </p>
      {:else if result.url}
        <p class="mt-1.5 truncate font-mono text-[11px] text-[var(--color-text-muted)]" title={result.url}>
          {result.url}
        </p>
      {/if}
      {#if result.envVars.length > 0 || result.headerVars.length > 0}
        <p class="mt-1 flex flex-wrap gap-x-2.5 gap-y-0.5 font-mono text-[11px]">
          {#each result.envVars as envVar (envVar.name)}
            <span
              class={envVar.isRequired
                ? 'text-[var(--color-warning)]'
                : 'text-[var(--color-text-muted)]'}
              title={envVar.description}>{envVar.name}{envVar.isRequired ? ' *' : ''}</span
            >
          {/each}
          {#each result.headerVars as headerVar (headerVar.name)}
            <span class="text-[var(--color-warning)]" title={headerVar.description}
              >{headerVar.name}</span
            >
          {/each}
        </p>
      {/if}
      {#if result.websiteUrl || result.repositoryUrl}
        <div class="mt-1.5 flex flex-wrap gap-x-4 text-xs text-[var(--color-text-muted)]">
          {#if result.websiteUrl}
            <a
              href={result.websiteUrl}
              target="_blank"
              rel="noopener noreferrer"
              class="transition-colors hover:text-[var(--color-accent)]">Website</a
            >
          {/if}
          {#if result.repositoryUrl}
            <a
              href={result.repositoryUrl}
              target="_blank"
              rel="noopener noreferrer"
              class="transition-colors hover:text-[var(--color-accent)]">Repository</a
            >
          {/if}
        </div>
      {/if}
    </div>
    <button type="button" onclick={() => addFromRegistry(result)} class={primaryBtn}>
      <Plus size={13} /> Add
    </button>
  </article>
{/snippet}

<SettingsPage title="MCP servers" description="Connect local or remote tool servers." width="wide">
  {#snippet actions()}
    {#if view === 'list'}
      <button type="button" onclick={openBrowse} class={softBtn}>
        <Search size={13} /> Browse registry
      </button>
      <button type="button" onclick={openAddForm} class={softBtn}>
        <Plus size={13} /> Add manually
      </button>
    {/if}
  {/snippet}

    <div class="space-y-3">
      {#if view === 'list'}
        {#if mcpServersStore.error && mcpServersStore.servers.length === 0}
          <section
            role="alert"
            class="flex items-start gap-3 rounded-xl bg-[var(--color-error-bg)] p-4"
          >
            <AlertTriangle size={18} class="mt-0.5 shrink-0 text-[var(--color-error)]" />
            <div class="min-w-0 flex-1">
              <h4 class="text-sm font-semibold text-[var(--color-text-primary)]">
                MCP servers unavailable
              </h4>
              <p class="mt-1 text-xs leading-relaxed text-[var(--color-text-secondary)]">
                {mcpServersStore.error}
              </p>
            </div>
            <button
              type="button"
              disabled={mcpServersStore.loading}
              onclick={() => void mcpServersStore.loadAll()}
              class={softBtn}
            >
              <RefreshCw size={14} /> Retry
            </button>
          </section>
        {:else if mcpServersStore.loading && mcpServersStore.servers.length === 0}
          <section
            role="status"
            class="flex items-center justify-center gap-2 py-12 text-sm text-[var(--color-text-muted)]"
          >
            <RefreshCw size={16} class="animate-spin" /> Loading MCP servers…
          </section>
        {:else if mcpServersStore.servers.length === 0}
          <section
            class="flex flex-col items-center px-4 py-12 text-center"
            aria-live="polite"
          >
            <Server size={26} class="text-[var(--color-text-muted)]" />
            <h4 class="mt-3 text-sm font-semibold text-[var(--color-text-primary)]">
              No servers configured
            </h4>
            <p class="mt-1 max-w-sm text-xs leading-relaxed text-[var(--color-text-muted)]">
              Add a local stdio process or a remote SSE endpoint to give agents access to external
              tools.
            </p>
            <div class="mt-4 flex flex-wrap items-center justify-center gap-2">
              <button type="button" onclick={openBrowse} class={primaryBtn}>
                <Search size={13} /> Browse registry
              </button>
              <button type="button" onclick={openAddForm} class={softBtn}>
                <Plus size={13} /> Add manually
              </button>
            </div>
          </section>
        {:else}
          <div class="-mx-3 space-y-1">
            {#each mcpServersStore.servers as server (server.name)}
              <section
                class="grid grid-cols-[20px_minmax(0,1fr)] gap-x-3 rounded-xl px-3 py-3.5 transition-colors hover:bg-[var(--color-surface-2)]/60"
              >
                <span class="flex h-5 w-5 items-center justify-center">
                  {@render transportGlyph(server.transport)}
                </span>
                <div class="min-w-0">
                <div class="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
                  <div class="min-w-0 flex-1">
                    <div class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                      <h4 class="text-sm font-semibold text-[var(--color-text-primary)]">
                        {server.name}
                      </h4>
                      <span
                        class="inline-flex items-center gap-1.5 text-xs font-medium {server.connected
                          ? 'text-[var(--color-success)]'
                          : 'text-[var(--color-error)]'}"
                      >
                        <span class="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true"></span>
                        {server.connected ? 'Connected' : 'Disconnected'}
                      </span>
                    </div>
                    <div
                      class="mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5 text-xs text-[var(--color-text-muted)]"
                    >
                      <span>{server.transport}</span>
                      <span aria-hidden="true">·</span>
                      <span>{server.toolCount} tool{server.toolCount === 1 ? '' : 's'}</span>
                      {#if server.protocolVersion}
                        <span aria-hidden="true">·</span>
                        <span>protocol {server.protocolVersion}</span>
                      {/if}
                      {#if server.oauth?.authorized && !server.oauth.expired}
                        <span aria-hidden="true">·</span>
                        <span class="text-[var(--color-success)]">
                          authorized{#if server.oauth.scope} · {server.oauth.scope}{/if}
                        </span>
                      {/if}
                    </div>
                  </div>
                  <div class="-mr-1 flex shrink-0 flex-wrap gap-0.5">
                    <button
                      type="button"
                      disabled={testingName === server.name}
                      onclick={() => void handleTest(server.name)}
                      class={ghostBtn}
                    >
                      {#if testingName === server.name}
                        <LoaderCircle size={13} class="animate-spin" /> Testing…
                      {:else}
                        <Plug size={13} /> Test
                      {/if}
                    </button>
                    <button
                      type="button"
                      disabled={mcpServersStore.loading}
                      onclick={() => void handleReload(server.name)}
                      class={ghostBtn}
                    >
                      <RefreshCw size={13} /> Reload
                    </button>
                    <button type="button" onclick={() => void startEdit(server)} class={ghostBtn}>
                      <Pencil size={13} /> Edit
                    </button>
                    {#if server.transport !== 'stdio' && server.oauth?.authorized}
                      <button
                        type="button"
                        onclick={() => void handleDisconnect(server.name)}
                        class={ghostBtn}
                      >
                        <LogOut size={13} /> Disconnect
                      </button>
                    {/if}
                    <button
                      type="button"
                      onclick={() => confirmRemove(server.name)}
                      class={dangerBtn}
                    >
                      <Trash2 size={13} /> Remove
                    </button>
                  </div>
                </div>
                    {#if server.transport !== 'stdio' && authKind(server) !== 'none'}
                      {@const kind = authKind(server)}
                      <div
                        class="mt-3 rounded-xl p-3.5 {kind === 'oauth' || kind === 'manual'
                          ? 'bg-[var(--color-warning-bg)]'
                          : 'bg-[var(--color-surface-2)]'}"
                      >
                        <div class="flex items-start gap-2">
                          <KeyRound size={14} class="mt-0.5 shrink-0 text-[var(--color-text-secondary)]" />
                          <div class="min-w-0 flex-1">
                            <p class="text-xs font-semibold text-[var(--color-text-primary)]">
                              {#if kind === 'oauth'}
                                Sign-in required
                              {:else if kind === 'manual'}
                                Needs your own app
                              {:else if kind === 'headers'}
                                Credential required
                              {:else}
                                Sign-in required
                              {/if}
                            </p>
                            <p class="mt-1 text-xs leading-relaxed text-[var(--color-text-secondary)]">
                              {server.auth?.detail ?? 'This server needs a credential before it can be used.'}
                            </p>
                          </div>
                        </div>

                        {#if manualClientFor === server.name}
                          <div class="mt-3 space-y-3 pl-[22px]">
                            <p class="text-xs leading-relaxed text-[var(--color-text-secondary)]">
                              Paste the credentials from the app you created. Koryphaios stores them
                              in its own secret store, never in your project config.
                            </p>
                            <div>
                              <label
                                for={`mcp-client-id-${server.name}`}
                                class="mb-1.5 block text-xs font-medium text-[var(--color-text-secondary)]"
                              >
                                Client ID
                              </label>
                              <input
                                id={`mcp-client-id-${server.name}`}
                                type="text"
                                bind:value={manualClientId}
                                placeholder="e.g. 1234567890.987654321"
                                class="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-1)] px-3 py-2 font-mono text-xs text-[var(--color-text-primary)] outline-none transition-all placeholder:text-[var(--color-text-muted)] focus-visible:border-[var(--color-accent)]"
                              />
                            </div>
                            <div>
                              <label
                                for={`mcp-client-secret-${server.name}`}
                                class="mb-1.5 block text-xs font-medium text-[var(--color-text-secondary)]"
                              >
                                Client secret (optional)
                              </label>
                              <input
                                id={`mcp-client-secret-${server.name}`}
                                type="password"
                                bind:value={manualClientSecret}
                                placeholder="Only for apps that have one"
                                class="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-1)] px-3 py-2 font-mono text-xs text-[var(--color-text-primary)] outline-none transition-all placeholder:text-[var(--color-text-muted)] focus-visible:border-[var(--color-accent)]"
                              />
                            </div>
                            {#if manualClientError}
                              <p class="text-xs text-[var(--color-error)]">{manualClientError}</p>
                            {/if}
                            <div class="flex items-center justify-end gap-2">
                              <button type="button" onclick={closeManualClientForm} class={ghostBtn}>
                                Cancel
                              </button>
                              <button
                                type="button"
                                onclick={() => void submitManualClient(server.name)}
                                class={primaryBtn}
                              >
                                <KeyRound size={13} /> Authorize
                              </button>
                            </div>
                          </div>
                        {:else if needsManualClient(server)}
                          <button
                            type="button"
                            onclick={() => openManualClientForm(server.name)}
                            class="mt-3 ml-[22px] {softSurfaceBtn}"
                          >
                            <KeyRound size={13} /> Enter app credentials
                          </button>
                        {:else if kind === 'headers'}
                          <button
                            type="button"
                            onclick={() => startEdit(server)}
                            class="mt-3 ml-[22px] {softSurfaceBtn}"
                          >
                            <Pencil size={13} /> Add credential
                          </button>
                        {:else if kind === 'unknown'}
                          <button
                            type="button"
                            onclick={() => startEdit(server)}
                            class="mt-3 ml-[22px] {softSurfaceBtn}"
                          >
                            <Pencil size={13} /> Configure headers
                          </button>
                        {:else}
                          <button
                            type="button"
                            disabled={awaitingConsent === server.name}
                            onclick={() => void handleAuthorize(server.name)}
                            class="mt-3 ml-[22px] {primaryBtn}"
                          >
                            {#if awaitingConsent === server.name}
                              <LoaderCircle size={13} class="animate-spin" /> Waiting for consent…
                            {:else}
                              <KeyRound size={13} /> Authorize
                            {/if}
                          </button>
                        {/if}
                      </div>
                    {/if}
                    {#if server.lastError}
                      <p class="mt-2 text-xs leading-relaxed text-[var(--color-error)]">
                        {server.lastError}
                      </p>
                    {/if}
                    {#if testResult[server.name]}
                      {@const result = testResult[server.name]}
                      {#if result}
                        <div class="mt-3">
                          <div class="flex items-center gap-2 text-xs">
                            {#if result.connected}
                              <Check size={13} class="text-[var(--color-success)]" />
                              <span class="text-[var(--color-text-primary)]"
                                >Connected · {result.tools.length} tool{result.tools.length === 1
                                  ? ''
                                  : 's'}</span
                              >
                            {:else}
                              <X size={13} class="text-[var(--color-error)]" />
                              <span class="text-[var(--color-text-primary)]">Not connected</span>
                            {/if}
                          </div>
                          {#if result.error}
                            <p class="mt-1.5 text-xs leading-relaxed text-[var(--color-error)]">
                              {result.error}
                            </p>
                          {/if}
                          {#if result.tools.length > 0}
                            <div class="mt-2 flex flex-wrap gap-1.5">
                              {#each result.tools.slice(0, 12) as tool}
                                <span
                                  class="rounded-md bg-[var(--color-surface-2)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--color-text-secondary)]"
                                >
                                  {tool}
                                </span>
                              {/each}
                              {#if result.tools.length > 12}
                                <span class="py-0.5 text-[11px] text-[var(--color-text-muted)]">
                                  +{result.tools.length - 12} more
                                </span>
                              {/if}
                            </div>
                          {/if}
                        </div>
                      {/if}
                    {/if}
                </div>
              </section>
            {/each}
          </div>
        {/if}
      {:else if view === 'browse'}
        <!-- ─── Browse registry view ──────────────────────────────────── -->
        <section class="space-y-5">
          <div class="flex items-start justify-between gap-3">
            <div>
              <h4 class="text-sm font-semibold text-[var(--color-text-primary)]">
                Browse MCP registry
              </h4>
              <p class="mt-1 text-xs leading-relaxed text-[var(--color-text-muted)]">
                Choose a featured server or search the registry.
              </p>
            </div>
            <button
              type="button"
              onclick={closeBrowse}
              class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-3)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/60"
              aria-label="Close browse"
            >
              <X size={16} />
            </button>
          </div>

          <!-- Search bar -->
          <form
            onsubmit={(e) => {
              e.preventDefault();
              handleRegistrySearch();
            }}
            class="flex items-center gap-2"
          >
            <div class="relative min-w-0 flex-1">
              <Search
                size={15}
                class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]"
              />
              <input
                type="text"
                bind:value={registrySearchInput}
                aria-label="Search MCP registry"
                placeholder="Search servers…"
                class="h-10 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-1)] pl-9 pr-4 text-sm text-[var(--color-text-primary)] outline-none transition-all placeholder:text-[var(--color-text-muted)] focus-visible:border-[var(--color-accent)]"
              />
            </div>
            <button
              type="submit"
              disabled={mcpServersStore.registrySearching}
              class="{primaryBtn} min-h-10 px-4"
            >
              {#if mcpServersStore.registrySearching}
                <LoaderCircle size={13} class="animate-spin" /> Searching…
              {:else}
                <Search size={13} /> Search
              {/if}
            </button>
          </form>

          <!-- Search results -->
          {#if mcpServersStore.registryError}
            <div class="flex items-start gap-3 rounded-xl bg-[var(--color-error-bg)] p-4">
              <AlertTriangle size={16} class="mt-0.5 shrink-0 text-[var(--color-error)]" />
              <p class="text-xs leading-relaxed text-[var(--color-text-secondary)]">
                {mcpServersStore.registryError}
              </p>
            </div>
          {:else if mcpServersStore.registrySearching && mcpServersStore.registryResults.length === 0}
            <div
              class="flex min-h-32 items-center justify-center gap-2 text-sm text-[var(--color-text-muted)]"
            >
              <LoaderCircle size={16} class="animate-spin" /> Searching the registry…
            </div>
          {:else if mcpServersStore.registryResults.length === 0 && featuredGroups.length > 0}
            <!-- ─── Featured (curated) catalog ─────────────────────────── -->
            <div class="space-y-6">
              {#each featuredGroups as group (group.category)}
                <div>
                  <h5
                    class="mb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-muted)]"
                  >
                    {group.category}
                  </h5>
                  <div class="-mx-3 space-y-0.5">
                    {#each group.servers as result (result.id)}
                      {@render registryRow(result)}
                    {/each}
                  </div>
                </div>
              {/each}
            </div>
          {:else if mcpServersStore.registryResults.length === 0}
            <div class="px-4 py-12 text-center">
              <Search size={26} class="mx-auto text-[var(--color-text-muted)]" />
              <h4 class="mt-3 text-sm font-semibold text-[var(--color-text-primary)]">
                {mcpServersStore.registryQuery ? 'No servers found' : 'Search for MCP servers'}
              </h4>
              <p class="mt-1 text-xs text-[var(--color-text-muted)]">
                {mcpServersStore.registryQuery
                  ? `No results for "${mcpServersStore.registryQuery}". Try a different keyword.`
                  : 'Type a keyword above to search the official MCP registry.'}
              </p>
            </div>
          {:else}
            <div class="-mx-3 space-y-0.5">
              {#each mcpServersStore.registryResults as result (result.id)}
                {@render registryRow(result)}
              {/each}
              {#if mcpServersStore.registryNextCursor}
                <div class="flex justify-center pt-3">
                  <button
                    type="button"
                    disabled={mcpServersStore.registrySearching}
                    onclick={loadMoreRegistry}
                    class={softBtn}
                  >
                    {#if mcpServersStore.registrySearching}
                      <LoaderCircle size={13} class="animate-spin" /> Loading…
                    {:else}
                      Load more
                    {/if}
                  </button>
                </div>
              {/if}
            </div>
          {/if}
        </section>
      {:else if view === 'form'}
        <!-- ─── Add / Edit form view ──────────────────────────────────── -->
        <section class="max-w-3xl space-y-4">
          <div class="flex items-start justify-between gap-3">
            <div>
              <h4 class="text-sm font-semibold text-[var(--color-text-primary)]">
                {editingName ? `Edit "${editingName}"` : 'Add MCP server'}
              </h4>
              <p class="mt-1 text-xs leading-relaxed text-[var(--color-text-muted)]">
                {editingName
                  ? 'Re-enter configuration fields. Existing env values are masked. Type a new value to replace them.'
                  : 'Run a local process (stdio) or connect to a remote endpoint (SSE).'}
              </p>
            </div>
            <button
              type="button"
              onclick={closeForm}
              class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-3)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/60"
              aria-label="Close form"
            >
              <X size={16} />
            </button>
          </div>

          <!-- Name -->
          <div>
            <label
              for="mcp-name"
              class="mb-1.5 block text-xs font-medium text-[var(--color-text-secondary)]"
            >
              Server name
            </label>
            <input
              id="mcp-name"
              type="text"
              bind:value={formName}
              placeholder="e.g. filesystem"
              disabled={!!editingName}
              class="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-2.5 text-sm text-[var(--color-text-primary)] outline-none transition-all placeholder:text-[var(--color-text-muted)] focus-visible:border-[var(--color-accent)] disabled:opacity-60"
            />
          </div>

          <!-- Transport type -->
          <div>
            <span class="mb-1.5 block text-xs font-medium text-[var(--color-text-secondary)]">
              Transport type
            </span>
            <KorySelect
              value={formType}
              options={transportOptions}
              label="Transport type"
              onchange={(value) => (formType = value as 'stdio' | 'sse')}
            />
          </div>

          {#if formType === 'stdio'}
            <!-- Command -->
            <div>
              <label
                for="mcp-command"
                class="mb-1.5 block text-xs font-medium text-[var(--color-text-secondary)]"
              >
                Command
              </label>
              <input
                id="mcp-command"
                type="text"
                bind:value={formCommand}
                placeholder="e.g. npx"
                class="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-2.5 text-sm text-[var(--color-text-primary)] outline-none transition-all placeholder:text-[var(--color-text-muted)] focus-visible:border-[var(--color-accent)]"
              />
            </div>
            <!-- Args -->
            <div>
              <label
                for="mcp-args"
                class="mb-1.5 block text-xs font-medium text-[var(--color-text-secondary)]"
              >
                Arguments
              </label>
              <p class="mb-1.5 text-xs text-[var(--color-text-muted)]">
                One argument per line.
              </p>
              <textarea
                id="mcp-args"
                bind:value={formArgs}
                rows="3"
                placeholder="-y&#10;@modelcontextprotocol/server-filesystem&#10;/tmp"
                class="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-2.5 font-mono text-sm text-[var(--color-text-primary)] outline-none transition-all placeholder:text-[var(--color-text-muted)] focus-visible:border-[var(--color-accent)]"
              ></textarea>
            </div>
          {:else}
            <!-- URL -->
            <div>
              <label
                for="mcp-url"
                class="mb-1.5 block text-xs font-medium text-[var(--color-text-secondary)]"
              >
                Server URL
              </label>
              <input
                id="mcp-url"
                type="text"
                bind:value={formUrl}
                placeholder="https://example.com/sse"
                class="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-2.5 text-sm text-[var(--color-text-primary)] outline-none transition-all placeholder:text-[var(--color-text-muted)] focus-visible:border-[var(--color-accent)]"
              />
            </div>
            <!-- Headers -->
            <div>
              <label
                for="mcp-headers"
                class="mb-1.5 block text-xs font-medium text-[var(--color-text-secondary)]"
              >
                Headers
              </label>
              <p class="mb-1.5 text-xs text-[var(--color-text-muted)]">
                One header per line, in <code>Key: Value</code> format.
              </p>
              <textarea
                id="mcp-headers"
                bind:value={formHeaders}
                rows="3"
                placeholder="Authorization: Bearer ..."
                class="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-2.5 font-mono text-sm text-[var(--color-text-primary)] outline-none transition-all placeholder:text-[var(--color-text-muted)] focus-visible:border-[var(--color-accent)]"
              ></textarea>
            </div>
          {/if}

          <!-- Env editor (stdio only) -->
          {#if formType === 'stdio'}
            <div>
              <div class="flex items-center justify-between">
                <span class="text-xs font-medium text-[var(--color-text-secondary)]">
                  Environment variables
                </span>
                <button
                  type="button"
                  onclick={addEnvRow}
                  class={ghostBtn}
                >
                  <Plus size={13} /> Add variable
                </button>
              </div>
              <p class="mb-2 mt-1 text-xs text-[var(--color-text-muted)]">
                Stored securely. Existing values are masked; enter a new value to replace one.
              </p>
              {#if envLoading}
                <div class="flex items-center gap-2 py-3 text-xs text-[var(--color-text-muted)]">
                  <LoaderCircle size={14} class="animate-spin" /> Loading env keys…
                </div>
              {:else if envRows.length > 0}
                <div class="space-y-2">
                  {#each envRows as row, index (index)}
                    <div class="flex items-center gap-2">
                      <input
                        type="text"
                        value={row.key}
                        placeholder="KEY"
                        oninput={(e) => updateEnvKey(index, e.currentTarget.value)}
                        class="min-w-0 flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 font-mono text-xs text-[var(--color-text-primary)] outline-none transition-all placeholder:text-[var(--color-text-muted)] focus-visible:border-[var(--color-accent)]"
                      />
                      <input
                        type="text"
                        value={row.masked ? '' : row.value}
                        placeholder={row.masked ? '••••••••' : 'value'}
                        oninput={(e) => updateEnvValue(index, e.currentTarget.value)}
                        class="min-w-0 flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 font-mono text-xs text-[var(--color-text-primary)] outline-none transition-all placeholder:text-[var(--color-text-muted)] focus-visible:border-[var(--color-accent)]"
                      />
                      <button
                        type="button"
                        onclick={() => removeEnvRow(index)}
                        class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[var(--color-border)] text-[var(--color-text-muted)] transition-colors hover:border-[var(--color-error)]/50 hover:text-[var(--color-error)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/60"
                        aria-label="Remove variable"
                      >
                        <X size={14} />
                      </button>
                    </div>
                  {/each}
                </div>
              {/if}
            </div>
          {/if}

          <!-- Form actions -->
          <div
            class="flex items-center justify-end gap-2 border-t border-[var(--color-border)] pt-4"
          >
            <button
              type="button"
              onclick={closeForm}
              class="{softBtn} min-h-10 px-4"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!formValid || formSaving}
              onclick={() => void handleSubmit()}
              class="{primaryBtn} min-h-10 px-4"
            >
              {#if formSaving}
                <LoaderCircle size={14} class="animate-spin" /> Saving…
              {:else}
                <Check size={14} /> {editingName ? 'Save changes' : 'Add server'}
              {/if}
            </button>
          </div>
        </section>
      {/if}
    </div>
</SettingsPage>

<ConfirmDialog
  open={removeTarget !== null}
  title="Remove MCP server?"
  message={`This will disconnect and delete the "${removeTarget ?? ''}" MCP server. This action cannot be undone.`}
  confirmLabel="Remove"
  variant="danger"
  onConfirm={() => void doRemove()}
  onCancel={() => (removeTarget = null)}
/>
