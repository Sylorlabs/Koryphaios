// Session management store — Svelte 5 runes
// Handles CRUD, rename, search, date grouping, message history

import type { Session } from '@koryphaios/shared';
import { toastStore } from './toast.svelte';
import { projectStore } from './project.svelte';
import { resolveSessionSelection } from './session-selection';
import { browser } from '$app/environment';
import { friendlyHttpError } from '$lib/utils/http-error';
import { apiUrl } from '$lib/utils/api-url';
import { apiFetch } from '$lib/api.svelte';
import { wsStore } from './websocket.svelte';
import { loadLastSessionId, saveLastSessionId } from './navigation-preferences';
import {
  parseMessageDisplayProjection,
  type DisplayMessage,
  type MessageDisplayBoundary,
} from '$lib/utils/message-variants';

const NEW_CHAT_BEHAVIOR_KEY = 'koryphaios-new-chat-behavior';

export type NewChatBehavior = 'always-create';

export type LifecycleSession = Session & {
  status?: 'active' | 'archived';
  archivedAt?: number;
};

let sessions = $state<LifecycleSession[]>([]);
let archivedSessions = $state<LifecycleSession[]>([]);
let activeSessionId = $state<string>('');
let searchQuery = $state<string>('');
let loading = $state<boolean>(false);
let archivedLoading = $state<boolean>(false);
let archivedLoaded = $state<boolean>(false);
let archivedError = $state<string | null>(null);
let createSessionPromise: Promise<string | null> | null = null;
let fetchGeneration = 0;
let archivedFetchGeneration = 0;
let hasRestoredInitialSession = false;
// A websocket update can already be in flight when a session is deleted.
// Keep a short-lived tombstone until the next authoritative list confirms the
// row is gone, rather than allowing that stale event to recreate it in the UI.
const deletedSessionIds = new Set<string>();
// Archiving, like deletion, removes a row from the active projection. Keep a
// lifecycle tombstone so an older session.updated event cannot put that row
// back in the sidebar before the archive/restore revision reaches the client.
const archivedSessionIds = new Set<string>();
const latestSessionVersions = new Map<string, number>();
// Bind boundary metadata to the exact history snapshot that carried it. A
// session-keyed cache lets concurrent reloads pair an older message array with
// a newer CAS boundary (or vice versa), which is unsafe for branch activation.
const messageDisplayBoundaries = new WeakMap<DisplayMessage[], MessageDisplayBoundary>();

function lifecycleVersion(session: LifecycleSession): number | null {
  return typeof session.version === 'number' ? session.version : null;
}

function rememberVersion(session: LifecycleSession): void {
  const version = lifecycleVersion(session);
  if (version === null) return;
  const current = latestSessionVersions.get(session.id);
  if (current === undefined || version >= current) latestSessionVersions.set(session.id, version);
}

function isStaleLifecycleUpdate(session: LifecycleSession): boolean {
  const version = lifecycleVersion(session);
  const current = latestSessionVersions.get(session.id);
  return version !== null && current !== undefined && version < current;
}

function archivedTimestamp(session: LifecycleSession): number {
  return session.archivedAt ?? session.updatedAt;
}

function sortActive(list: LifecycleSession[]): LifecycleSession[] {
  return [...list].sort((left, right) => right.updatedAt - left.updatedAt);
}

function sortArchived(list: LifecycleSession[]): LifecycleSession[] {
  return [...list].sort((left, right) => archivedTimestamp(right) - archivedTimestamp(left));
}

function upsertSession(
  list: LifecycleSession[],
  session: LifecycleSession,
  sorter: (items: LifecycleSession[]) => LifecycleSession[],
): LifecycleSession[] {
  const next = list.some((item) => item.id === session.id)
    ? list.map((item) => (item.id === session.id ? session : item))
    : [session, ...list];
  return sorter(next);
}

function replacementSessionId(remaining: LifecycleSession[]): string {
  if (projectStore.scope === 'project' && projectStore.currentPath) {
    return (
      remaining.find((session) => session.workingDirectory === projectStore.currentPath)?.id ?? ''
    );
  }
  return remaining[0]?.id ?? '';
}

