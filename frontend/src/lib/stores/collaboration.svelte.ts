import { apiFetch, parseJsonResponse } from '$lib/api.svelte';
import { sessionStore } from './sessions.svelte';
import { toastStore } from './toast.svelte';
import { apiUrl } from '$lib/utils/api-url';
import { copyText } from '$lib/utils/clipboard';
import type { CollaborationPolicy, CollaborationAccessTier } from '@koryphaios/shared';
import {
  activateJoinedTeamSession,
  leaveJoinedTeamSession as removeJoinedTeamSession,
  upsertJoinedTeamSession,
  type JoinedTeamSessionRecord,
} from '$lib/utils/joined-team-sessions';

export type InviteLinks = Record<string, string>;

export type { CollaborationPolicy, CollaborationAccessTier };

export interface PendingPrompt {
  promptId: string;
  guestId: string;
  name: string;
  role: string;
  content: string;
  sessionId: string;
  timestamp: number;
  model?: string;
  reasoningLevel?: string;
}

export interface CollaborationSession {
  id: string;
  baseSessionId: string;
  ownerId: string;
  status: string;
  joinCode: string;
  tunnelUrl: string;
  inviteLinks: InviteLinks;
  relayEnabled: boolean;
  policy: CollaborationPolicy;
}

/**
 * A joined team iframe needs its relay invite URL to resume. That URL is a
 * bearer capability, so keep it in tab-scoped sessionStorage only: it survives
 * a renderer refresh, but is never written as a long-lived local preference.
 */
const JOINED_SESSIONS_STORAGE_KEY = 'koryphaios-joined-team-sessions-v1';
const MAX_JOINED_SESSIONS = 20;

type JoinedSessionStorage = {
  sessions: JoinedTeamSession[];
  activeSessionId: string | null;
};

function sessionStorageOrNull(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function parseJoinedSession(value: unknown): JoinedTeamSession | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Record<string, unknown>;
  const sessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : '';
  const sessionName = typeof input.sessionName === 'string' ? input.sessionName.trim() : '';
  const inviteUrl = typeof input.inviteUrl === 'string' ? input.inviteUrl.trim() : '';
  const tierId = typeof input.tierId === 'string' ? input.tierId.trim() : '';
  const joinedAt = typeof input.joinedAt === 'number' ? input.joinedAt : 0;
  if (!sessionId || !sessionName || !inviteUrl || !tierId || !Number.isFinite(joinedAt)) return null;
  try {
    const protocol = new URL(inviteUrl).protocol;
    if (protocol !== 'https:' && protocol !== 'http:') return null;
  } catch {
    return null;
  }
  return {
    sessionId: sessionId.slice(0, 200),
    sessionName: sessionName.slice(0, 160),
    inviteUrl,
    tierId: tierId.slice(0, 64),
    joinedAt,
  };
}

function loadJoinedSessionsFromStorage(): JoinedSessionStorage {
  const storage = sessionStorageOrNull();
  if (!storage) return { sessions: [], activeSessionId: null };
  try {
    const parsed = JSON.parse(storage.getItem(JOINED_SESSIONS_STORAGE_KEY) ?? 'null') as unknown;
    if (!parsed || typeof parsed !== 'object') return { sessions: [], activeSessionId: null };
    const input = parsed as Record<string, unknown>;
    const sessions = Array.isArray(input.sessions)
      ? input.sessions
          .map(parseJoinedSession)
          .filter((session): session is JoinedTeamSession => session !== null)
          .slice(-MAX_JOINED_SESSIONS)
      : [];
    const requestedActive =
      typeof input.activeSessionId === 'string' ? input.activeSessionId : null;
    return {
      sessions,
      activeSessionId: sessions.some((session) => session.sessionId === requestedActive)
        ? requestedActive
        : null,
    };
  } catch {
    return { sessions: [], activeSessionId: null };
  }
}

function persistJoinedSessions(
  sessions: JoinedTeamSession[],
  activeSessionId: string | null,
): void {
  const storage = sessionStorageOrNull();
  if (!storage) return;
  try {
    storage.setItem(
      JOINED_SESSIONS_STORAGE_KEY,
      JSON.stringify({ sessions: sessions.slice(-MAX_JOINED_SESSIONS), activeSessionId }),
    );
  } catch {
    // The user can keep collaborating in the current renderer when storage is
    // unavailable; do not make a private relay capability fatal to the UI.
  }
}

let activeCollab = $state<CollaborationSession | null>(null);
let loading = $state(false);
let pendingPrompts = $state<PendingPrompt[]>([]);
let pendingJoins = $state<
  Array<{ guestId: string; name: string; tierId: string; timestamp: number }>
>([]);
let participants = $state<
  Array<{ guestId: string; name: string; tierId: string; admitted: boolean }>
