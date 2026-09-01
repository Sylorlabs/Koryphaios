// Workspace controller — authoritative workspace navigation extracted from
// the main page. Owns the HTTP calls, snapshot reconciliation, the single
// in-flight refresh promise, and the session→project reconciliation fence.
// Dependencies are injectable so characterization tests run hermetically.

import { toastStore } from '$lib/stores/toast.svelte';
import {
  projectStore,
  projectDisplayName,
  type WorkspaceNavigationSnapshot,
  type WorkspaceReconciliation,
} from '$lib/stores/project.svelte';

interface SnapshotResponse {
  ok?: boolean;
  data?: WorkspaceNavigationSnapshot;
  error?: string;
}

export interface WorkspaceControllerDeps {
  /** Authenticated workspace request — pass `(path, init) => apiFetch(apiUrl(path), init)`. */
  requestSnapshot: (path: string, init?: RequestInit) => Promise<Response>;
  /** Working directory of the active session, if any (restore fallback). */
  getActiveSessionWorkingDirectory?: () => string | null;
  /** Clear the active session (original behavior when a project dies). */
  clearActiveSession?: () => void;
}

export interface WorkspaceController {
  reconcileWorkspaceSnapshot(snapshot: WorkspaceNavigationSnapshot): void;
  selectAuthoritativeProject(path: string): Promise<boolean>;
  deselectAuthoritativeProject(): Promise<void>;
  acknowledgeUnavailableProject(): Promise<void>;
  readWorkspaceNavigation(): Promise<WorkspaceNavigationSnapshot | null>;
  refreshWorkspaceNavigation(options?: { restoreFromActiveSession?: boolean }): Promise<void>;
  /** Fence for the session reconciler effect: only the newest session id is
   *  auto-reconciled, preventing ping-pong between windows and refreshes. */
  readonly lastReconciledSessionId: string;
  setLastReconciledSessionId(id: string): void;
}

export function createWorkspaceController(
  deps: WorkspaceControllerDeps,
  options: {
    /** Fired when the project selection changed (e.g. refresh @-mentions). */
    onProjectChanged?: () => void;
  } = {},
): WorkspaceController {
  let workspaceRefreshPromise: Promise<void> | null = null;
  let pendingRestore = false;
  let lastReconciledSessionId = '';

  function reconcileWorkspaceSnapshot(snapshot: WorkspaceNavigationSnapshot): void {
    const result = projectStore.reconcile(snapshot);
    if (result.projectBecameUnavailable || result.workspaceBecameUnavailable) {
      lastReconciledSessionId = '';
      deps.clearActiveSession?.();
      const missing = result.projectBecameUnavailable ?? result.workspaceBecameUnavailable;
      toastStore.error(
        `${projectDisplayName(missing)} moved or was deleted. The folder list has been refreshed.`,
      );
      // Clear the broken path from persistence so it doesn't survive a
      // relaunch or keep triggering API 400s via the requestPath header.
      void acknowledgeUnavailableProject();
    }
    if (result.changed && projectStore.currentPath) options.onProjectChanged?.();
  }

  async function selectAuthoritativeProject(path: string): Promise<boolean> {
    workspaceRefreshPromise = null;
    pendingRestore = false;
    const response = await deps.requestSnapshot('/api/workspace/select', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    });
    const body = (await response.json().catch(() => ({}))) as SnapshotResponse;
    if (!response.ok || !body.ok || !body.data) {
      toastStore.error(body.error || 'Project folder is unavailable');
      return false;
    }
    reconcileWorkspaceSnapshot(body.data);
    return true;
  }

  async function deselectAuthoritativeProject(): Promise<void> {
    workspaceRefreshPromise = null;
    pendingRestore = false;
    const response = await deps.requestSnapshot('/api/workspace/deselect', { method: 'POST' });
    const body = (await response.json().catch(() => ({}))) as SnapshotResponse;
    if (response.ok && body.ok && body.data) reconcileWorkspaceSnapshot(body.data);
  }

  async function acknowledgeUnavailableProject(): Promise<void> {
    const response = await deps.requestSnapshot('/api/workspace/acknowledge-unavailable', {
      method: 'POST',
    });
    const body = (await response.json().catch(() => ({}))) as SnapshotResponse;
    if (response.ok && body.ok && body.data) reconcileWorkspaceSnapshot(body.data);
  }

  async function readWorkspaceNavigation(): Promise<WorkspaceNavigationSnapshot | null> {
    const response = await deps.requestSnapshot('/api/workspace/state');
    const body = (await response.json().catch(() => ({}))) as SnapshotResponse;
    if (!response.ok || !body.ok || !body.data) return null;
    return body.data;
  }

  async function refreshWorkspaceNavigation(
    refreshOptions: { restoreFromActiveSession?: boolean } = {},
  ): Promise<void> {
    if (workspaceRefreshPromise) {
      // A plain refresh is in flight; make sure the restore intent still runs
      // afterwards instead of being swallowed by the shared promise.
      if (refreshOptions.restoreFromActiveSession) pendingRestore = true;
      return workspaceRefreshPromise;
    }
    const restore = refreshOptions.restoreFromActiveSession || pendingRestore;
    pendingRestore = false;
    workspaceRefreshPromise = (async () => {
      const snapshot = await readWorkspaceNavigation();
      if (!snapshot) return;
      reconcileWorkspaceSnapshot(snapshot);
      // Don't try to restore a session whose working directory the snapshot
      // already flagged as unavailable — that path is gone and restoring it
      // would just re-trigger the "moved or was deleted" notification.
      const unavailablePath = snapshot.unavailableProject ?? snapshot.unavailableWorkspace;
      const activeWorkingDirectory = deps.getActiveSessionWorkingDirectory?.();
      if (
        restore &&
        !snapshot.workspaceRoot &&
        !snapshot.selectedProject &&
        activeWorkingDirectory &&
        activeWorkingDirectory !== unavailablePath
      ) {
        await selectAuthoritativeProject(activeWorkingDirectory);
      }
    })()
      .catch((error: unknown) => {
        console.warn(
          'Workspace refresh failed:',
          error instanceof Error ? error.message : String(error),
        );
      })
      .finally(() => {
        workspaceRefreshPromise = null;
      });
    return workspaceRefreshPromise;
  }

  return {
    reconcileWorkspaceSnapshot,
    selectAuthoritativeProject,
    deselectAuthoritativeProject,
    acknowledgeUnavailableProject,
    readWorkspaceNavigation,
    refreshWorkspaceNavigation,
    get lastReconciledSessionId() {
      return lastReconciledSessionId;
    },
    setLastReconciledSessionId(id: string) {
      lastReconciledSessionId = id;
    },
  };
}
