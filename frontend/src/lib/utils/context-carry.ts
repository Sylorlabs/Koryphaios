import {
  hasOpaqueContextHarness,
  reconcileContextBreakdown,
  type ContextBreakdown,
} from '@koryphaios/shared';

/**
 * Carry the last known context composition across a model switch.
 *
 * The conversation does not change when the user picks another model: Kory's
 * system prompt, memory, skills, tools and chat are the same tokens, so the
 * meter can show them against the new model's window the moment the picker
 * closes. Only what belonged to the old route is dropped:
 * - the CLI runtime overhead, which is owned by that one CLI (kept only when
 *   the provider is unchanged), and
 * - cache figures, because a new model is a new prompt-cache identity.
 * The caller labels the result an estimate until a provider report lands.
 */
export function carryContextEstimate(
  previous: { used: number; breakdown?: ContextBreakdown; provider?: string },
  nextProvider: string,
): { used: number; breakdown?: ContextBreakdown } | null {
  const used = Math.max(0, Math.floor(previous.used || 0));
  if (used <= 0) return null;
  // Without a composition there is nothing route-independent to separate out;
  // the total itself is the best available estimate of the conversation.
  if (!previous.breakdown) return { used };
  const reconciled = reconcileContextBreakdown(previous.breakdown, used, previous.provider);
  const keepHarness =
    previous.provider === nextProvider && hasOpaqueContextHarness(nextProvider);
  const breakdown: ContextBreakdown = {
    system: reconciled.system,
    memory: reconciled.memory,
    skills: reconciled.skills,
    tools: reconciled.tools,
    chat: reconciled.chat,
    output: reconciled.output,
    ...(keepHarness && reconciled.cliHarness ? { cliHarness: reconciled.cliHarness } : {}),
    ...(reconciled.request ? { request: reconciled.request } : {}),
  };
  const carried =
    breakdown.system +
    breakdown.memory +
    breakdown.skills +
    breakdown.tools +
    breakdown.chat +
    breakdown.output +
    (breakdown.cliHarness ?? 0) +
    (breakdown.request ?? 0);
  return carried > 0 ? { used: carried, breakdown } : null;
}

// ─── Local snapshot ─────────────────────────────────────────────────────────
// The meter's last known reading per chat, kept on this device so a reopened
// chat paints its context immediately instead of waiting on provider discovery
// or a backend round trip. It is always displayed as an estimate and replaced
// by the first authoritative report.

export interface PersistedManagerContext {
  provider: string;
  model: string;
  tokensUsed: number;
  contextMax: number;
  contextKnown: boolean;
  contextBreakdown?: ContextBreakdown;
  savedAt: number;
}

const STORAGE_KEY = 'koryphaios-context-meter-v1';
const MAX_ENTRIES = 100;

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function readAll(): Record<string, PersistedManagerContext> {
  const store = storage();
  if (!store) return {};
  try {
    const parsed = JSON.parse(store.getItem(STORAGE_KEY) ?? '{}') as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, PersistedManagerContext>)
      : {};
  } catch {
    return {};
  }
}

function writeAll(entries: Record<string, PersistedManagerContext>): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Quota or privacy mode: the meter simply waits for the backend.
  }
}

function isPersisted(value: unknown): value is PersistedManagerContext {
  const v = value as PersistedManagerContext | undefined;
  return (
    !!v &&
    typeof v.provider === 'string' &&
    !!v.provider &&
    typeof v.model === 'string' &&
    !!v.model &&
    typeof v.tokensUsed === 'number' &&
    Number.isFinite(v.tokensUsed) &&
    v.tokensUsed > 0 &&
    typeof v.contextMax === 'number' &&
    Number.isFinite(v.contextMax)
  );
}

export function readPersistedManagerContext(sessionId: string): PersistedManagerContext | null {
  if (!sessionId) return null;
  const entry = readAll()[sessionId];
  return isPersisted(entry) ? entry : null;
}

export function writePersistedManagerContext(
  sessionId: string,
  entry: Omit<PersistedManagerContext, 'savedAt'>,
): void {
  if (!sessionId || !isPersisted({ ...entry, savedAt: 0 })) return;
  const entries = readAll();
  delete entries[sessionId];
  entries[sessionId] = { ...entry, savedAt: Date.now() };
  const keys = Object.keys(entries);
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES))) delete entries[key];
  writeAll(entries);
}

export function forgetPersistedManagerContext(sessionId: string): void {
  if (!sessionId) return;
  const entries = readAll();
  if (!(sessionId in entries)) return;
  delete entries[sessionId];
  writeAll(entries);
}
