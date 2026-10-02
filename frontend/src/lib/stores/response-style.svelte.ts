import { apiFetch } from '$lib/api.svelte';
import { apiUrl } from '$lib/utils/api-url';
import { toastStore } from './toast.svelte';

/**
 * The user's response style: a personal Kory skill (not project-scoped) that
 * is pinned on every manager turn. Edited through a plain markdown body; the
 * backend keeps the skill frontmatter contract intact.
 */
export interface ResponseStyle {
  name: string;
  path: string;
  instructions: string;
  isDefault: boolean;
  valid: boolean;
  errors: string[];
}

const ENDPOINT = '/api/agent/response-style';

function createResponseStyleStore() {
  let style = $state<ResponseStyle | null>(null);
  let loading = $state(false);
  let saving = $state(false);
  let error = $state<string | null>(null);
  let loaded = $state(false);

  async function readPayload(res: Response): Promise<ResponseStyle> {
    const data = (await res.json()) as { ok?: boolean; data?: ResponseStyle; error?: string };
    if (!res.ok || !data.ok || !data.data) {
      throw new Error(data.error || `Response style request failed (${res.status})`);
    }
    return data.data;
  }

  async function load(): Promise<void> {
    loading = true;
    error = null;
    try {
      style = await readPayload(await apiFetch(apiUrl(ENDPOINT)));
      loaded = true;
    } catch (err) {
      error = err instanceof Error ? err.message : 'Could not load response style';
    } finally {
      loading = false;
    }
  }

  async function save(instructions: string, options?: { quiet?: boolean }): Promise<boolean> {
    saving = true;
    error = null;
    try {
      style = await readPayload(
        await apiFetch(apiUrl(ENDPOINT), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ instructions }),
        }),
      );
      loaded = true;
      if (!options?.quiet) toastStore.success('Response style saved to your personal skills');
      return true;
    } catch (err) {
      error = err instanceof Error ? err.message : 'Could not save response style';
      toastStore.error(error);
      return false;
    } finally {
      saving = false;
    }
  }

  async function reset(): Promise<boolean> {
    saving = true;
    error = null;
    try {
      style = await readPayload(await apiFetch(apiUrl(`${ENDPOINT}/reset`), { method: 'POST' }));
      loaded = true;
      toastStore.success('Response style reset to the Koryphaios default');
      return true;
    } catch (err) {
      error = err instanceof Error ? err.message : 'Could not reset response style';
      toastStore.error(error);
      return false;
    } finally {
      saving = false;
    }
  }

  return {
    get style() {
      return style;
    },
    get loading() {
      return loading;
    },
    get saving() {
      return saving;
    },
    get error() {
      return error;
    },
    get loaded() {
      return loaded;
    },
    load,
    save,
    reset,
  };
}

export const responseStyleStore = createResponseStyleStore();
