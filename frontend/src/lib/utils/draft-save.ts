export function utf8DraftBytes(content: string): number {
  return new TextEncoder().encode(content).byteLength;
}

export function isCurrentDraftVersion(savedVersion: number, currentVersion: number): boolean {
  return savedVersion === currentVersion;
}

export function autosaveDelayForDraft(options: {
  enabled: boolean;
  overBudget: boolean;
  delayMs: number;
}): number | null {
  if (!options.enabled || options.overBudget) return null;
  if (!Number.isFinite(options.delayMs)) return 1500;
  return Math.round(Math.min(10_000, Math.max(250, options.delayMs)));
}

export type DraftExitAction = 'none' | 'save' | 'hold';
export type DraftLifecycleTrigger =
  'explicit' | 'autosave' | 'navigation' | 'visibility-hidden' | 'destroy';
export type DraftLifecycleAction = DraftExitAction | 'block';

/** Navigation and component teardown share one truthful persistence policy.
 * With autosave disabled, an unsaved draft is held for recovery and is never
 * converted into an implicit disk write. */
export function draftExitAction(options: {
  dirty: boolean;
  autosaveEnabled: boolean;
}): DraftExitAction {
  if (!options.dirty) return 'none';
  return options.autosaveEnabled ? 'save' : 'hold';
}

/** One persistence contract for editors with both explicit and lifecycle
 * triggers. Explicit Save/Ctrl-S always writes in the current scope. When
 * autosave is disabled, navigation/destruction holds the draft while passive
 * visibility/autosave events do nothing. */
export function draftLifecycleAction(options: {
  trigger: DraftLifecycleTrigger;
  dirty: boolean;
  autosaveEnabled: boolean;
  sameScope: boolean;
}): DraftLifecycleAction {
  if (!options.sameScope) return 'block';
  if (options.trigger === 'explicit') return 'save';
  if (!options.dirty) return 'none';
  if (options.autosaveEnabled) return 'save';
  return options.trigger === 'navigation' || options.trigger === 'destroy' ? 'hold' : 'none';
}

const draftNamespaces = new Map<string, Map<string, unknown>>();

/**
 * Process-local draft registry shared by remounts of an editor. Drafts are
 * deliberately kept out of localStorage because Notes and Memory may contain
 * sensitive project context. Callers choose a project/document-scoped key.
 */
export function createDraftRegistry<T>(namespace: string) {
  const registry = draftNamespaces.get(namespace) ?? new Map<string, unknown>();
  draftNamespaces.set(namespace, registry);
  return {
    set(key: string, draft: T): void {
      registry.set(key, draft);
    },
    get(key: string): T | undefined {
      return registry.get(key) as T | undefined;
    },
    delete(key: string): boolean {
      return registry.delete(key);
    },
    list(): T[] {
      return [...registry.values()] as T[];
    },
    clear(): void {
      registry.clear();
    },
  };
}
