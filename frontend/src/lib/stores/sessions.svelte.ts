// Session management store — Svelte 5 runes
// Handles CRUD, rename, search, date grouping, message history

import type { Session } from '@koryphaios/shared';
import { toastStore } from './toast.svelte';
import { projectStore } from './project.svelte';
import { browser } from '$app/environment';
import { friendlyHttpError } from '$lib/utils/http-error';
import { apiUrl } from '$lib/utils/api-url';
import { apiFetch } from '$lib/api.svelte';
import { wsStore } from './websocket.svelte';

const LAST_SESSION_KEY = 'koryphaios-last-session';
const NEW_CHAT_BEHAVIOR_KEY = 'koryphaios-new-chat-behavior';

export type NewChatBehavior = 'always-create';

let sessions = $state<Session[]>([]);
let activeSessionId = $state<string>('');
let searchQuery = $state<string>('');
let loading = $state<boolean>(false);
let createSessionPromise: Promise<string | null> | null = null;
let fetchGeneration = 0;
let hasRestoredInitialSession = false;
// A websocket update can already be in flight when a session is deleted.
// Keep a short-lived tombstone until the next authoritative list confirms the
// row is gone, rather than allowing that stale event to recreate it in the UI.
const deletedSessionIds = new Set<string>();

function loadNewChatBehavior(): NewChatBehavior {
  if (!browser) return 'always-create';
  try {
    localStorage.setItem(NEW_CHAT_BEHAVIOR_KEY, 'always-create');
    return 'always-create';
  } catch (err: unknown) {
    console.debug(
      'Failed to persist new chat behavior:',
      err instanceof Error ? err.message : String(err),
    );
    return 'always-create';
  }
}

let newChatBehavior = $state<NewChatBehavior>(loadNewChatBehavior());

function setNewChatBehavior(behavior: NewChatBehavior): void {
  newChatBehavior = behavior;
  if (!browser) return;
  try {
    localStorage.setItem(NEW_CHAT_BEHAVIOR_KEY, behavior);
  } catch (err: unknown) {
    // Keep the in-memory preference when storage is unavailable.
    console.debug(
      'Failed to persist new chat behavior:',
      err instanceof Error ? err.message : String(err),
    );
  }
}

// Load last session from localStorage on startup
function loadLastSession(): string {
  if (!browser) return '';
  try {
    const stored = localStorage.getItem(LAST_SESSION_KEY);
    return stored || '';
  } catch (err: unknown) {
    console.debug(
      'Failed to read last session from localStorage:',
      err instanceof Error ? err.message : String(err),
    );
    return '';
  }
}

// Save active session to localStorage
function saveLastSession(id: string): void {
  if (!browser) return;
  try {
    if (id) {
      localStorage.setItem(LAST_SESSION_KEY, id);
    } else {
      localStorage.removeItem(LAST_SESSION_KEY);
    }
  } catch (err: unknown) {
    // Ignore localStorage errors
    console.debug(
      'Failed to save last session to localStorage:',
      err instanceof Error ? err.message : String(err),
    );
  }
}

// ─── API calls ──────────────────────────────────────────────────────────────

