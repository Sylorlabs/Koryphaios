import { apiFetch, parseJsonResponse } from '$lib/api.svelte';
import { sessionStore } from './sessions.svelte';
import { toastStore } from './toast.svelte';
import { apiUrl } from '$lib/utils/api-url';
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
    } catch {}
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
  },
  closeJoinedSession() {
    activeJoinedSessionId = null;
  },
  leaveJoinedSession(sessionId: string) {
    const next = removeJoinedTeamSession(joinedSessions, activeJoinedSessionId, sessionId);
    joinedSessions = next.sessions;
    activeJoinedSessionId = next.activeSessionId;
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
        toastStore.success('Collaboration session started!');
        startPollingPending(data.data.id);
        return true;
      } else {
        toastStore.error(data.error || 'Failed to start session');
        return false;
      }
    } catch (err: any) {
      toastStore.error(err.message || 'Network error');
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
    } catch (err: any) {
      toastStore.error(err.message || 'Failed to respond to prompt');
    }
  },

  copyInviteLink(role: keyof InviteLinks) {
    const link = activeCollab?.inviteLinks?.[role];
    if (!link) {
      toastStore.error('No invite link — relay not configured');
      return;
    }
    navigator.clipboard.writeText(link).then(() => {
      toastStore.success(`${role.charAt(0).toUpperCase() + role.slice(1)} invite link copied!`);
    });
  },

  copyJoinCode() {
    const code = activeCollab?.joinCode;
    if (!code) return;
    navigator.clipboard.writeText(code).then(() => toastStore.success('Native join code copied'));
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
    } catch (err: any) {
      if (revision === policyRevision) activeCollab = previous;
      if (!quiet) toastStore.error(err.message || 'Policy update failed');
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
      await navigator.clipboard.writeText(existing);
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
      await navigator.clipboard.writeText(data.data.url);
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
        return data.data;
      } else {
        toastStore.error(data.error || 'Failed to join session');
        return null;
      }
    } catch (err: any) {
      toastStore.error(err.message || 'Network error');
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
      stopPollingPending();
      toastStore.info('Collaboration ended');
    } catch (err: any) {
      toastStore.error(err.message || 'Network error');
    } finally {
      loading = false;
    }
  },
};
