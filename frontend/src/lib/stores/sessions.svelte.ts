// Session management store — Svelte 5 runes
// Handles CRUD, rename, search, date grouping, message history

import type { Session } from '@koryphaios/shared';
import { toastStore } from './toast.svelte';
import { browser } from '$app/environment';

let sessions = $state<Session[]>([]);
let activeSessionId = $state<string>('');
let searchQuery = $state<string>('');
let loading = $state<boolean>(false);

// ─── API calls ──────────────────────────────────────────────────────────────

async function fetchSessions() {
  if (!browser) return;
  
  loading = true;
  try {
    const res = await fetch('/api/sessions', { signal: AbortSignal.timeout(5000) });
    if (!res.ok) {
      const text = await res.text();
      console.error('fetchSessions failed', { status: res.status, body: text });
      toastStore.error(`Failed to load sessions (${res.status})`);
      loading = false;
      return;
    }
    const data = await res.json();
    if (data.ok && Array.isArray(data.data)) {
      sessions = data.data;
      // Auto-select first session if none active
      if (!activeSessionId && sessions.length > 0) {
        activeSessionId = sessions[0].id;
      } else if (sessions.length === 0) {
        // Create first session if none exist
        void createSession();
      }
    }
  } catch (err) {
    console.error('fetchSessions exception', err);
    toastStore.error('Failed to load sessions');
  } finally {
    loading = false;
  }
}

async function createSession(): Promise<string | null> {
  try {
    const res = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'New Session' }),
    });
    const data = await res.json();
    if (data.ok) {
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
      headers: { 'Content-Type': 'application/json' },
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
    await fetch(`/api/sessions/${id}`, { method: 'DELETE' });
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
    const res = await fetch(`/api/sessions/${sessionId}/messages`);
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
    'This Week': [],
    'Older': [],
  };

  for (const s of sessionList) {
    if (s.updatedAt >= today) groups['Today'].push(s);
    else if (s.updatedAt >= yesterday) groups['Yesterday'].push(s);
    else if (s.updatedAt >= weekAgo) groups['This Week'].push(s);
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