>([]);
export interface JoinedTeamSession extends JoinedTeamSessionRecord {}
let joinedSessions = $state<JoinedTeamSession[]>([]);
let activeJoinedSessionId = $state<string | null>(null);
let settingsRequest = $state(0);
let pollInterval: ReturnType<typeof setInterval> | null = null;
let policyRevision = 0;
let restoredHostForSessionId: string | null = null;
let restoreInFlight: Promise<void> | null = null;
let restoredJoinedSessions = false;

function startPollingPending(sessionId: string) {
  stopPollingPending();
  pollInterval = setInterval(async () => {
    try {
      const res = await apiFetch(apiUrl(`/api/collab/${sessionId}/pending`));
      const data = await parseJsonResponse(res);
      if (data.ok) {
        pendingPrompts = data.data?.prompts ?? [];
        pendingJoins = data.data?.joins ?? [];
        participants = data.data?.participants ?? [];
      }
    } catch (err) {
      // Polling failures (network blip, backend restart) are expected; the next tick retries.
      console.debug('Collaboration pending-poll failed:', err);
    }
  }, 3000);
}

function stopPollingPending() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
  pendingPrompts = [];
  pendingJoins = [];
  participants = [];
}

export const collaborationStore = {
  get activeCollab() {
    return activeCollab;
  },
  get loading() {
    return loading;
  },
  get pendingPrompts() {
    return pendingPrompts;
  },
  get pendingJoins() {
    return pendingJoins;
  },
  get participants() {
    return participants;
  },
  get joinedSessions() {
    return joinedSessions;
  },
  get activeJoinedSession() {
    return joinedSessions.find((session) => session.sessionId === activeJoinedSessionId) ?? null;
  },
  get settingsRequest() {
    return settingsRequest;
  },
  requestTeamSettings() {
    settingsRequest += 1;
  },
  openJoinedSession(sessionId: string) {
    activeJoinedSessionId = activateJoinedTeamSession(joinedSessions, sessionId);
    persistJoinedSessions(joinedSessions, activeJoinedSessionId);
  },
  closeJoinedSession() {
    activeJoinedSessionId = null;
    persistJoinedSessions(joinedSessions, activeJoinedSessionId);
  },
  leaveJoinedSession(sessionId: string) {
    const next = removeJoinedTeamSession(joinedSessions, activeJoinedSessionId, sessionId);
    joinedSessions = next.sessions;
    activeJoinedSessionId = next.activeSessionId;
    persistJoinedSessions(joinedSessions, activeJoinedSessionId);
  },

  /** Restore non-secret host controls and tab-scoped joined iframes. */
  async restore(baseSessionId: string | null | undefined): Promise<void> {
    if (!restoredJoinedSessions) {
      const restored = loadJoinedSessionsFromStorage();
      joinedSessions = restored.sessions;
      activeJoinedSessionId = restored.activeSessionId;
      restoredJoinedSessions = true;
    }
    const sessionId = baseSessionId?.trim();
    if (!sessionId || restoredHostForSessionId === sessionId) return;
    if (restoreInFlight) return restoreInFlight;

    restoreInFlight = (async () => {
      try {
        const res = await apiFetch(
          apiUrl(`/api/collab/active?baseSessionId=${encodeURIComponent(sessionId)}`),
        );
        const data = await parseJsonResponse<{ ok?: boolean; data?: CollaborationSession | null }>(res);
        if (data.ok && data.data) {
          activeCollab = data.data;
          startPollingPending(data.data.id);
        } else if (activeCollab?.baseSessionId === sessionId) {
          activeCollab = null;
          stopPollingPending();
        }
        restoredHostForSessionId = sessionId;
      } catch (err: unknown) {
        // Keep the existing controls if a transient boot/restart race loses the
        // first request; the next active-session change may retry.
        console.debug(
          'Collaboration host restore failed:',
          err instanceof Error ? err.message : String(err),
        );
      } finally {
        restoreInFlight = null;
      }
    })();
    return restoreInFlight;
  },

  async hostSession(workspacePaths: string[] = []) {
    const sessionId = sessionStore.activeSessionId;
    if (!sessionId) {
      toastStore.error('No active session to host');
      return false;
    }

    loading = true;
    try {
      const res = await apiFetch(apiUrl('/api/collab/host/start'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, workspacePaths }),
      });
      const data = await parseJsonResponse(res);
      if (data.ok) {
        activeCollab = data.data;
        restoredHostForSessionId = data.data.baseSessionId;
        toastStore.success('Collaboration session started!');
        startPollingPending(data.data.id);
        return true;
      } else {
        toastStore.error(data.error || 'Failed to start session');
        return false;
      }
    } catch (err: unknown) {
      toastStore.error((err instanceof Error ? err.message : String(err)) || 'Network error');
      return false;
    } finally {
      loading = false;
    }
  },

  async approvePrompt(promptId: string, approved: boolean) {
    if (!activeCollab) return;
    try {
      const res = await apiFetch(apiUrl(`/api/collab/${activeCollab.id}/approve`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ promptId, approved }),
      });
      const data = await parseJsonResponse(res);
      if (data.ok) {
        pendingPrompts = pendingPrompts.filter((p) => p.promptId !== promptId);
        if (approved && data.data?.prompt?.content) {
          toastStore.info(`Guest prompt queued: "${data.data.prompt.content.slice(0, 60)}..."`);
        }
      }
    } catch (err: unknown) {
      toastStore.error(
        (err instanceof Error ? err.message : String(err)) || 'Failed to respond to prompt',
      );
    }
  },

  copyInviteLink(role: keyof InviteLinks) {
    const link = activeCollab?.inviteLinks?.[role];
    if (!link) {
      toastStore.error('No invite link — relay not configured');
      return;
    }
    copyText(link).then(() => {
      toastStore.success(`${role.charAt(0).toUpperCase() + role.slice(1)} invite link copied!`);
    });
  },

  copyJoinCode() {
    const code = activeCollab?.joinCode;
    if (!code) return;
    copyText(code).then(() => toastStore.success('Native join code copied'));
  },

  async updatePolicy(patch: Partial<CollaborationPolicy>, quiet = false) {
    if (!activeCollab) return;
    const revision = ++policyRevision;
    const previous = activeCollab;
    activeCollab = { ...activeCollab, policy: { ...activeCollab.policy, ...patch } };
    try {
      const res = await apiFetch(apiUrl(`/api/collab/${activeCollab.id}/policy`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const data = await parseJsonResponse(res);
      if (!data.ok) throw new Error(data.error || 'Policy update failed');
      if (revision === policyRevision && activeCollab)
        activeCollab = { ...activeCollab, policy: data.data };
    } catch (err: unknown) {
      if (revision === policyRevision) activeCollab = previous;
      if (!quiet)
        toastStore.error(
          (err instanceof Error ? err.message : String(err)) || 'Policy update failed',
        );
    }
  },

  async decideJoin(guestId: string, approved: boolean, tierId?: string) {
    if (!activeCollab) return;
    const res = await apiFetch(apiUrl(`/api/collab/${activeCollab.id}/join-decision`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ guestId, approved, tierId }),
    });
    const data = await parseJsonResponse(res);
    if (data.ok) pendingJoins = pendingJoins.filter((join) => join.guestId !== guestId);
    else toastStore.error(data.error || 'Could not resolve join request');
  },

  async assignTier(guestId: string, tierId: string) {
    if (!activeCollab) return;
    const res = await apiFetch(apiUrl(`/api/collab/${activeCollab.id}/assign-tier`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ guestId, tierId }),
    });
    const data = await parseJsonResponse(res);
    if (data.ok)
      participants = participants.map((p) => (p.guestId === guestId ? { ...p, tierId } : p));
    else toastStore.error(data.error || 'Could not assign profile');
  },

  async createInvite(tierId: string) {
    if (!activeCollab) return;
    const existing = activeCollab.inviteLinks[tierId as keyof InviteLinks];
    if (existing) {
      await copyText(existing);
      toastStore.success('Invite link copied');
      return;
    }
    const res = await apiFetch(apiUrl(`/api/collab/${activeCollab.id}/invite`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tierId }),
    });
    const data = await parseJsonResponse(res);
    if (data.ok) {
      activeCollab = {
        ...activeCollab,
        inviteLinks: { ...activeCollab.inviteLinks, [tierId]: data.data.url },
      };
      await copyText(data.data.url);
      toastStore.success('Invite link copied');
    } else toastStore.error(data.error || 'Could not create invite');
  },

  async joinSession(joinCode: string, name: string) {
    loading = true;
    try {
      const res = await apiFetch(apiUrl(`/api/collab/join`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          joinCode: joinCode.trim().toUpperCase(),
          userId: 'guest-' + Date.now(),
          name,
        }),
      });
      const data = await parseJsonResponse(res);
      if (data.ok) {
        toastStore.success('Join code accepted');
        const joined: JoinedTeamSession = {
          sessionId: data.data.sessionId,
          sessionName: data.data.sessionName || 'Team session',
          inviteUrl: data.data.inviteUrl,
          tierId: data.data.tierId || 'viewer',
          joinedAt: Date.now(),
        };
        joinedSessions = upsertJoinedTeamSession(joinedSessions, joined);
        activeJoinedSessionId = joined.sessionId;
        persistJoinedSessions(joinedSessions, activeJoinedSessionId);
        return data.data;
      } else {
        toastStore.error(data.error || 'Failed to join session');
        return null;
      }
    } catch (err: unknown) {
      toastStore.error((err instanceof Error ? err.message : String(err)) || 'Network error');
      return null;
    } finally {
      loading = false;
    }
  },

  async endSession() {
    if (!activeCollab) return;
    loading = true;
    try {
      await apiFetch(apiUrl(`/api/collab/${activeCollab.id}/end`), { method: 'POST' });
      activeCollab = null;
      restoredHostForSessionId = null;
      stopPollingPending();
      toastStore.info('Collaboration ended');
    } catch (err: unknown) {
      toastStore.error((err instanceof Error ? err.message : String(err)) || 'Network error');
    } finally {
      loading = false;
    }
  },
};
