import type { NoteDraft, NoteDraftSummary } from '@koryphaios/shared';

export type DraftBackupState = 'idle' | 'backing-up' | 'backed-up' | 'error' | 'conflict';

export interface DurableDraftScope {
  projectPath: string;
  noteId: string;
  baseRevision: number;
  baseTitle: string;
}

export interface DurableDraftSnapshot {
  title: string;
  content: string;
  folderPath: string;
  tags: string[];
  pinned: boolean;
  includeInContext: boolean;
  format: 'markdown' | 'html';
}

export interface DurableDraftTransport {
  create(scope: DurableDraftScope, snapshot: DurableDraftSnapshot): Promise<NoteDraft>;
  update(
    scope: DurableDraftScope,
    draftId: string,
    expectedDraftRevision: number,
    snapshot: DurableDraftSnapshot,
  ): Promise<NoteDraft>;
  discard(
    scope: DurableDraftScope,
    draftId: string,
    expectedDraftRevision: number,
  ): Promise<void>;
}

export interface DurableDraftStatus {
  state: DraftBackupState;
  editVersion: number;
  acknowledgedEditVersion: number;
  draftId?: string;
  error?: string;
}

function cloneSnapshot(snapshot: DurableDraftSnapshot): DurableDraftSnapshot {
  return { ...snapshot, tags: [...snapshot.tags] };
}

function sameScope(left: DurableDraftScope | null, right: DurableDraftScope): boolean {
  return (
    left?.projectPath === right.projectPath &&
    left.noteId === right.noteId &&
    left.baseRevision === right.baseRevision
  );
}

function isConflict(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    Number((error as { status?: unknown }).status) === 409
  );
}

/**
 * Serializes one editor branch into acknowledged backend snapshots. The class
 * deliberately owns no browser storage: SQLite is the durable source and the
 * renderer retains only the currently active branch identity.
 */
export class DurableNoteDraftBackup {
  readonly #transport: DurableDraftTransport;
  readonly #onStatus?: (status: DurableDraftStatus) => void;
  #scope: DurableDraftScope | null = null;
  #latest: DurableDraftSnapshot | null = null;
  #draftId: string | undefined;
  #draftRevision: number | undefined;
  #editVersion = 0;
  #acknowledgedEditVersion = 0;
  #state: DraftBackupState = 'idle';
  #error: string | undefined;
  #debounceTimer: ReturnType<typeof setTimeout> | null = null;
  #maxTimer: ReturnType<typeof setTimeout> | null = null;
  #flight: Promise<boolean> | null = null;
  #generation = 0;

  constructor(
    transport: DurableDraftTransport,
    onStatus?: (status: DurableDraftStatus) => void,
  ) {
    this.#transport = transport;
    this.#onStatus = onStatus;
  }

  get status(): DurableDraftStatus {
    return {
      state: this.#state,
      editVersion: this.#editVersion,
      acknowledgedEditVersion: this.#acknowledgedEditVersion,
      draftId: this.#draftId,
      error: this.#error,
    };
  }

  get hasUnbackedChanges(): boolean {
    return this.#acknowledgedEditVersion < this.#editVersion;
  }

