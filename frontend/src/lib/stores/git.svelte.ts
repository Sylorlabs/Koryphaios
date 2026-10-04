import { toastStore } from './toast.svelte';
import { apiUrl } from '$lib/utils/api-url';
import { apiFetch } from '$lib/api.svelte';
import { isDemoMode } from '$lib/demo-flags';
import { sessionStore } from './sessions.svelte';
import { wsStore } from './websocket.svelte';
import { projectStore } from './project.svelte';

export interface GitFileStatus {
  path: string;
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked';
  staged: boolean;
  additions?: number;
  deletions?: number;
}

export interface GitState {
  status: GitFileStatus[];
  branch: string;
  branches: string[];
  conflicts: string[];
  /** Monotonic local event counter so an identical conflict list can still reopen recovery UI. */
  conflictRevision: number;
  loading: boolean;
  selectedFile: string | null;
  currentDiff: string | null;
  activeDiff: { file: string; staged: boolean } | null;
  currentFileContent: string | null;
  ahead: number;
  behind: number;
  isRepo: boolean;
}

const initialState = (): GitState => ({
  status: [],
  branch: '',
  branches: [],
  conflicts: [],
  conflictRevision: 0,
  loading: false,
  selectedFile: null,
  currentDiff: null,
  activeDiff: null,
  currentFileContent: null,
  ahead: 0,
  behind: 0,
  isRepo: false,
});

let state = $state<GitState>(initialState());
let contextKey = '';
let generation = 0;
let statusRequest = 0;
let diffRequest = 0;

function currentContextKey(): string {
  const sessionId = sessionStore.activeSessionId;
  const session = sessionStore.sessions.find((item) => item.id === sessionId);
  return JSON.stringify([
    sessionId,
    session?.workingDirectory ?? projectStore.requestPath,
    session?.gitWorkspace?.path,
  ]);
}

/** Called on chat/project changes, including switches within one source repository. */
function resetForContext(): void {
  const key = currentContextKey();
  if (key === contextKey) return;
  contextKey = key;
  generation++;
  // Recovery UI observes a globally monotonic revision, including resets.
  state = { ...initialState(), conflictRevision: state.conflictRevision + 1 };
}

function captureContext(): () => boolean {
  resetForContext();
  const key = contextKey;
  const version = generation;
  return () => version === generation && key === currentContextKey();
}

function syncDemoReview(): void {
  if (!isDemoMode || !sessionStore.activeSessionId) return;
  void import('$lib/demo-api').then(({ getDemoReviewChanges }) =>
    wsStore.setDemoSessionChanges(sessionStore.activeSessionId!, getDemoReviewChanges()),
  );
}

async function refreshStatus() {
  const current = captureContext();
  const request = ++statusRequest;
  const isCurrent = () => current() && request === statusRequest;
  state.loading = true;
  try {
    const res = await apiFetch(apiUrl('/api/git/status'));
    const text = await res.text();
    if (!isCurrent()) return;
    if (!res.ok) {
      state.status = [];
      state.branch = '';
      state.isRepo = false;
      return;
    }
    if (!text.trim()) return;
    let data: {
      ok?: boolean;
      data?: {
        isRepo?: boolean;
        status?: unknown[];
        branch?: string;
        ahead?: number;
        behind?: number;
      };
    };
    try {
      data = JSON.parse(text);
    } catch (err: unknown) {
      console.debug(
        'Failed to parse git status response:',
        err instanceof Error ? err.message : String(err),
      );
      state.status = [];
      state.branch = '';
      state.isRepo = false;
      return;
    }
    if (data?.ok && data.data) {
      state.isRepo = data.data.isRepo ?? false;
      state.status = (data.data.status as GitFileStatus[] | undefined) ?? [];
      state.branch = data.data.branch ?? '';
      state.ahead = data.data.ahead ?? 0;
      state.behind = data.data.behind ?? 0;
      if (state.isRepo) {
        await fetchBranches();
      }
    }
  } catch (err: unknown) {
    if (!isCurrent()) return;
    console.warn('Failed to refresh git status:', err instanceof Error ? err.message : String(err));
    state.status = [];
    state.branch = '';
    state.isRepo = false;
  } finally {
    if (isCurrent()) state.loading = false;
  }
}

async function fetchBranches() {
  const isCurrent = captureContext();
  try {
    const res = await apiFetch(apiUrl('/api/git/branches'));
    if (!res.ok) return;
    const text = await res.text();
    if (!text.trim()) return;
    const data = JSON.parse(text);
    if (isCurrent() && data.ok) state.branches = data.data?.branches ?? [];
  } catch (err: unknown) {
    if (!isCurrent()) return;
    console.warn('Failed to fetch branches:', err instanceof Error ? err.message : String(err));
    state.branches = [];
  }
}

async function checkout(branch: string, create = false) {
  const isCurrent = captureContext();
  state.loading = true;
  try {
    const res = await apiFetch(apiUrl('/api/git/checkout'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ branch, create }),
    });
    if (!isCurrent()) return;
    if (res.ok) {
      toastStore.success(`Switched to ${branch}`);
      await refreshStatus();
    } else {
      toastStore.error(`Failed to switch to ${branch}`);
    }
  } catch (err: unknown) {
    if (!isCurrent()) return;
    console.warn('Checkout failed:', err instanceof Error ? err.message : String(err));
    toastStore.error('Checkout failed');
  } finally {
    if (isCurrent()) state.loading = false;
  }
}

