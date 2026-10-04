import { ValidationError } from '../errors/types';
import { serverLog } from '../logger';
import {
  isCapabilityProviderConfigured,
  requireCapabilityConfig,
} from '../providers/capability-service';
import {
  capabilityAdapterProviders,
  getCapabilityAdapter,
  type CapabilityMemoryAdapter,
  type CapabilityMemoryRecord,
} from '../providers/capabilities';
import type { MemorySettings } from './unified-memory';

/**
 * Optional external long-term memory.
 *
 * Local memory files remain the source of truth. Mem0 and Letta are additive:
 * they let an agent remember across machines and restarts, but every operation
 * here is best-effort and failure-tolerant, because local recall must keep
 * working when the external provider is down, rate-limited, or unconfigured.
 *
 * Callers pass the already-loaded `MemorySettings` rather than re-reading them,
 * so a request cannot act on settings loaded before an edit landed.
 */

export interface ExternalMemoryProviderStatus {
  provider: string;
  /** The provider implements a memory adapter. */
  supported: boolean;
  /** A credential is present in the provider registry. */
  connected: boolean;
  /** Selected as the external memory provider in memory settings. */
  selected: boolean;
  /** Scope key that will be sent with writes and searches. */
  scope: string;
  /** True when a scope is required before the provider can be used. */
  scopeRequired: boolean;
}

/** Mem0 scopes by user id; Letta scopes by agent id and must be supplied. */
const SCOPE_REQUIRED = new Set(['letta']);

/** Mem0 needs a concrete entity id, so supply a stable local default. */
const MEM0_DEFAULT_SCOPE = 'koryphaios-local';

export function externalMemoryStatus(settings: MemorySettings): ExternalMemoryProviderStatus[] {
  return capabilityAdapterProviders()
    .map((provider) => {
      const adapter = getCapabilityAdapter(provider);
      const supported = Boolean(adapter?.memory);
      return {
        provider,
        supported,
        connected: supported && isCapabilityProviderConfigured(provider),
        selected: provider === settings.externalMemoryProvider,
        scope: settings.externalMemoryScope,
        scopeRequired: SCOPE_REQUIRED.has(provider),
      };
    })
    .filter((entry) => entry.supported);
}

interface ResolvedExternal {
  provider: string;
  memory: CapabilityMemoryAdapter;
  scope: string;
}

/**
 * Resolve the provider to use. Returns `null` when external memory is off or
 * the chosen provider is not connected — callers then skip the operation
 * entirely rather than reporting an error.
 */
function resolveExternal(
  settings: MemorySettings,
  providerOverride?: string,
): ResolvedExternal | null {
  const provider = providerOverride?.trim() || settings.externalMemoryProvider;
  if (!provider) return null;
  if (!settings.externalMemoryEnabled) return null;
  const known = externalMemoryStatus(settings).some(
    (entry) => entry.provider === provider && entry.connected,
  );
  if (!known) return null;
  let memory: CapabilityMemoryAdapter | undefined;
  try {
    memory = requireCapabilityConfig(provider).adapter.memory;
  } catch {
    return null;
  }
  if (!memory) return null;
  const scope = settings.externalMemoryScope.trim() || defaultScope(provider);
  if (SCOPE_REQUIRED.has(provider) && !scope) {
    throw new ValidationError(
      `${provider} needs a scope before it can store memories. Set the memory scope in Settings > Memory.`,
    );
  }
  return { provider, memory, scope };
}

function defaultScope(provider: string): string {
  return provider === 'mem0' ? MEM0_DEFAULT_SCOPE : '';
}

export async function externalMemoryAdd(
  settings: MemorySettings,
  input: { text: string; provider?: string; scope?: string; metadata?: Record<string, unknown> },
): Promise<CapabilityMemoryRecord[]> {
  if (!input.text.trim()) throw new ValidationError('Memory text is required.');
  const resolved = resolveExternal(settings, input.provider);
  if (!resolved) return [];
  const records = await resolved.memory.add(requireCapabilityConfig(resolved.provider).config, {
    text: input.text,
    scope: input.scope?.trim() || resolved.scope,
    metadata: input.metadata,
  });
  return records.filter((record) => record.text);
}

export async function externalMemorySearch(
  settings: MemorySettings,
  input: { query: string; provider?: string; scope?: string; limit?: number; signal?: AbortSignal },
): Promise<CapabilityMemoryRecord[]> {
  if (!input.query.trim()) throw new ValidationError('Memory search text is required.');
  const resolved = resolveExternal(settings, input.provider);
  if (!resolved) return [];
  return resolved.memory.search(
    requireCapabilityConfig(resolved.provider).config,
    {
      query: input.query,
      scope: input.scope?.trim() || resolved.scope,
      limit: Math.max(1, Math.min(input.limit ?? 10, 100)),
    },
    input.signal,
  );
}

export async function externalMemoryForget(
  settings: MemorySettings,
  input: { ids: string[]; provider?: string },
): Promise<number> {
  const ids = input.ids.filter((id) => id.trim());
  if (!ids.length) throw new ValidationError('No memory ids were supplied.');
  const resolved = resolveExternal(settings, input.provider);
  if (!resolved?.memory.delete) return 0;
  return resolved.memory.delete(requireCapabilityConfig(resolved.provider).config, { ids });
}

/**
 * Recall for agent context assembly.
 *
 * Never throws: an external provider outage degrades to "no external
 * memories" rather than failing the turn that is building its prompt.
 */
export async function recallExternalMemories(
  settings: MemorySettings,
  query: string,
  options: { limit?: number; signal?: AbortSignal } = {},
): Promise<CapabilityMemoryRecord[]> {
  if (!settings.externalMemoryEnabled || !settings.externalMemoryInContext) return [];
  if (!query.trim()) return [];
  try {
    return await externalMemorySearch(settings, {
      query,
      limit: options.limit ?? 8,
      signal: options.signal,
    });
  } catch (err: unknown) {
    serverLog.debug(
      { err: err instanceof Error ? err.message : String(err) },
      'External memory recall skipped',
    );
    return [];
  }
}

/** Render recalled memories for prompt injection, bounded by a character budget. */
export function formatExternalMemories(records: CapabilityMemoryRecord[], maxChars = 2000): string {
  const lines: string[] = [];
  let used = 0;
  for (const record of records) {
    const text = record.text.trim();
    if (!text) continue;
    const line = `- ${text.length > 400 ? `${text.slice(0, 400)}…` : text}`;
    if (used + line.length > maxChars) break;
    lines.push(line);
    used += line.length;
  }
  return lines.join('\n');
}
