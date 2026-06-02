import { apiFetch, parseJsonResponse } from '$lib/api.svelte';
import { sessionStore } from './sessions.svelte';
import { toastStore } from './toast.svelte';
import { apiUrl } from '$lib/utils/api-url';

export interface InviteLinks {
  viewer: string;
  collaborator: string;
  copilot: string;
}

export interface PendingPrompt {
  promptId: string;
  guestId: string;
  name: string;
  role: string;
  content: string;
  sessionId: string;
  timestamp: number;
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
}

let activeCollab = $state<CollaborationSession | null>(null);
let loading = $state(false);
let pendingPrompts = $state<PendingPrompt[]>([]);
let pollInterval: ReturnType<typeof setInterval> | null = null;

function startPollingPending(sessionId: string) {
  stopPollingPending();
  pollInterval = setInterval(async () => {
    try {
      const res = await apiFetch(apiUrl(`/api/collab/${sessionId}/pending`));
      const data = await parseJsonResponse(res);
      if (data.ok) pendingPrompts = data.data ?? [];
    } catch {}
  }, 3000);
}

function stopPollingPending() {
  if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
  pendingPrompts = [];
}

export const collaborationStore = {
  get activeCollab() { return activeCollab; },
  get loading() { return loading; },
  get pendingPrompts() { return pendingPrompts; },

  async hostSession() {
    const sessionId = sessionStore.activeSessionId;
    if (!sessionId) { toastStore.error('No active session to host'); return; }

    loading = true;
    try {
      const res = await apiFetch(apiUrl(`/api/collab/${sessionId}/start`), { method: 'POST' });
      const data = await parseJsonResponse(res);
      if (data.ok) {
        activeCollab = data.data;
        toastStore.success('Collaboration session started!');
        startPollingPending(data.data.id);
      } else {
        toastStore.error(data.error || 'Failed to start session');
      }
    } catch (err: any) {
      toastStore.error(err.message || 'Network error');
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
        pendingPrompts = pendingPrompts.filter(p => p.promptId !== promptId);
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
    if (!link) { toastStore.error('No invite link — relay not configured'); return; }
    navigator.clipboard.writeText(link).then(() => {
      toastStore.success(`${role.charAt(0).toUpperCase() + role.slice(1)} invite link copied!`);
    });
  },

  async joinSession(joinCode: string, name: string) {
    loading = true;
    try {
      const res = await apiFetch(apiUrl(`/api/collab/join`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ joinCode, userId: 'guest-' + Date.now(), name }),
      });
      const data = await parseJsonResponse(res);
      if (data.ok) {
        toastStore.success('Joined session — use the invite link to view the live feed');
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
