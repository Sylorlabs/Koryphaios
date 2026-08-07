// Native CLI slash command store.
//
// When the active manager is a CLI-backed provider (Claude Code, Codex, Devin,
// Grok Build, Cursor, Cline, Antigravity, Kimi Code), the composer surfaces
// that harness's own /commands in the slash picker and dispatches them to the
// backend, which runs a real headless equivalent (or surfaces an attributed
// note) and streams the reply back as `native.command` WebSocket events.

import { apiFetch, parseJsonResponse } from '$lib/api.svelte';
import { apiUrl } from '$lib/utils/api-url';

/** A native /command the user can invoke from the composer. */
export interface NativeSlashCommand {
  command: string;
  aliases?: string[];
  description: string;
  category: string;
  argsHint?: string;
}

interface NativeCommandsResponse {
  ok?: boolean;
  error?: string;
  data?: {
    provider: string | null;
    label: string | null;
    commands: NativeSlashCommand[];
  };
}

/** Providers that expose a native slash-command surface. */
export const NATIVE_CLI_PROVIDERS = new Set([
  'claude',
  'codex',
  'devin',
  'grok',
  'cursor',
  'cline',
  'antigravity',
  'kimicode',
]);

/** Extract the provider id from a composer model selection ("claude:sonnet"). */
export function providerFromModel(model: string | undefined | null): string {
  if (!model) return '';
  if (model === 'auto') return '';
  const sep = model.indexOf(':');
  return sep === -1 ? '' : model.slice(0, sep);
}

// Cache by provider so switching models doesn't refetch.
const cache = new Map<string, { label: string; commands: NativeSlashCommand[] }>();
let fetching = new Set<string>();

export const nativeCommandsStore = {
  /** Load the native command list for a provider (cached). Returns null for
   *  non-CLI providers. Reactive via $state. */
  async load(provider: string): Promise<{ label: string; commands: NativeSlashCommand[] } | null> {
    if (!provider || !NATIVE_CLI_PROVIDERS.has(provider)) return null;
    const cached = cache.get(provider);
    if (cached) return cached;
    if (fetching.has(provider)) {
      // Another in-flight load; wait briefly and return cache or null.
      await new Promise((r) => setTimeout(r, 50));
      return cache.get(provider) ?? null;
    }
    fetching.add(provider);
    try {
      const res = await apiFetch(apiUrl(`/api/native-commands?provider=${encodeURIComponent(provider)}`));
      const json = await parseJsonResponse<NativeCommandsResponse>(res);
      if (!json.ok || !json.data || !json.data.provider) return null;
      const entry = {
        label: json.data.label ?? provider,
        commands: json.data.commands ?? [],
      };
      cache.set(provider, entry);
      return entry;
    } catch (err: unknown) {
      console.warn(`Failed to load native commands for ${provider}:`, err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      fetching.delete(provider);
    }
  },

  /** Dispatch a native /command to the backend for execution. Output streams
   *  back over WebSocket as `native.command` events attributed to the provider. */
  async run(sessionId: string, command: string, model?: string): Promise<boolean> {
    try {
      const res = await apiFetch(apiUrl('/api/native-commands/run'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, command, model }),
      });
      const json = await parseJsonResponse<{ ok?: boolean; error?: string }>(res);
      return !!json.ok;
    } catch (err: unknown) {
      console.warn('Failed to run native command:', err instanceof Error ? err.message : String(err));
      return false;
    }
  },

  /** Clear the cache (e.g. after a CLI reinstall). */
  invalidate(provider?: string): void {
    if (provider) cache.delete(provider);
    else cache.clear();
  },
};
