import { toastStore } from './toast.svelte';

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
  loading: boolean;
  selectedFile: string | null;
  currentDiff: string | null;
  activeDiff: { file: string; staged: boolean } | null;
  currentFileContent: string | null;
  ahead: number;
  behind: number;
}

let state = $state<GitState>({
  status: [],
  branch: '',
  branches: [],
  conflicts: [],
  loading: false,
  selectedFile: null,
  currentDiff: null,
  activeDiff: null,
  currentFileContent: null,
  ahead: 0,
  behind: 0,
});

async function refreshStatus() {
  state.loading = true;
  try {
    const res = await fetch('/api/git/status');
    const data = await res.json();
    if (data.ok) {
      state.status = data.data.status;
      state.branch = data.data.branch;
      state.ahead = data.data.ahead ?? 0;
      state.behind = data.data.behind ?? 0;
      await fetchBranches();
    }
  } catch (err) {
    console.error('Failed to fetch git status', err);
  } finally {
    state.loading = false;
  }
}

async function fetchBranches() {
  try {
    const res = await fetch('/api/git/branches');
    const data = await res.json();
    if (data.ok) state.branches = data.data.branches;
  } catch {}
}

async function checkout(branch: string, create = false) {
  state.loading = true;
  try {
    const res = await fetch('/api/git/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ branch, create }),
    });
    if (res.ok) {
      toastStore.success(`Switched to ${branch}`);
      await refreshStatus();
    } else {
      toastStore.error(`Failed to switch to ${branch}`);
    }
  } catch {
    toastStore.error('Checkout failed');
  } finally {
    state.loading = false;
  }
}

async function merge(branch: string) {
  state.loading = true;
  try {
    const res = await fetch('/api/git/merge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ branch }),
    });
    const data = await res.json();
    if (data.ok) {
      toastStore.success('Merge successful');
      state.conflicts = [];
    } else if (data.data?.hasConflicts) {
      state.conflicts = data.data.conflicts;
      toastStore.warning('Merge conflicts occurred');
    } else {
      toastStore.error('Merge failed');
    }
    await refreshStatus();
  } catch {
    toastStore.error('Merge failed');
  } finally {
    state.loading = false;
  }
}

async function loadDiff(file: string, staged: boolean) {
  state.selectedFile = file;
  state.currentDiff = null;
  state.currentFileContent = null;
  
  try {
    // Try getting diff first
    const res = await fetch(`/api/git/diff?file=${encodeURIComponent(file)}&staged=${staged}`);
    const data = await res.json();
    if (data.ok && data.data.diff) {
      state.currentDiff = data.data.diff;
    } else {
      // If no diff (e.g. untracked or binary), try getting content
      const contentRes = await fetch(`/api/git/file?path=${encodeURIComponent(file)}`);
      const contentData = await contentRes.json();
      if (contentData.ok) {
        state.currentFileContent = contentData.data.content;
      }
    }
  } catch (err) {
    console.error('Failed to load diff/content', err);
  }
}

function openDiff(file: string, staged: boolean) {
  state.activeDiff = { file, staged };
  loadDiff(file, staged);
}

function closeDiff() {
  state.activeDiff = null;
  state.currentDiff = null;
  state.currentFileContent = null;
}

async function stageFile(file: string) {
  try {
    const res = await fetch('/api/git/stage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file }),
    });
    if (res.ok) {
      await refreshStatus();
    }
  } catch (err) {
    toastStore.error('Failed to stage file');
  }
}

async function unstageFile(file: string) {
  try {
    const res = await fetch('/api/git/stage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file, unstage: true }),
    });
    if (res.ok) {
      await refreshStatus();
    }
  } catch (err) {
    toastStore.error('Failed to unstage file');
  }
}

async function discardChanges(file: string) {
  try {
    const res = await fetch('/api/git/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file }),
    });
    if (res.ok) {
      toastStore.success('Changes discarded');
      await refreshStatus();
    } else {
      toastStore.error('Failed to discard changes');
    }
  } catch (err) {
    toastStore.error('Failed to discard changes');
  }
}

async function commit(message: string) {
  try {
    const res = await fetch('/api/git/commit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    });
    if (res.ok) {
      toastStore.success('Commit successful');
      await refreshStatus();
      return true;
    } else {
      toastStore.error('Commit failed');
      return false;
    }
  } catch (err) {
    toastStore.error('Commit failed');
    return false;
  }
}

async function push() {
  try {
    const res = await fetch('/api/git/push', { method: 'POST' });
    const data = await res.json();
    if (data.ok) {
      toastStore.success('Push successful');
    } else {
      toastStore.error('Push failed: ' + data.error);
    }
  } catch (err) {
    toastStore.error('Push failed');
  }
}

async function pull() {
  state.loading = true;
  try {
    const res = await fetch('/api/git/pull', { method: 'POST' });
    const data = await res.json();
    if (data.ok) {
      toastStore.success('Pull successful');
      state.conflicts = [];
    } else if (data.data?.hasConflicts) {
      state.conflicts = data.data.conflicts;
      toastStore.warning('Conflicts during pull');
    } else {
      toastStore.error('Pull failed: ' + (data.error || 'Unknown error'));
    }
    await refreshStatus();
  } catch (err) {
    toastStore.error('Pull failed');
  } finally {
    state.loading = false;
  }
}

function clearConflicts() {
  state.conflicts = [];
}

export const gitStore = {
  get state() { return state; },
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
};
