import { toastStore } from './toast.svelte';
import { apiFetch } from '$lib/api';

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
}

let state = $state<GitState>({
  status: [],
  branch: '',
  branches: [],
  conflicts: [],
  loading: false,
  selectedFile: null,
  currentDiff: null,
});

async function refreshStatus() {
  state.loading = true;
  try {
    const res = await apiFetch('/api/git/status');
    const data = await res.json();
    if (data.ok) {
      state.status = data.data.status;
      state.branch = data.data.branch;
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
    const res = await apiFetch('/api/git/branches');
    const data = await res.json();
    if (data.ok) state.branches = data.data.branches;
  } catch {}
}

async function checkout(branch: string, create = false) {
  state.loading = true;
  try {
    const res = await apiFetch('/api/git/checkout', {
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
    const res = await apiFetch('/api/git/merge', {
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
  try {
    const res = await apiFetch(`/api/git/diff?file=${encodeURIComponent(file)}&staged=${staged}`);
    const data = await res.json();
    if (data.ok) {
      state.currentDiff = data.data.diff;
    }
  } catch (err) {
    console.error('Failed to load diff', err);
  }
}

async function stageFile(file: string) {
  try {
    const res = await apiFetch('/api/git/stage', {
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
    const res = await apiFetch('/api/git/stage', {
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
    const res = await apiFetch('/api/git/restore', {
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
    const res = await apiFetch('/api/git/commit', {
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
    const res = await apiFetch('/api/git/push', { method: 'POST' });
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
    const res = await apiFetch('/api/git/pull', { method: 'POST' });
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
