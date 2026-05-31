// Session management store — Svelte 5 runes
// Handles CRUD, rename, search, date grouping, message history

import type { Session } from '@koryphaios/shared';
import { toastStore } from './toast.svelte';
import { browser } from '$app/environment';
import { friendlyHttpError } from '$lib/utils/http-error';
import { apiUrl } from '$lib/utils/api-url';
import { apiFetch } from '$lib/api.svelte';

const LAST_SESSION_KEY = 'koryphaios-last-session';

let sessions = $state<Session[]>([]);
let activeSessionId = $state<string>('');
let searchQuery = $state<string>('');
let loading = $state<boolean>(false);

// Load last session from localStorage on startup
function loadLastSession(): string {
  if (!browser) return '';
  try {
    const stored = localStorage.getItem(LAST_SESSION_KEY);
    return stored || '';
  } catch {
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
  } catch {
    // Ignore localStorage errors
  }
}

// ─── API calls ──────────────────────────────────────────────────────────────

/** Returns true if sessions loaded successfully, false otherwise (e.g. backend down). */
async function fetchSessions(): Promise<boolean> {
  if (!browser) return false;
  try {
    const res = await apiFetch(apiUrl('/api/sessions'));
    const text = await res.text();
    if (!res.ok) {
      let detail = '';
      try {
        const body = text ? JSON.parse(text) : {};
        detail = body.detail ?? body.error ?? '';
        if (detail && import.meta.env.DEV) console.error('fetchSessions backend error:', detail);
      } catch {
        /* ignore */
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
    } catch {
      return false;
    }
    if (data?.ok && Array.isArray(data.data)) {
      sessions = data.data;
      // Try to restore last session from localStorage
      const lastSessionId = loadLastSession();

      // If we have a stored session and it still exists, use it
      if (lastSessionId && sessions.find((s) => s.id === lastSessionId)) {
        activeSessionId = lastSessionId;
      } else if (activeSessionId && !sessions.find((s) => s.id === activeSessionId)) {
        // If the active session is no longer in the list, clear it or select the first one
        activeSessionId = sessions[0]?.id ?? '';
      } else if (!activeSessionId && sessions.length > 0) {
        activeSessionId = sessions[0].id;
      }

      // Save the resolved active session
      if (activeSessionId) {
        saveLastSession(activeSessionId);
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

async function createSession(): Promise<string | null> {
  try {
    const res = await apiFetch(apiUrl('/api/sessions'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ title: 'New Session' }),
    });
    const text = await res.text();
    if (!res.ok) {
      toastStore.error(friendlyHttpError(res.status, 'create session'));
      return null;
    }
    let data: { ok?: boolean; data?: Session };
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      return null;
    }
    if (data?.ok && data?.data) {
      sessions = [data.data, ...sessions];
      activeSessionId = data.data.id;
      saveLastSession(activeSessionId);
      return data.data.id;
    }
  } catch {
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
  } catch {
    toastStore.error('Failed to rename session');
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
      } catch {
        /* ignore */
      }
      toastStore.error(detail || friendlyHttpError(res.status, 'delete session'));
      return;
    }
    sessions = sessions.filter((s) => s.id !== id);
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

async function fetchMessages(
  sessionId: string,
): Promise<
  Array<{
    id: string;
    role: string;
    content: string;
    createdAt: number;
    model?: string;
    cost?: number;
  }>
> {
  try {
    const res = await apiFetch(apiUrl(`/api/messages/${sessionId}`));
    const data = await res.json();
    if (data.ok) return data.data;
  } catch {}
  return [];
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
  sessions = sessions.filter((s) => s.id !== sessionId);
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

  get filteredSessions(): Session[] {
    if (!searchQuery.trim()) return sessions;
    const q = searchQuery.toLowerCase();
    return sessions.filter((s) => s.title.toLowerCase().includes(q));
  },

  get groupedSessions(): SessionGroup[] {
    return groupByDate(this.filteredSessions);
  },

  fetchSessions,
  createSession,
  renameSession,
  deleteSession,
  fetchMessages,
  handleSessionUpdate,
  handleSessionDeleted,
};