function removeFromActiveProjection(id: string): void {
  sessions = sessions.filter((session) => session.id !== id);
  wsStore.unsubscribeFromSession(id);
  if (activeSessionId === id) {
    activeSessionId = replacementSessionId(sessions);
    saveLastSession(activeSessionId);
  }
}

function responseDetail(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  const record = body as Record<string, unknown>;
  for (const key of ['detail', 'error', 'message']) {
    if (typeof record[key] === 'string' && record[key]) return record[key];
  }
  return '';
}

function parseResponseBody(text: string): Record<string, unknown> {
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function invalidateSessionFetches(): void {
  fetchGeneration += 1;
  archivedFetchGeneration += 1;
  archivedLoading = false;
}

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

// Active-session navigation is derived from the backend's authoritative
// updated order. Browser storage contains only an opaque id and is always
// validated against that authoritative list before it can be restored.
function loadLastSession(): string {
  return loadLastSessionId();
}

function saveLastSession(id: string): void {
  saveLastSessionId(id);
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
      toastStore.error(detail || friendlyHttpError(res.status, 'load sessions'), {
        onRetry: () => void fetchSessions(),
      });
      return false;
    }
    if (!text.trim()) return false;
    let data: { ok?: boolean; data?: LifecycleSession[] };
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
      for (const session of data.data) {
        rememberVersion(session);
        // GET /api/sessions is the authoritative active projection. A returned
        // id therefore confirms that a restore completed, even for a legacy
        // response that does not yet include an explicit status field.
        if (session.status !== 'archived') archivedSessionIds.delete(session.id);
        else archivedSessionIds.add(session.id);
      }
      sessions = sortActive(
        data.data.filter(
          (session) =>
            session.status !== 'archived' &&
            !deletedSessionIds.has(session.id) &&
            !archivedSessionIds.has(session.id),
        ),
      );
      const storedSessionId = hasRestoredInitialSession ? '' : loadLastSession();
      hasRestoredInitialSession = true;
      activeSessionId = resolveSessionSelection({
        storedSessionId,
        currentActiveId: activeSessionId,
        sessionIds: sessions.map((s) => s.id),
      });
      // Selection invariants live in resolveSessionSelection (session-selection.ts):
      // stored restore wins, vanished actives clear, empty stays empty.

      // Save the resolved active session
      if (activeSessionId) {
        saveLastSession(activeSessionId);
        // Project/workspace navigation is restored through the authenticated
        // backend workspace state, never a browser cache or an unchecked
        // session path. The page reconciler handles the selected session.
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

/** Load the settings-only archived projection without mixing it into the
 * active sidebar list. Returns false with an inspectable error for retry UI. */
async function fetchArchivedSessions(): Promise<boolean> {
  if (!browser) return false;
  const myGeneration = ++archivedFetchGeneration;
  archivedLoading = true;
  archivedError = null;
  try {
    const res = await apiFetch(apiUrl('/api/sessions/archived'));
    const text = await res.text();
    const body = parseResponseBody(text);
    if (!res.ok || body.ok !== true || !Array.isArray(body.data)) {
      if (myGeneration !== archivedFetchGeneration) return false;
      archivedError = responseDetail(body) || friendlyHttpError(res.status, 'load archived chats');
      return false;
    }

    if (myGeneration !== archivedFetchGeneration) return true;
    const returned = body.data as LifecycleSession[];
    for (const session of returned) {
      rememberVersion(session);
      archivedSessionIds.add(session.id);
    }
    archivedSessions = sortArchived(
      returned.filter((session) => !deletedSessionIds.has(session.id)),
    );
    // A server-side archive is authoritative even if this window did not
    // initiate it. Remove those rows from the active projection now.
    const archivedIds = new Set(returned.map((session) => session.id));
    const activeWasArchived = activeSessionId ? archivedIds.has(activeSessionId) : false;
    sessions = sessions.filter((session) => !archivedIds.has(session.id));
    if (activeWasArchived) {
      wsStore.unsubscribeFromSession(activeSessionId);
      activeSessionId = replacementSessionId(sessions);
      saveLastSession(activeSessionId);
    }
    archivedLoaded = true;
    return true;
  } catch (err: unknown) {
    if (myGeneration !== archivedFetchGeneration) return false;
    archivedError = err instanceof Error ? err.message : 'Failed to load archived chats';
    return false;
  } finally {
    if (myGeneration === archivedFetchGeneration) archivedLoading = false;
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
    return projectStore.workspaceRoot ?? undefined;
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

async function renameSession(id: string, title: string): Promise<boolean> {
  try {
    const res = await apiFetch(apiUrl(`/api/sessions/${id}`), {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ title }),
    });
    const text = await res.text();
    const data = parseResponseBody(text);
    if (!res.ok || data.ok !== true) {
      toastStore.error(responseDetail(data) || friendlyHttpError(res.status, 'rename chat'));
      return false;
    }

    const current =
      sessions.find((session) => session.id === id) ??
      archivedSessions.find((session) => session.id === id);
    const updated =
      data.data && typeof data.data === 'object'
        ? (data.data as LifecycleSession)
        : current
          ? { ...current, title }
          : null;
    if (updated) {
      rememberVersion(updated);
      archivedFetchGeneration += 1;
      archivedLoading = false;
      sessions = sessions.map((session) => (session.id === id ? updated : session));
      archivedSessions = archivedSessions.map((session) => (session.id === id ? updated : session));
    }
    toastStore.success('Chat renamed');
    return true;
  } catch (err: unknown) {
    console.warn('Failed to rename session:', err instanceof Error ? err.message : String(err));
    toastStore.error('Failed to rename chat');
    return false;
  }
}

async function archiveSession(id: string): Promise<boolean> {
  const current = sessions.find((session) => session.id === id);
  if (!current) return false;
  try {
    const res = await apiFetch(apiUrl(`/api/sessions/${id}/archive`), { method: 'POST' });
    const text = await res.text();
    const body = parseResponseBody(text);
    if (!res.ok || body.ok !== true) {
      toastStore.error(responseDetail(body) || friendlyHttpError(res.status, 'archive chat'));
      return false;
    }

    const archived =
      body.data && typeof body.data === 'object'
        ? (body.data as LifecycleSession)
        : ({ ...current, status: 'archived', archivedAt: Date.now() } satisfies LifecycleSession);
    rememberVersion(archived);
    invalidateSessionFetches();
    archivedSessionIds.add(id);
    archivedSessions = upsertSession(archivedSessions, archived, sortArchived);
    removeFromActiveProjection(id);
    toastStore.success('Chat archived', {
      duration: 8000,
      action: () => void restoreSession(id),
      actionLabel: 'Undo',
    });
    return true;
  } catch (err: unknown) {
    console.warn('Failed to archive session:', err instanceof Error ? err.message : String(err));
    toastStore.error('Failed to archive chat');
    return false;
  }
}

async function restoreSession(id: string): Promise<boolean> {
  const current = archivedSessions.find((session) => session.id === id);
  try {
    const res = await apiFetch(apiUrl(`/api/sessions/${id}/restore`), { method: 'POST' });
    const text = await res.text();
    const body = parseResponseBody(text);
    if (!res.ok || body.ok !== true) {
      toastStore.error(responseDetail(body) || friendlyHttpError(res.status, 'restore chat'));
      return false;
    }

    const restoredFallback = current
      ? (({ archivedAt: _archivedAt, ...session }) => ({
          ...session,
          status: 'active' as const,
        }))(current)
      : null;
    const restored =
      body.data && typeof body.data === 'object'
        ? (body.data as LifecycleSession)
        : restoredFallback;
    if (!restored) {
      toastStore.error('The restored chat was not returned by the backend');
      return false;
    }
    rememberVersion(restored);
    invalidateSessionFetches();
    deletedSessionIds.delete(id);
    archivedSessionIds.delete(id);
    archivedSessions = archivedSessions.filter((session) => session.id !== id);
    sessions = upsertSession(sessions, restored, sortActive);
    toastStore.success('Chat restored to the sidebar');
    return true;
  } catch (err: unknown) {
    console.warn('Failed to restore session:', err instanceof Error ? err.message : String(err));
    toastStore.error('Failed to restore chat');
    return false;
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

async function deleteSession(id: string): Promise<boolean> {
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
      return false;
    }
    deletedSessionIds.add(id);
    invalidateSessionFetches();
    archivedSessionIds.delete(id);
    archivedSessions = archivedSessions.filter((session) => session.id !== id);
    removeFromActiveProjection(id);
    toastStore.success('Chat deleted');
    return true;
  } catch (err) {
    if (import.meta.env.DEV) console.error('deleteSession exception:', err);
    toastStore.error('Failed to delete chat');
    return false;
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

    for (const session of [...sessions, ...archivedSessions]) {
      deletedSessionIds.add(session.id);
      wsStore.unsubscribeFromSession(session.id);
    }
    sessions = [];
    archivedSessions = [];
    archivedSessionIds.clear();
    archivedLoaded = true;
    archivedError = null;
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

async function fetchMessages(sessionId: string, signal?: AbortSignal): Promise<DisplayMessage[]> {
  const res = await apiFetch(apiUrl(`/api/messages/${sessionId}`), { signal });
  const text = await res.text();
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
  if (!res.ok || !data.ok) {
    throw new Error(data.error || friendlyHttpError(res.status, 'load chat history'));
  }
  try {
    const projection = parseMessageDisplayProjection(data.data);
    messageDisplayBoundaries.set(projection.messages, projection.boundary);
    return projection.messages;
  } catch (error) {
    if (error instanceof Error) throw error;
    throw new Error(data.error || 'Chat history was not returned by the backend.');
  }
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
function handleSessionUpdate(session: LifecycleSession) {
  if (deletedSessionIds.has(session.id)) return;
  if (isStaleLifecycleUpdate(session)) return;
  rememberVersion(session);

  const belongsToArchive =
    session.status === 'archived' ||
    (session.status !== 'active' && archivedSessionIds.has(session.id));
  if (belongsToArchive) {
    invalidateSessionFetches();
    archivedSessionIds.add(session.id);
    archivedSessions = upsertSession(archivedSessions, session, sortArchived);
    removeFromActiveProjection(session.id);
    return;
  }

  const wasArchived = archivedSessionIds.has(session.id);
  if (wasArchived) invalidateSessionFetches();
  archivedSessionIds.delete(session.id);
  archivedSessions = archivedSessions.filter((item) => item.id !== session.id);
  sessions = upsertSession(sessions, session, sortActive);
}

function handleSessionDeleted(sessionId: string) {
  deletedSessionIds.add(sessionId);
  archivedSessionIds.delete(sessionId);
  archivedSessions = archivedSessions.filter((session) => session.id !== sessionId);
  removeFromActiveProjection(sessionId);
}

// ─── Exported Store ─────────────────────────────────────────────────────────

export const sessionStore = {
  get sessions() {
    return sessions;
  },
  get archivedSessions() {
    return archivedSessions;
  },
  get archivedLoading() {
    return archivedLoading;
  },
  get archivedLoaded() {
    return archivedLoaded;
  },
  get archivedError() {
    return archivedError;
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
  seedDemoSessions(list: LifecycleSession[], activeId: string) {
    sessions = list;
    archivedSessions = [];
    activeSessionId = activeId;
    archivedError = null;
    archivedLoaded = false;
    archivedSessionIds.clear();
    deletedSessionIds.clear();
    latestSessionVersions.clear();
    for (const session of list) rememberVersion(session);
  },
  fetchSessions,
  fetchArchivedSessions,
  createSession,
  newChat,
  renameSession,
  archiveSession,
  restoreSession,
  setInteractionMode,
  deleteSession,
  deleteAllSessions,
  fetchMessages,
  getMessageDisplayBoundary(messages: DisplayMessage[]): MessageDisplayBoundary | undefined {
    return messageDisplayBoundaries.get(messages);
  },
  handleSessionUpdate,
  handleSessionDeleted,
};