  start(scope: DurableDraftScope): void {
    if (sameScope(this.#scope, scope)) return;
    this.#clearTimers();
    this.#generation++;
    this.#scope = { ...scope };
    this.#latest = null;
    this.#draftId = undefined;
    this.#draftRevision = undefined;
    this.#editVersion = 0;
    this.#acknowledgedEditVersion = 0;
    this.#setState('idle');
  }

  attachRecovered(scope: DurableDraftScope, draft: NoteDraft): void {
    this.#clearTimers();
    this.#generation++;
    this.#scope = { ...scope };
    this.#latest = cloneSnapshot(draft);
    this.#draftId = draft.id;
    this.#draftRevision = draft.draftRevision;
    this.#editVersion = 1;
    this.#acknowledgedEditVersion = 1;
    this.#setState('backed-up');
  }

  markEdited(snapshot: DurableDraftSnapshot, debounceMs = 350, maxWaitMs = 1_500): void {
    if (!this.#scope) throw new Error('Draft backup has no active note scope');
    this.#latest = cloneSnapshot(snapshot);
    this.#editVersion++;
    this.#error = undefined;
    if (this.#debounceTimer) clearTimeout(this.#debounceTimer);
    this.#debounceTimer = setTimeout(() => void this.flush(), Math.max(0, debounceMs));
    if (!this.#maxTimer) {
      this.#maxTimer = setTimeout(() => void this.flush(), Math.max(debounceMs, maxWaitMs));
    }
    this.#setState('backing-up');
  }

  async flush(): Promise<boolean> {
    this.#clearTimers();
    if (!this.#scope || !this.#latest || !this.hasUnbackedChanges) return true;
    if (this.#flight) {
      const prior = await this.#flight;
      if (!prior) return false;
      return this.hasUnbackedChanges ? this.flush() : true;
    }

    const generation = this.#generation;
    const scope = { ...this.#scope };
    const snapshot = cloneSnapshot(this.#latest);
    const targetVersion = this.#editVersion;
    const currentId = this.#draftId;
    const currentRevision = this.#draftRevision;
    this.#setState('backing-up');

    this.#flight = (async () => {
      try {
        const stored = currentId
          ? await this.#transport.update(scope, currentId, currentRevision!, snapshot)
          : await this.#transport.create(scope, snapshot);
        if (generation !== this.#generation || !sameScope(this.#scope, scope)) return true;
        this.#draftId = stored.id;
        this.#draftRevision = stored.draftRevision;
        this.#acknowledgedEditVersion = Math.max(
          this.#acknowledgedEditVersion,
          targetVersion,
        );
        this.#setState(
          this.#acknowledgedEditVersion === this.#editVersion ? 'backed-up' : 'backing-up',
        );
        return true;
      } catch (error) {
        if (generation === this.#generation) {
          this.#error = error instanceof Error ? error.message : 'Draft backup failed';
          this.#setState(isConflict(error) ? 'conflict' : 'error');
        }
        return false;
      }
    })().finally(() => {
      this.#flight = null;
    });

    const success = await this.#flight;
    if (success && generation === this.#generation && this.hasUnbackedChanges) {
      return this.flush();
    }
    return success;
  }

  /** Rebase edits made during an authoritative save onto the new note revision.
   * The old branch is removed only after a new durable branch acknowledges the
   * newer editor state. */
  async afterAuthoritativeSave(
    savedEditVersion: number,
    newBaseRevision: number,
    currentSnapshot: DurableDraftSnapshot,
  ): Promise<boolean> {
    if (!this.#scope) return true;
    const oldScope = { ...this.#scope };
    await this.flush();
    const oldId = this.#draftId;
    const oldRevision = this.#draftRevision;

    if (this.#editVersion === savedEditVersion) {
      if (oldId && oldRevision) {
        try {
          await this.#transport.discard(oldScope, oldId, oldRevision);
        } catch {
          // Retaining a stale branch is noisy but lossless. Recovery will show
          // it as a conflict and the user can discard it explicitly.
        }
      }
      this.start({ ...oldScope, baseRevision: newBaseRevision });
      return true;
    }

    const newerVersion = this.#editVersion;
    const nextScope = { ...oldScope, baseRevision: newBaseRevision };
    this.start(nextScope);
    this.#latest = cloneSnapshot(currentSnapshot);
    this.#editVersion = newerVersion;
    this.#acknowledgedEditVersion = 0;
    const backedUp = await this.flush();
    if (!backedUp) return false;
    if (oldId && oldRevision) {
      try {
        await this.#transport.discard(oldScope, oldId, oldRevision);
      } catch {
        // Preserve both branches when cleanup cannot be proven.
      }
    }
    return true;
  }

  abandonLocalIdentity(): void {
    this.#clearTimers();
    this.#generation++;
    this.#scope = null;
    this.#latest = null;
    this.#draftId = undefined;
    this.#draftRevision = undefined;
    this.#editVersion = 0;
    this.#acknowledgedEditVersion = 0;
    this.#setState('idle');
  }

  #clearTimers(): void {
    if (this.#debounceTimer) clearTimeout(this.#debounceTimer);
    if (this.#maxTimer) clearTimeout(this.#maxTimer);
    this.#debounceTimer = null;
    this.#maxTimer = null;
  }

  #setState(state: DraftBackupState): void {
    this.#state = state;
    if (state !== 'error' && state !== 'conflict') this.#error = undefined;
    this.#emit();
  }

  #emit(): void {
    this.#onStatus?.(this.status);
  }
}

export type DraftRecoveryCatalog = readonly NoteDraftSummary[];