async function merge(branch: string) {
  const isCurrent = captureContext();
  state.loading = true;
  try {
    const res = await apiFetch(apiUrl('/api/git/merge'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ branch }),
    });
    const data = await res.json();
    if (!isCurrent()) return;
    if (data.ok) {
      toastStore.success('Merge successful');
      state.conflicts = [];
    } else if (data.data?.hasConflicts) {
      state.conflicts = data.data.conflicts;
      state.conflictRevision += 1;
      toastStore.warning('Merge conflicts occurred');
    } else {
      toastStore.error('Merge failed');
    }
    await refreshStatus();
  } catch (err: unknown) {
    if (!isCurrent()) return;
    console.warn('Merge failed:', err instanceof Error ? err.message : String(err));
    toastStore.error('Merge failed');
  } finally {
    if (isCurrent()) state.loading = false;
  }
}

async function loadDiff(file: string, staged: boolean) {
  const current = captureContext();
  const request = ++diffRequest;
  const isCurrent = () => current() && request === diffRequest;
  state.selectedFile = file;
  state.currentDiff = null;
  state.currentFileContent = null;

  try {
    // Try getting diff first
    const res = await apiFetch(
      apiUrl(`/api/git/diff?file=${encodeURIComponent(file)}&staged=${staged}`),
    );
    const data = await res.json();
    if (!isCurrent()) return;
    if (data.ok && data.data.diff) {
      state.currentDiff = data.data.diff;
    } else {
      // If no diff (e.g. untracked or binary), try getting content
      const contentRes = await apiFetch(apiUrl(`/api/git/file?path=${encodeURIComponent(file)}`));
      const contentData = await contentRes.json();
      if (isCurrent() && contentData.ok) {
        state.currentFileContent = contentData.data.content;
      }
    }
  } catch (err) {
    if (import.meta.env.DEV) console.error('Failed to load diff/content', err);
  }
}

function openDiff(file: string, staged: boolean) {
  resetForContext();
  state.activeDiff = { file, staged };
  loadDiff(file, staged);
}

function closeDiff() {
  diffRequest++;
  state.activeDiff = null;
  state.currentDiff = null;
  state.currentFileContent = null;
}

async function stageFile(file: string) {
  const isCurrent = captureContext();
  try {
    const res = await apiFetch(apiUrl('/api/git/stage'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file }),
    });
    if (isCurrent() && res.ok) {
      await refreshStatus();
    }
  } catch (err) {
    if (isCurrent()) toastStore.error('Failed to stage file');
  }
}

async function unstageFile(file: string) {
  const isCurrent = captureContext();
  try {
    const res = await apiFetch(apiUrl('/api/git/stage'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file, unstage: true }),
    });
    if (isCurrent() && res.ok) {
      await refreshStatus();
    }
  } catch (err) {
    if (isCurrent()) toastStore.error('Failed to unstage file');
  }
}

async function discardChanges(file: string) {
  const isCurrent = captureContext();
  try {
    const res = await apiFetch(apiUrl('/api/git/restore'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file }),
    });
    if (!isCurrent()) return;
    if (res.ok) {
      toastStore.success('Changes discarded');
      await refreshStatus();
      if (isCurrent()) syncDemoReview();
    } else {
      toastStore.error('Failed to discard changes');
    }
  } catch (err) {
    if (isCurrent()) toastStore.error('Failed to discard changes');
  }
}

async function commit(message: string) {
  const isCurrent = captureContext();
  try {
    const res = await apiFetch(apiUrl('/api/git/commit'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    });
    if (!isCurrent()) return false;
    if (res.ok) {
      toastStore.success('Commit successful');
      await refreshStatus();
      if (!isCurrent()) return false;
      syncDemoReview();
      return true;
    } else {
      toastStore.error('Commit failed');
      return false;
    }
  } catch (err) {
    if (isCurrent()) toastStore.error('Commit failed');
    return false;
  }
}

async function push() {
  const isCurrent = captureContext();
  try {
    const res = await apiFetch(apiUrl('/api/git/push'), { method: 'POST' });
    const data = await res.json();
    if (!isCurrent()) return;
    if (data.ok) {
      toastStore.success('Push successful');
    } else {
      toastStore.error('Push failed: ' + data.error);
    }
  } catch (err) {
    if (isCurrent()) toastStore.error('Push failed');
  }
}

async function pull() {
  const isCurrent = captureContext();
  state.loading = true;
  try {
    const res = await apiFetch(apiUrl('/api/git/pull'), { method: 'POST' });
    const data = await res.json();
    if (!isCurrent()) return;
    if (data.ok) {
      toastStore.success('Pull successful');
      state.conflicts = [];
    } else if (data.data?.hasConflicts) {
      state.conflicts = data.data.conflicts;
      state.conflictRevision += 1;
      toastStore.warning('Conflicts during pull');
    } else {
      toastStore.error('Pull failed: ' + (data.error || 'Unknown error'));
    }
    await refreshStatus();
  } catch (err) {
    if (isCurrent()) toastStore.error('Pull failed');
  } finally {
    if (isCurrent()) state.loading = false;
  }
}

function clearConflicts() {
  state.conflicts = [];
}

function reportConflicts(files: string[]) {
  resetForContext();
  state.conflicts = files;
  state.conflictRevision += 1;
}

export const gitStore = {
  get state() {
    return state;
  },
  resetForContext,
  refreshStatus,
  loadDiff,
  openDiff,
  closeDiff,
  stageFile,
  unstageFile,
  discardChanges,
  commit,
  push,
  pull,
  checkout,
  merge,
  clearConflicts,
  reportConflicts,
};
