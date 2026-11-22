// First-run hint for importing chats from installed CLIs (Claude Code, Codex,
// ...). Pure helpers plus a small fetch wrapper, so the show/hide/dismiss rules
// can be tested without rendering the welcome view.

/** localStorage key for "the reader dismissed the import hint". */
export const IMPORT_HINT_DISMISSED_KEY = 'koryphaios.cli-import-hint-dismissed';

export interface ImportableSummary {
  /** Chats found on disk that are not yet in Koryphaios. */
  count: number;
  /** Distinct display names of the providers those chats came from, in discovery order. */
  providerNames: string[];
}

export const NO_IMPORTABLE_CHATS: ImportableSummary = { count: 0, providerNames: [] };

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStorage(): StorageLike | undefined {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    // Accessing localStorage can throw when storage is blocked.
    return undefined;
  }
}

/** Read the dismissal flag. A blocked or unreadable store means "not dismissed". */
export function isImportHintDismissed(storage: StorageLike | undefined = defaultStorage()): boolean {
  try {
    return storage?.getItem(IMPORT_HINT_DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

/** Remember the dismissal. A blocked store only means the hint returns next visit. */
export function dismissImportHint(storage: StorageLike | undefined = defaultStorage()): void {
  try {
    storage?.setItem(IMPORT_HINT_DISMISSED_KEY, '1');
  } catch {
    // Ignored: the hint is a convenience, not state the app depends on.
  }
}

/**
 * Count importable chats in a `/api/cli-chat-import/discover` response body.
 * Anything malformed counts as nothing importable.
 */
export function summarizeImportable(body: unknown): ImportableSummary {
  const data = (body as { data?: { projects?: unknown } } | null)?.data;
  const projects = Array.isArray(data?.projects) ? data.projects : [];
  let count = 0;
  const providerNames: string[] = [];
  for (const project of projects) {
    const chats = Array.isArray((project as { chats?: unknown })?.chats)
      ? ((project as { chats: unknown[] }).chats)
      : [];
    for (const chat of chats) {
      if (!chat || typeof chat !== 'object') continue;
      const entry = chat as { alreadyImported?: unknown; providerDisplayName?: unknown; provider?: unknown };
      if (entry.alreadyImported === true) continue;
      count += 1;
      const name =
        typeof entry.providerDisplayName === 'string' && entry.providerDisplayName
          ? entry.providerDisplayName
          : typeof entry.provider === 'string'
            ? entry.provider
            : '';
      if (name && !providerNames.includes(name)) providerNames.push(name);
    }
  }
  return { count, providerNames };
}

/** The line shown on the welcome view, e.g. "Import 3 chats from Claude Code / Codex". */
export function importHintText(summary: ImportableSummary): string {
  const chats = `${summary.count} ${summary.count === 1 ? 'chat' : 'chats'}`;
  const sources = summary.providerNames.length > 0 ? summary.providerNames.join(' / ') : 'local CLIs';
  return `Import ${chats} from ${sources}`;
}

/** The hint appears only when something is importable and the reader has not dismissed it. */
export function shouldShowImportHint(summary: ImportableSummary, dismissed: boolean): boolean {
  return !dismissed && summary.count > 0;
}

/**
 * Fetch the discovery summary. Any failure, including a missing response, is
 * treated as nothing importable so the welcome view never breaks on it.
 */
export async function fetchImportableSummary(
  fetchDiscovery: () => Promise<{ ok: boolean; json: () => Promise<unknown> } | undefined>,
): Promise<ImportableSummary> {
  try {
    const res = await fetchDiscovery();
    if (!res?.ok) return NO_IMPORTABLE_CHATS;
    return summarizeImportable(await res.json());
  } catch {
    return NO_IMPORTABLE_CHATS;
  }
}
