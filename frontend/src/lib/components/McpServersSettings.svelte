<script lang="ts">
  import { onMount } from 'svelte';
  import AlertTriangle from 'lucide-svelte/icons/alert-triangle';
  import Check from 'lucide-svelte/icons/check';
  import Globe from 'lucide-svelte/icons/globe';
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
  import KorySelect from './KorySelect.svelte';
  import SettingsPageIntro from './SettingsPageIntro.svelte';

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

  // ─── View state: "list" | "browse" | "form" ──────────────────────────────
  type McpView = 'list' | 'browse' | 'form';
  let view = $state<McpView>('list');
  let registrySearchInput = $state('');

  const transportOptions = [
    { value: 'stdio', label: 'stdio', description: 'Spawn a local process and communicate over stdin/stdout.' },
    { value: 'sse', label: 'SSE', description: 'Connect to a remote server over HTTP Server-Sent Events.' },
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
      // Pre-populate header placeholders as comments so the user knows what to set.
      if (result.headerVars.length > 0) {
        formHeaders = result.headerVars
          .map((h) => `# ${h.name}: ${h.description || 'set this value'}`)
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
    envRows = envRows.map((row, i) =>
      i === index ? { ...row, value, masked: false } : row,
    );
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
      const headers = parseHeaders(formHeaders);
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

  const formValid = $derived(formName.trim().length > 0);
</script>

<div class="flex h-full min-h-0 flex-col overflow-hidden">
  <SettingsPageIntro
    title="MCP servers"
    description="Manage pluggable Model Context Protocol tool servers. Connection status, tools, and protocol version are reported by the backend."
  >
    {#if view === 'list'}
      <div class="flex items-center gap-2">
        <button
          type="button"
          onclick={openBrowse}
          class="flex min-h-9 items-center gap-1.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 text-xs font-medium text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-accent)]/50 hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/60"
        >
          <Search size={13} /> Browse registry
        </button>
        <button
          type="button"
          onclick={openAddForm}
          class="flex min-h-9 items-center gap-1.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 text-xs font-medium text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-accent)]/50 hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/60"
        >
          <Plus size={13} /> Add manually
        </button>
      </div>
    {/if}
  </SettingsPageIntro>

  <div class="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
    <div class="mx-auto max-w-5xl space-y-5">
      {#if view === 'list'}
        {#if mcpServersStore.error && mcpServersStore.servers.length === 0}
          <section
            role="alert"
            class="flex items-start gap-3 rounded-2xl border border-[var(--color-error)]/35 bg-[var(--color-error-bg)] p-4"
          >
            <AlertTriangle size={18} class="mt-0.5 shrink-0 text-[var(--color-error)]" />
            <div class="min-w-0 flex-1">
              <h4 class="text-sm font-semibold text-[var(--color-text-primary)]">
                MCP servers unavailable
              </h4>
              <p class="mt-1 text-xs leading-relaxed text-[var(--color-text-muted)]">
                {mcpServersStore.error}
              </p>
            </div>
            <button
              type="button"
              disabled={mcpServersStore.loading}
              onclick={() => void mcpServersStore.loadAll()}
              class="flex min-h-10 shrink-0 items-center gap-2 rounded-xl border border-[var(--color-border)] px-3 text-xs text-[var(--color-text-secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/60 disabled:opacity-50"
            >
              <RefreshCw size={14} /> Retry
            </button>
          </section>
        {:else if mcpServersStore.loading && mcpServersStore.servers.length === 0}
          <section
            role="status"
            class="flex min-h-40 items-center justify-center gap-2 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-1)] text-sm text-[var(--color-text-muted)]"
          >
            <RefreshCw size={16} class="animate-spin" /> Loading MCP servers…
          </section>
        {:else if mcpServersStore.servers.length === 0}
          <section
            class="rounded-2xl border border-dashed border-[var(--color-border)] bg-[var(--color-surface-1)] px-4 py-10 text-center"
          >
            <Server size={28} class="mx-auto text-[var(--color-text-muted)]" />
            <h4 class="mt-3 text-sm font-semibold text-[var(--color-text-primary)]">
              No MCP servers configured
            </h4>
            <p class="mt-1 text-xs text-[var(--color-text-muted)]">
              Browse the registry or add a server manually to expose external tools to your agents.
            </p>
            <div class="mt-4 flex flex-wrap items-center justify-center gap-2">
              <button
                type="button"
                onclick={openBrowse}
                class="inline-flex min-h-10 items-center gap-2 rounded-xl bg-[var(--color-accent)] px-4 text-xs font-semibold text-[var(--color-surface-1)] transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/60"
              >
                <Search size={14} /> Browse registry
              </button>
              <button
                type="button"
                onclick={openAddForm}
                class="inline-flex min-h-10 items-center gap-2 rounded-xl border border-[var(--color-border)] px-4 text-xs font-semibold text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-accent)]/50 hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/60"
              >
                <Plus size={14} /> Add manually
              </button>
            </div>
          </section>
        {:else}
          <div class="space-y-3">
            {#each mcpServersStore.servers as server (server.name)}
              <section
                class="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-1)] p-5"
              >
                <div class="flex flex-wrap items-start justify-between gap-3">
                  <div class="min-w-0 flex-1">
                    <div class="flex flex-wrap items-center gap-2">
                      <span
                        class="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[var(--color-surface-2)] text-[var(--color-text-secondary)]"
                      >
                        {#if server.transport === 'sse'}
                          <Globe size={15} />
                        {:else}
                          <Terminal size={15} />
                        {/if}
                      </span>
                      <h4 class="text-sm font-semibold text-[var(--color-text-primary)]">
                        {server.name}
                      </h4>
                      <span
                        class="rounded-full px-2 py-0.5 text-[10px] font-medium {server.connected
                          ? 'bg-[var(--color-success-bg)] text-[var(--color-success)]'
                          : 'bg-[var(--color-error-bg)] text-[var(--color-error)]'}"
                      >
                        {#if server.connected}
                          <span class="inline-flex items-center gap-1">
                            <Check size={10} /> Connected
                          </span>
                        {:else}
                          <span class="inline-flex items-center gap-1">
                            <X size={10} /> Disconnected
                          </span>
                        {/if}
                      </span>
                      <span
                        class="rounded-full bg-[var(--color-surface-3)] px-2 py-0.5 text-[10px] text-[var(--color-text-muted)]"
                      >
                        {server.transport}
                      </span>
                    </div>
                    <div class="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--color-text-muted)]">
                      <span>{server.toolCount} tool{server.toolCount === 1 ? '' : 's'}</span>
                      {#if server.protocolVersion}
                        <span>protocol {server.protocolVersion}</span>
                      {/if}
                    </div>
                    {#if server.lastError}
                      <p class="mt-2 text-xs leading-relaxed text-[var(--color-error)]">
                        {server.lastError}
                      </p>
                    {/if}
                    {#if testResult[server.name]}
                      {@const result = testResult[server.name]}
                      {#if result}
                        <div
                          class="mt-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3"
                        >
                          <div class="flex items-center gap-2 text-xs">
                            {#if result.connected}
                              <Check size={12} class="text-[var(--color-success)]" />
                              <span class="text-[var(--color-text-primary)]"
                                >Connected — {result.tools.length} tool{result.tools.length === 1 ? '' : 's'}</span
                              >
                            {:else}
                              <X size={12} class="text-[var(--color-error)]" />
                              <span class="text-[var(--color-text-primary)]">Not connected</span>
                            {/if}
                          </div>
                          {#if result.error}
                            <p class="mt-1.5 text-[10px] leading-relaxed text-[var(--color-error)]">
                              {result.error}
                            </p>
                          {/if}
                          {#if result.tools.length > 0}
                            <div class="mt-2 flex flex-wrap gap-1.5">
                              {#each result.tools.slice(0, 12) as tool}
                                <span
                                  class="rounded-md bg-[var(--color-surface-3)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-text-secondary)]"
                                >
                                  {tool}
                                </span>
                              {/each}
                              {#if result.tools.length > 12}
                                <span class="text-[10px] text-[var(--color-text-muted)]">
                                  +{result.tools.length - 12} more
                                </span>
                              {/if}
                            </div>
                          {/if}
                        </div>
                      {/if}
                    {/if}
                  </div>
                  <div class="flex shrink-0 flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={testingName === server.name}
                      onclick={() => void handleTest(server.name)}
                      class="flex min-h-9 items-center gap-1.5 rounded-xl border border-[var(--color-border)] px-3 text-xs text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-accent)]/50 hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/60 disabled:opacity-50"
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
                      class="flex min-h-9 items-center gap-1.5 rounded-xl border border-[var(--color-border)] px-3 text-xs text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-accent)]/50 hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/60 disabled:opacity-50"
                    >
                      <RefreshCw size={13} /> Reload
                    </button>
                    <button
                      type="button"
                      onclick={() => void startEdit(server)}
                      class="flex min-h-9 items-center gap-1.5 rounded-xl border border-[var(--color-border)] px-3 text-xs text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-accent)]/50 hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/60"
                    >
                      <Pencil size={13} /> Edit
                    </button>
                    <button
                      type="button"
                      onclick={() => confirmRemove(server.name)}
                      class="flex min-h-9 items-center gap-1.5 rounded-xl border border-[var(--color-border)] px-3 text-xs text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-error)]/50 hover:text-[var(--color-error)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/60"
                    >
                      <Trash2 size={13} /> Remove
                    </button>
                  </div>
                </div>
              </section>
            {/each}
          </div>
        {/if}
      {:else if view === 'browse'}
        <!-- ─── Browse registry view ──────────────────────────────────── -->
        <section class="space-y-4">
          <div class="flex items-start justify-between gap-3">
            <div>
              <h4 class="text-sm font-semibold text-[var(--color-text-primary)]">
                Browse MCP registry
              </h4>
              <p class="mt-1 text-xs leading-relaxed text-[var(--color-text-muted)]">
                Search the official MCP registry at registry.modelcontextprotocol.io to discover servers you can add.
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
                placeholder="Search servers (e.g. filesystem, github, slack…)"
                class="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] py-2.5 pl-9 pr-4 text-sm text-[var(--color-text-primary)] outline-none transition-all placeholder:text-[var(--color-text-muted)] focus-visible:border-[var(--color-accent)]/50 focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/60"
              />
            </div>
            <button
              type="submit"
              disabled={mcpServersStore.registrySearching}
              class="flex min-h-10 shrink-0 items-center gap-1.5 rounded-xl bg-[var(--color-accent)] px-4 text-xs font-semibold text-[var(--color-surface-1)] transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/60 disabled:cursor-not-allowed disabled:opacity-40"
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
            <div
              class="flex items-start gap-3 rounded-xl border border-[var(--color-error)]/35 bg-[var(--color-error-bg)] p-4"
            >
              <AlertTriangle size={16} class="mt-0.5 shrink-0 text-[var(--color-error)]" />
              <p class="text-xs leading-relaxed text-[var(--color-text-muted)]">
                {mcpServersStore.registryError}
              </p>
            </div>
          {:else if mcpServersStore.registrySearching && mcpServersStore.registryResults.length === 0}
            <div
              class="flex min-h-32 items-center justify-center gap-2 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-1)] text-sm text-[var(--color-text-muted)]"
            >
              <LoaderCircle size={16} class="animate-spin" /> Searching the registry…
            </div>
          {:else if mcpServersStore.registryResults.length === 0}
            <div
              class="rounded-2xl border border-dashed border-[var(--color-border)] bg-[var(--color-surface-1)] px-4 py-10 text-center"
            >
              <Search size={28} class="mx-auto text-[var(--color-text-muted)]" />
              <h4 class="mt-3 text-sm font-semibold text-[var(--color-text-primary)]">
                {mcpServersStore.registryQuery
                  ? 'No servers found'
                  : 'Search for MCP servers'}
              </h4>
              <p class="mt-1 text-xs text-[var(--color-text-muted)]">
                {mcpServersStore.registryQuery
                  ? `No results for "${mcpServersStore.registryQuery}". Try a different keyword.`
                  : 'Type a keyword above to search the official MCP registry.'}
              </p>
            </div>
          {:else}
            <div class="space-y-3">
              {#each mcpServersStore.registryResults as result (result.id)}
                <section
                  class="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-1)] p-4"
                >
                  <div class="flex flex-wrap items-start justify-between gap-3">
                    <div class="min-w-0 flex-1">
                      <div class="flex flex-wrap items-center gap-2">
                        <span
                          class="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[var(--color-surface-2)] text-[var(--color-text-secondary)]"
                        >
                          {#if result.transport === 'sse'}
                            <Globe size={15} />
                          {:else}
                            <Terminal size={15} />
                          {/if}
                        </span>
                        <h4 class="text-sm font-semibold text-[var(--color-text-primary)]">
                          {result.title}
                        </h4>
                        <span
                          class="rounded-full bg-[var(--color-surface-3)] px-2 py-0.5 text-[10px] text-[var(--color-text-muted)]"
                        >
                          {result.transport}
                        </span>
                        {#if result.version}
                          <span
                            class="text-[10px] text-[var(--color-text-muted)]"
                          >v{result.version}</span>
                          {/if}
                      </div>
                      <p class="mt-2 text-xs leading-relaxed text-[var(--color-text-muted)]">
                        {result.description}
                      </p>
                      {#if result.transport === 'stdio' && result.command}
                        <div class="mt-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 font-mono text-[10px] text-[var(--color-text-secondary)]">
                          {result.command} {result.args.join(' ')}
                        </div>
                      {:else if result.transport === 'sse' && result.url}
                        <div class="mt-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 font-mono text-[10px] text-[var(--color-text-secondary)]">
                          {result.url}
                        </div>
                      {/if}
                      {#if result.envVars.length > 0}
                        <div class="mt-2 flex flex-wrap gap-1.5">
                          {#each result.envVars as envVar}
                            <span
                              class="rounded-md bg-[var(--color-surface-3)] px-1.5 py-0.5 font-mono text-[10px] {envVar.isRequired ? 'text-[var(--color-warning)]' : 'text-[var(--color-text-muted)]'}"
                              title={envVar.description}
                            >
                              {envVar.name}{envVar.isRequired ? ' *' : ''}
                            </span>
                          {/each}
                        </div>
                      {/if}
                      <div class="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-[var(--color-text-muted)]">
                        {#if result.websiteUrl}
                          <a
                            href={result.websiteUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            class="transition-colors hover:text-[var(--color-accent)]"
                          >Website</a>
                        {/if}
                        {#if result.repositoryUrl}
                          <a
                            href={result.repositoryUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            class="transition-colors hover:text-[var(--color-accent)]"
                          >Repository</a>
                        {/if}
                      </div>
                    </div>
                    <button
                      type="button"
                      onclick={() => addFromRegistry(result)}
                      class="flex min-h-9 shrink-0 items-center gap-1.5 rounded-xl bg-[var(--color-accent)] px-3 text-xs font-semibold text-[var(--color-surface-1)] transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/60"
                    >
                      <Plus size={13} /> Add
                    </button>
                  </div>
                </section>
              {/each}
              {#if mcpServersStore.registryNextCursor}
                <div class="flex justify-center pt-2">
                  <button
                    type="button"
                    disabled={mcpServersStore.registrySearching}
                    onclick={loadMoreRegistry}
                    class="flex min-h-9 items-center gap-1.5 rounded-xl border border-[var(--color-border)] px-4 text-xs text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-accent)]/50 hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/60 disabled:opacity-50"
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
          <section
            class="space-y-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-1)] p-5"
          >
            <div class="flex items-start justify-between gap-3">
              <div>
                <h4 class="text-sm font-semibold text-[var(--color-text-primary)]">
                  {editingName ? `Edit "${editingName}"` : 'Add MCP server'}
                </h4>
                <p class="mt-1 text-xs leading-relaxed text-[var(--color-text-muted)]">
                  {editingName
                    ? 'Re-enter configuration fields. Existing env values are masked — type a new value to replace them.'
                    : 'Configure a stdio or SSE Model Context Protocol server.'}
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
              <label for="mcp-name" class="mb-1.5 block text-xs font-medium text-[var(--color-text-secondary)]">
                Server name
              </label>
              <input
                id="mcp-name"
                type="text"
                bind:value={formName}
                placeholder="e.g. filesystem"
                disabled={!!editingName}
                class="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-2.5 text-sm text-[var(--color-text-primary)] outline-none transition-all placeholder:text-[var(--color-text-muted)] focus-visible:border-[var(--color-accent)]/50 focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/60 disabled:opacity-60"
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
                <label for="mcp-command" class="mb-1.5 block text-xs font-medium text-[var(--color-text-secondary)]">
                  Command
                </label>
                <input
                  id="mcp-command"
                  type="text"
                  bind:value={formCommand}
                  placeholder="e.g. npx"
                  class="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-2.5 text-sm text-[var(--color-text-primary)] outline-none transition-all placeholder:text-[var(--color-text-muted)] focus-visible:border-[var(--color-accent)]/50 focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/60"
                />
              </div>
              <!-- Args -->
              <div>
                <label for="mcp-args" class="mb-1.5 block text-xs font-medium text-[var(--color-text-secondary)]">
                  Arguments
                </label>
                <p class="mb-1.5 text-[10px] text-[var(--color-text-muted)]">One argument per line.</p>
                <textarea
                  id="mcp-args"
                  bind:value={formArgs}
                  rows="3"
                  placeholder="-y&#10;@modelcontextprotocol/server-filesystem&#10;/tmp"
                  class="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-2.5 font-mono text-sm text-[var(--color-text-primary)] outline-none transition-all placeholder:text-[var(--color-text-muted)] focus-visible:border-[var(--color-accent)]/50 focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/60"
                ></textarea>
              </div>
            {:else}
              <!-- URL -->
              <div>
                <label for="mcp-url" class="mb-1.5 block text-xs font-medium text-[var(--color-text-secondary)]">
                  Server URL
                </label>
                <input
                  id="mcp-url"
                  type="text"
                  bind:value={formUrl}
                  placeholder="https://example.com/sse"
                  class="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-2.5 text-sm text-[var(--color-text-primary)] outline-none transition-all placeholder:text-[var(--color-text-muted)] focus-visible:border-[var(--color-accent)]/50 focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/60"
                />
              </div>
              <!-- Headers -->
              <div>
                <label for="mcp-headers" class="mb-1.5 block text-xs font-medium text-[var(--color-text-secondary)]">
                  Headers
                </label>
                <p class="mb-1.5 text-[10px] text-[var(--color-text-muted)]">One header per line, in <code>Key: Value</code> format.</p>
                <textarea
                  id="mcp-headers"
                  bind:value={formHeaders}
                  rows="3"
                  placeholder="Authorization: Bearer ..."
                  class="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-2.5 font-mono text-sm text-[var(--color-text-primary)] outline-none transition-all placeholder:text-[var(--color-text-muted)] focus-visible:border-[var(--color-accent)]/50 focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/60"
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
                    class="flex min-h-8 items-center gap-1 rounded-lg border border-[var(--color-border)] px-2.5 text-[10px] text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-accent)]/50 hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/60"
                  >
                    <Plus size={11} /> Add variable
                  </button>
                </div>
                <p class="mb-2 mt-1 text-[10px] text-[var(--color-text-muted)]">
                  Values are stored securely and never displayed. Existing keys show a masked placeholder — type a new value to replace.
                </p>
                {#if envLoading}
                  <div class="flex items-center gap-2 py-3 text-xs text-[var(--color-text-muted)]">
                    <LoaderCircle size={14} class="animate-spin" /> Loading env keys…
                  </div>
                {:else if envRows.length === 0}
                  <div
                    class="rounded-xl border border-dashed border-[var(--color-border)] bg-[var(--color-surface-2)] px-4 py-4 text-center text-[10px] text-[var(--color-text-muted)]"
                  >
                    No environment variables configured.
                  </div>
                {:else}
                  <div class="space-y-2">
                    {#each envRows as row, index (index)}
                      <div class="flex items-center gap-2">
                        <input
                          type="text"
                          value={row.key}
                          placeholder="KEY"
                          oninput={(e) => updateEnvKey(index, e.currentTarget.value)}
                          class="min-w-0 flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 font-mono text-xs text-[var(--color-text-primary)] outline-none transition-all placeholder:text-[var(--color-text-muted)] focus-visible:border-[var(--color-accent)]/50 focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/60"
                        />
                        <input
                          type="text"
                          value={row.masked ? '' : row.value}
                          placeholder={row.masked ? '••••••••' : 'value'}
                          oninput={(e) => updateEnvValue(index, e.currentTarget.value)}
                          class="min-w-0 flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 font-mono text-xs text-[var(--color-text-primary)] outline-none transition-all placeholder:text-[var(--color-text-muted)] focus-visible:border-[var(--color-accent)]/50 focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/60"
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
            <div class="flex items-center justify-end gap-2 border-t border-[var(--color-border)] pt-4">
              <button
                type="button"
                onclick={closeForm}
                class="flex min-h-10 items-center gap-2 rounded-xl border border-[var(--color-border)] px-4 text-xs font-medium text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/60"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!formValid || formSaving}
                onclick={() => void handleSubmit()}
                class="flex min-h-10 items-center gap-2 rounded-xl bg-[var(--color-accent)] px-4 text-xs font-semibold text-[var(--color-surface-1)] transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/60 disabled:cursor-not-allowed disabled:opacity-40"
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
  </div>
</div>

<ConfirmDialog
  open={removeTarget !== null}
  title="Remove MCP server?"
  message={`This will disconnect and delete the "${removeTarget ?? ''}" MCP server. This action cannot be undone.`}
  confirmLabel="Remove"
  variant="danger"
  onConfirm={() => void doRemove()}
  onCancel={() => (removeTarget = null)}
/>