/** Returns true if sessions loaded successfully, false otherwise (e.g. backend down). */
async function fetchSessions(): Promise<boolean> {
  if (!browser) return false;
  const myGeneration = ++fetchGeneration;
  try {
    const res = await apiFetch(apiUrl('/api/sessions'));
    const text = await res.text();
    if (!res.ok) {
      let detail = '';
      try {
        const body = text ? JSON.parse(text) : {};
        detail = body.detail ?? body.error ?? '';
        if (detail && import.meta.env.DEV) console.error('fetchSessions backend error:', detail);
      } catch (err: unknown) {
        /* ignore */
        console.debug(
          'Failed to parse fetchSessions error body:',
          err instanceof Error ? err.message : String(err),
        );
      }
      if (!(res.status === 500 && !text.trim())) {
        if (import.meta.env.DEV)
          console.error('fetchSessions failed', { status: res.status, body: text || '(empty)' });
      }
      toastStore.error(friendlyHttpError(res.status, 'load sessions'), {
        onRetry: () => void fetchSessions(),
      });
      return false;
    }
    if (!text.trim()) return false;
    let data: { ok?: boolean; data?: Session[] };
    try {
      data = JSON.parse(text);
    } catch (err: unknown) {
      console.debug(
        'Failed to parse sessions response:',
        err instanceof Error ? err.message : String(err),
      );
      return false;
    }
    if (data?.ok && Array.isArray(data.data)) {
      // Session refreshes can overlap during startup, workspace changes, and
      // reconnects. Only the newest response may alter selection or the list.
      if (myGeneration !== fetchGeneration) return true;
      const returnedIds = new Set(data.data.map((session) => session.id));
      for (const id of deletedSessionIds) {
        if (!returnedIds.has(id)) deletedSessionIds.delete(id);
      }
      sessions = data.data.filter((session) => !deletedSessionIds.has(session.id));
      const lastSessionId = hasRestoredInitialSession ? '' : loadLastSession();
      hasRestoredInitialSession = true;

      // If we have a stored session and it still exists, use it
      if (lastSessionId && sessions.find((s) => s.id === lastSessionId)) {
        activeSessionId = lastSessionId;
      } else if (activeSessionId && !sessions.find((s) => s.id === activeSessionId)) {
        // Never jump to an unrelated conversation because a refresh returned a
        // differently scoped list. Deletion explicitly chooses a replacement.
        activeSessionId = '';
      } else if (!activeSessionId && sessions.length > 0) {
        activeSessionId = sessions[0].id;
      }

      // Save the resolved active session
      if (activeSessionId) {
        saveLastSession(activeSessionId);
        const active = sessions.find((session) => session.id === activeSessionId);
        // Adopt the session's project only when the user hasn't chosen one —
        // never override a persisted choice, and never yank someone off the
        // workspace chooser (currentPath === null is a deliberate, persisted
        // state whenever a workspace is open).
        if (active?.workingDirectory && !projectStore.currentPath && !projectStore.workspaceRoot) {
          projectStore.setProject(active.workingDirectory);
        }
      }
      return true;
    }
    return false;
  } catch (err) {
    if (import.meta.env.DEV) console.error('fetchSessions exception', err);
    toastStore.error('Failed to load sessions', { onRetry: () => void fetchSessions() });
    return false;
  }
}

/** Resolve the working directory a brand-new chat should be scoped to.
 *  - Inside a workspace: scope='all' → no workingDirectory (workspace-level chat);
 *    scope='project' → use the active project's path. Falls back to workspace-level
 *    if no project is open.
 *  - Outside a workspace: use the active project if one is open, otherwise none. */
function resolveNewChatWorkingDirectory(): string | undefined {
  if (projectStore.workspaceRoot) {
    if (projectStore.scope === 'project' && projectStore.currentPath) {
      return projectStore.currentPath;
    }
    return undefined;
  }
  return projectStore.currentPath ?? undefined;
}

/** User-initiated "new chat".
 *
 *  Behavior:
 *  - shift=true → always create a brand-new session.
 *  - Always create is the default behavior for this app: no untouched composer
 *    reuse is performed from the new-chat control.
 *  - Inside a workspace: opens a session scoped to either the workspace root
 *    (scope='all') or the active project (scope='project'), based on the
 *    sidebar slider.
 *  - Outside a workspace: opens a session scoped to the active project (or
 *    unscoped if no project is open). */
async function newChat(_opts: { shift?: boolean } = {}): Promise<string | null> {
  return createSession({ workingDirectory: resolveNewChatWorkingDirectory() });
}

async function createSession(
  opts: { workingDirectory?: string | null } = {},
): Promise<string | null> {
  if (createSessionPromise) return createSessionPromise;
  createSessionPromise = createSessionRequest(opts);
  try {
    return await createSessionPromise;
  } finally {
    createSessionPromise = null;
  }
}

async function createSessionRequest(
  opts: { workingDirectory?: string | null } = {},
): Promise<string | null> {
  try {
    const workingDirectory = opts.workingDirectory ?? null;
    const res = await apiFetch(apiUrl('/api/sessions'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title: 'New Session',
        ...(workingDirectory ? { workingDirectory } : {}),
      }),
    });
    const text = await res.text();
    if (!res.ok) {
      toastStore.error(friendlyHttpError(res.status, 'create session'));
      return null;
    }
    let data: { ok?: boolean; data?: Session };
    try {
      data = text ? JSON.parse(text) : {};
    } catch (err: unknown) {
      console.debug(
        'Failed to parse create session response:',
        err instanceof Error ? err.message : String(err),
      );
      return null;
    }
    if (data?.ok && data?.data) {
      // Prepend the new session. If the new session is filtered out of the
      // current sidebar view (e.g. it's workspace-level but the slider is on
      // 'project'), flip the slider to 'all' so the user can always see the
      // chat they just created.
      sessions = [data.data, ...sessions];
      activeSessionId = data.data.id;
      saveLastSession(activeSessionId);
      if (
        projectStore.workspaceRoot &&
        projectStore.scope === 'project' &&
        !data.data.workingDirectory
      ) {
        projectStore.setScope('all');
      }
      return data.data.id;
    }
  } catch (err: unknown) {
    console.warn('Failed to create session:', err instanceof Error ? err.message : String(err));
    toastStore.error('Failed to create session');
  }
  return null;
}

