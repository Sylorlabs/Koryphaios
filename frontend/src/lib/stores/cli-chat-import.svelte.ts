/**
 * CLI chat import discovery cache.
 *
 * Scanning every CLI's chat storage takes several seconds on a machine with a
 * real history, so the scan must not wait for the "Port chats" step (or the
 * Manager feed's import panel) to render. `prefetch()` starts discovery once and
 * every caller shares the same in-flight request; `refresh()` is the explicit
 * Rescan. Panels render from this store, so the onboarding walkthrough can warm
 * it on open and step 6 shows its data immediately.
 *
 * Selection is deliberately not here: it is per-panel UI state.
 */
import { apiFetch } from '$lib/api.svelte';
import { apiUrl } from '$lib/utils/api-url';

export interface CliProviderScanSummary {
  id: string;
  provider: string;
  displayName: string;
  checked: boolean;
  storageFound: boolean;
  checkedPaths: string[];
  chatCount: number;
  projectCount: number;
}

export interface DiscoveredCliChatMessage {
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
  model?: string;
}

export interface DiscoveredCliChat {
  id: string;
  externalId: string;
  provider: string;
  providerDisplayName: string;
  projectPath: string;
  projectName: string;
  title: string;
  preview: string;
  model?: string;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
  alreadyImported: boolean;
  importedSessionId?: string;
  sampleMessages: DiscoveredCliChatMessage[];
}

export interface DiscoveredCliProjectGroup {
  projectPath: string;
  projectName: string;
  chatCount: number;
  providers: Array<{
    provider: string;
    displayName: string;
    chatCount: number;
  }>;
  latestUpdatedAt: number;
  chats: DiscoveredCliChat[];
}

export interface CliChatImportResult {
  importedCount: number;
  alreadyImportedCount: number;
  items: Array<{ chatId: string; sessionId: string; status?: string }>;
}

class CliChatImportStore {
  providers = $state<CliProviderScanSummary[]>([]);
  projects = $state<DiscoveredCliProjectGroup[]>([]);
  loading = $state(false);
  error = $state<string | null>(null);
  /** Epoch ms of the last successful discovery; null until one resolves. */
  loadedAt = $state<number | null>(null);

  #inflight: Promise<void> | null = null;
  #generation = 0;

  get hasLoaded(): boolean {
    return this.loadedAt !== null;
  }

  /** Start discovery once. No-op when data is loaded; joins a scan already running. */
  prefetch(): Promise<void> {
    if (this.loadedAt !== null) return Promise.resolve();
    return this.#load();
  }

  /** Forced rescan. Joins a scan already running rather than starting a second one. */
  refresh(): Promise<void> {
    return this.#load();
  }

  #load(): Promise<void> {
    if (this.#inflight) return this.#inflight;
    const generation = this.#generation;
    this.loading = true;
    this.error = null;
    const run = (async () => {
      try {
        const res = await apiFetch(apiUrl('/api/cli-chat-import/discover'));
        if (!res.ok) throw new Error(`Discovery failed (${res.status})`);
        const body = (await res.json()) as {
          data?: {
            providers?: CliProviderScanSummary[];
            projects?: DiscoveredCliProjectGroup[];
          };
        };
        if (generation !== this.#generation) return;
        this.providers = body.data?.providers ?? [];
        this.projects = body.data?.projects ?? [];
        this.loadedAt = Date.now();
      } catch (err) {
        if (generation !== this.#generation) return;
        this.error = err instanceof Error ? err.message : 'Could not scan local CLI chats.';
      } finally {
        if (generation === this.#generation) {
          this.loading = false;
          this.#inflight = null;
        }
      }
    })();
    this.#inflight = run;
    return run;
  }

  /**
   * Port chats into Koryphaios. On success the cached discovery marks them as
   * imported, so every mounted panel reflects it without a rescan.
   */
  async importChats(chatIds: readonly string[]): Promise<CliChatImportResult> {
    const ids = [...new Set(chatIds)];
    if (ids.length === 0) return { importedCount: 0, alreadyImportedCount: 0, items: [] };
    const res = await apiFetch(apiUrl('/api/cli-chat-import/import'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatIds: ids }),
    });
    if (!res.ok) throw new Error(`Import failed (${res.status})`);
    const body = (await res.json()) as { data?: Partial<CliChatImportResult> };
    const result: CliChatImportResult = {
      importedCount: body.data?.importedCount ?? 0,
      alreadyImportedCount: body.data?.alreadyImportedCount ?? 0,
      items: body.data?.items ?? [],
    };
    const sessionByChat = new Map(result.items.map((item) => [item.chatId, item.sessionId]));
    const requested = new Set(ids);
    this.projects = this.projects.map((group) => ({
      ...group,
      chats: group.chats.map((chat) =>
        sessionByChat.has(chat.id) || requested.has(chat.id)
          ? {
              ...chat,
              alreadyImported: true,
              importedSessionId: sessionByChat.get(chat.id) ?? chat.importedSessionId,
            }
          : chat,
      ),
    }));
    return result;
  }

  /** Test seam: drop cached data and detach any scan still in flight. */
  reset(): void {
    this.#generation += 1;
    this.#inflight = null;
    this.providers = [];
    this.projects = [];
    this.loading = false;
    this.error = null;
    this.loadedAt = null;
  }
}

export const cliChatImportStore = new CliChatImportStore();
