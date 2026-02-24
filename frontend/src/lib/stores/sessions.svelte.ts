// Session management store — Svelte 5 runes
// Handles CRUD, rename, search, date grouping, message history

import type { Session } from '@koryphaios/shared';
import { toastStore } from './toast.svelte';
import { authStore } from './auth.svelte';
import { browser } from '$app/environment';

let sessions = $state<Session[]>([]);
let activeSessionId = $state<string>('');
let searchQuery = $state<string>('');
let loading = $state<boolean>(false);

// ─── API calls ──────────────────────────────────────────────────────────────

/** Returns true if sessions loaded successfully, false otherwise (e.g. backend down). */
async function fetchSessions(): Promise<boolean> {
  if (!browser) return false;
  try {
    const res = await fetch('/api/sessions', {
      headers: authStore.token ? { 'Authorization': `Bearer ${authStore.token}` } : {},
    });
    const text = await res.text();
    if (!res.ok) {
      if (!(res.status === 500 && !text.trim())) {
        console.error('fetchSessions failed', { status: res.status, body: text || '(empty)' });
      }
      toastStore.error(`Failed to load sessions (${res.status})`);
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
      if (!activeSessionId && sessions.length > 0) {
        activeSessionId = sessions[0].id;
      } else if (sessions.length === 0) {
        void createSession();
      }
      return true;
    }
    return false;
  } catch (err) {
    console.error('fetchSessions exception', err);
    toastStore.error('Failed to load sessions');
    return false;
  }
}

async function createSession(): Promise<string | null> {
  try {
    const res = await fetch('/api/sessions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(authStore.token ? { 'Authorization': `Bearer ${authStore.token}` } : {}),
      },
      body: JSON.stringify({ title: 'New Session' }),
    });
    const text = await res.text();
    if (!res.ok) {
      toastStore.error(`Failed to create session (${res.status})`);
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
      return data.data.id;
    }
  } catch {
    toastStore.error('Failed to create session');
  }
  return null;
}

async function renameSession(id: string, title: string) {
  try {
    const res = await fetch(`/api/sessions/${id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        ...(authStore.token ? { 'Authorization': `Bearer ${authStore.token}` } : {}),
      },
      body: JSON.stringify({ title }),
    });
    const data = await res.json();
    if (data.ok) {
      sessions = sessions.map(s => s.id === id ? data.data : s);
      toastStore.success('Session renamed');
    }
  } catch {
    toastStore.error('Failed to rename session');
  }
}

async function deleteSession(id: string) {
  try {
    await fetch(`/api/sessions/${id}`, {
      method: 'DELETE',
      headers: authStore.token ? { 'Authorization': `Bearer ${authStore.token}` } : {},
    });
    sessions = sessions.filter(s => s.id !== id);
    if (activeSessionId === id) {
      activeSessionId = sessions[0]?.id ?? '';
    }
    toastStore.success('Session deleted');
  } catch {
    toastStore.error('Failed to delete session');
  }
}

async function fetchMessages(sessionId: string): Promise<Array<{ id: string; role: string; content: string; createdAt: number; model?: string; cost?: number }>> {
  try {
    const res = await fetch(`/api/sessions/${sessionId}/messages`, {
      headers: authStore.token ? { 'Authorization': `Bearer ${authStore.token}` } : {},
    });
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
    'Today': [],
    'Yesterday': [],
    'This week': [],
    'Older': [],
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
  sessions = sessions.map(s => s.id === session.id ? session : s);
}

function handleSessionDeleted(sessionId: string) {
  sessions = sessions.filter(s => s.id !== sessionId);
  if (activeSessionId === sessionId) {
    activeSessionId = sessions[0]?.id ?? '';
  }
}

// ─── Exported Store ─────────────────────────────────────────────────────────

export const sessionStore = {
  get sessions() { return sessions; },
  get activeSessionId() { return activeSessionId; },
  set activeSessionId(id: string) { activeSessionId = id; },
  get searchQuery() { return searchQuery; },
  set searchQuery(q: string) { searchQuery = q; },
  get loading() { return loading; },

  get filteredSessions(): Session[] {
    if (!searchQuery.trim()) return sessions;
    const q = searchQuery.toLowerCase();
    return sessions.filter(s => s.title.toLowerCase().includes(q));
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
