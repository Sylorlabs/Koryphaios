import { apiFetch, parseJsonResponse } from '$lib/api.svelte';
import { sessionStore } from './sessions.svelte';
import { toastStore } from './toast.svelte';
import { apiUrl } from '$lib/utils/api-url';

interface CollaborationSession {
  id: string;
  baseSessionId: string;
  ownerId: string;
  status: string;
  joinCode: string;
  tunnelUrl: string;
}

let activeCollab = $state<CollaborationSession | null>(null);
let loading = $state(false);

export const collaborationStore = {
  get activeCollab() {
    return activeCollab;
  },
  get loading() {
    return loading;
  },

  async hostSession() {
    const sessionId = sessionStore.activeSessionId;
    if (!sessionId) {
      toastStore.error('No active session to host');
      return;
    }

    loading = true;
    try {
      const res = await apiFetch(apiUrl(`/api/collab/${sessionId}/start`), { method: 'POST' });
      const data = await parseJsonResponse(res);
      if (data.ok) {
        activeCollab = data.data;
        toastStore.success('Collaboration session started!');
      } else {
        toastStore.error(data.error || 'Failed to start session');
      }
    } catch (err: any) {
      toastStore.error(err.message || 'Network error');
    } finally {
      loading = false;
    }
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
        toastStore.success('Joined session successfully!');
        // We'll need to hook up a remote websocket here later
        // For now, this just validates the code works
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
      toastStore.info('Collaboration ended');
    } catch (err: any) {
      toastStore.error(err.message || 'Network error');
    } finally {
      loading = false;
    }
  },
};