async function renameSession(id: string, title: string) {
  try {
    const res = await apiFetch(apiUrl(`/api/sessions/${id}`), {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ title }),
    });
    const data = await res.json();
    if (data.ok) {
      sessions = sessions.map((s) => (s.id === id ? data.data : s));
      toastStore.success('Session renamed');
    }
  } catch (err: unknown) {
    console.warn('Failed to rename session:', err instanceof Error ? err.message : String(err));
    toastStore.error('Failed to rename session');
  }
}

async function setInteractionMode(id: string, interactionMode: 'act' | 'plan'): Promise<boolean> {
  try {
    const res = await apiFetch(apiUrl(`/api/sessions/${id}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ interactionMode }),
    });
    const data = await res.json();
    if (!res.ok || !data?.ok || !data.data) throw new Error('Mode update failed');
    sessions = sessions.map((session) => (session.id === id ? data.data : session));
    return true;
  } catch (err: unknown) {
    console.warn(
      'Failed to set interaction mode:',
      err instanceof Error ? err.message : String(err),
    );
    toastStore.error('Could not change the conversation mode');
    return false;
  }
}

async function deleteSession(id: string) {
  try {
    const res = await apiFetch(apiUrl(`/api/sessions/${id}`), {
      method: 'DELETE',
    });
    const text = await res.text();
    if (!res.ok) {
      let detail = '';
      try {
        const body = text ? JSON.parse(text) : {};
        detail = body.error ?? '';
      } catch (err: unknown) {
        /* ignore */
        console.debug(
          'Failed to parse delete session error body:',
          err instanceof Error ? err.message : String(err),
        );
      }
      toastStore.error(detail || friendlyHttpError(res.status, 'delete session'));
      return;
    }
    deletedSessionIds.add(id);
    sessions = sessions.filter((s) => s.id !== id);
    // Drop the WS subscription so a reconnect does not replay stale events
    // for this session and resurrect it in the sidebar.
    wsStore.unsubscribeFromSession(id);
    if (activeSessionId === id) {
      activeSessionId = sessions[0]?.id ?? '';
      saveLastSession(activeSessionId);
    }
    toastStore.success('Session deleted');
  } catch (err) {
    if (import.meta.env.DEV) console.error('deleteSession exception:', err);
    toastStore.error('Failed to delete session');
  }
}

async function deleteAllSessions(): Promise<boolean> {
  try {
    const res = await apiFetch(apiUrl('/api/sessions'), { method: 'DELETE' });
    const text = await res.text();
    let data: { ok?: boolean; error?: string; deleted?: number } = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch (err: unknown) {
      /* The status-based fallback below remains actionable. */
      console.debug(
        'Failed to parse delete all sessions response:',
        err instanceof Error ? err.message : String(err),
      );
    }
    if (!res.ok || !data.ok) {
      toastStore.error(data.error || friendlyHttpError(res.status, 'delete all sessions'));
      return false;
    }

    for (const session of sessions) {
      deletedSessionIds.add(session.id);
      wsStore.unsubscribeFromSession(session.id);
    }
    sessions = [];
    activeSessionId = '';
    saveLastSession('');
    toastStore.success(
      data.deleted === 1 ? '1 session deleted' : `${data.deleted ?? 0} sessions deleted`,
    );
    return true;
  } catch (err) {
    if (import.meta.env.DEV) console.error('deleteAllSessions exception:', err);
    toastStore.error('Failed to delete all sessions');
    return false;
  }
}

async function fetchMessages(
  sessionId: string,
  signal?: AbortSignal,
): Promise<
  Array<{
    id: string;
    role: string;
    content: string;
    createdAt: number;
    model?: string;
    cost?: number;
    variantGroupId?: string;
    variantIndex?: number;
  }>
> {
  const res = await apiFetch(apiUrl(`/api/messages/${sessionId}`), { signal });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(friendlyHttpError(res.status, 'load chat history'));
  }
  let data: { ok?: boolean; data?: unknown; error?: string };
  try {
    data = text ? JSON.parse(text) : {};
  } catch (err: unknown) {
    console.debug(
      'Failed to parse messages response:',
      err instanceof Error ? err.message : String(err),
    );
    throw new Error('Chat history returned an invalid response.');
  }
  if (!data.ok || !Array.isArray(data.data)) {
    throw new Error(data.error || 'Chat history was not returned by the backend.');
  }
  return data.data;
}

// ─── Session grouping by date ───────────────────────────────────────────────

interface SessionGroup {
  label: string;
  sessions: Session[];
}

function groupByDate(sessionList: Session[]): SessionGroup[] {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterday = today - 86400000;
  const weekAgo = today - 7 * 86400000;

  const groups: Record<string, Session[]> = {
    Today: [],
    Yesterday: [],
    'This week': [],
    Older: [],
  };

  for (const s of sessionList) {
    if (s.updatedAt >= today) groups['Today'].push(s);
    else if (s.updatedAt >= yesterday) groups['Yesterday'].push(s);
    else if (s.updatedAt >= weekAgo) groups['This week'].push(s);
    else groups['Older'].push(s);
  }

  return Object.entries(groups)
    .filter(([, list]) => list.length > 0)
    .map(([label, list]) => ({ label, sessions: list }));
}

// Handle WebSocket updates to sessions
function handleSessionUpdate(session: Session) {
  if (deletedSessionIds.has(session.id)) return;
  const existingIndex = sessions.findIndex((s) => s.id === session.id);
  if (existingIndex >= 0) {
    // Update existing session
    sessions = sessions.map((s) => (s.id === session.id ? session : s));
  } else {
    // Add new session to the list (avoid duplicates from race conditions)
    sessions = [session, ...sessions];
  }
}

function handleSessionDeleted(sessionId: string) {
  deletedSessionIds.add(sessionId);
  sessions = sessions.filter((s) => s.id !== sessionId);
  wsStore.unsubscribeFromSession(sessionId);
  if (activeSessionId === sessionId) {
    activeSessionId = sessions[0]?.id ?? '';
    saveLastSession(activeSessionId);
  }
}

// ─── Exported Store ─────────────────────────────────────────────────────────

export const sessionStore = {
  get sessions() {
    return sessions;
  },
  get activeSessionId() {
    return activeSessionId;
  },
  set activeSessionId(id: string) {
    activeSessionId = id;
    saveLastSession(id);
    const session = sessions.find((item) => item.id === id);
    if (session?.workingDirectory) projectStore.setProject(session.workingDirectory);
  },
  get searchQuery() {
    return searchQuery;
  },
  set searchQuery(q: string) {
    searchQuery = q;
  },
  get loading() {
    return loading;
  },
  get newChatBehavior() {
    return newChatBehavior;
  },
  setNewChatBehavior,

  get filteredSessions(): Session[] {
    // Project scope first: only the open project's chats (legacy sessions with
    // no workingDirectory stay visible in the 'all' scope, never lost).
    let scoped = sessions;
    if (projectStore.scope === 'project' && projectStore.currentPath) {
      scoped = sessions.filter((s) => s.workingDirectory === projectStore.currentPath);
    }
    if (!searchQuery.trim()) return scoped;
    const q = searchQuery.toLowerCase();
    return scoped.filter((s) => s.title.toLowerCase().includes(q));
  },

  /** Sessions belonging to a specific project path (used on project open). */
  sessionsForProject(path: string): Session[] {
    return sessions.filter((s) => s.workingDirectory === path);
  },

  get groupedSessions(): SessionGroup[] {
    return groupByDate(this.filteredSessions);
  },

  /** Demo-mode only: inject canned sessions + active id (no backend). */
  seedDemoSessions(list: Session[], activeId: string) {
    sessions = list;
    activeSessionId = activeId;
  },
  fetchSessions,
  createSession,
  newChat,
  renameSession,
  setInteractionMode,
  deleteSession,
  deleteAllSessions,
  fetchMessages,
  handleSessionUpdate,
  handleSessionDeleted,
};
