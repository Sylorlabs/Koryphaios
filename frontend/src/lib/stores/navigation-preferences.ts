/**
 * Small, device-local navigation preferences.
 *
 * These values deliberately contain no filesystem path or project metadata.
 * A stored session id is only a hint: `sessions.svelte.ts` validates it
 * against the authenticated backend session list before it can be selected.
 */

export type StoredSessionScope = 'project' | 'all';

const STORAGE_KEY = 'koryphaios-navigation-preferences-v1';

type NavigationPreferences = {
  lastSessionId?: string;
  sessionScope?: StoredSessionScope;
};

function readPreferences(storage: Storage | undefined = safeStorage()): NavigationPreferences {
  if (!storage) return {};
  try {
    const parsed = JSON.parse(storage.getItem(STORAGE_KEY) ?? '{}') as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    const value = parsed as Record<string, unknown>;
    return {
      ...(typeof value.lastSessionId === 'string' && value.lastSessionId.trim()
        ? { lastSessionId: value.lastSessionId }
        : {}),
      ...(value.sessionScope === 'project' || value.sessionScope === 'all'
        ? { sessionScope: value.sessionScope }
        : {}),
    };
  } catch {
    return {};
  }
}

function writePreferences(next: NavigationPreferences, storage: Storage | undefined = safeStorage()): void {
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Local persistence is a convenience. A blocked or full store must not
    // make session navigation unusable.
  }
}

function safeStorage(): Storage | undefined {
  if (typeof localStorage === 'undefined') return undefined;
  return localStorage;
}

export function loadLastSessionId(storage?: Storage): string {
  return readPreferences(storage).lastSessionId ?? '';
}

export function saveLastSessionId(id: string, storage?: Storage): void {
  const current = readPreferences(storage);
  const trimmed = id.trim();
  if (trimmed) current.lastSessionId = trimmed;
  else delete current.lastSessionId;
  writePreferences(current, storage);
}

export function loadSessionScope(storage?: Storage): StoredSessionScope {
  return readPreferences(storage).sessionScope ?? 'project';
}

export function saveSessionScope(scope: StoredSessionScope, storage?: Storage): void {
  const current = readPreferences(storage);
  current.sessionScope = scope;
  writePreferences(current, storage);
}
