// ConductorActions backed by the app's existing stores. Nothing here invents a
// backend call: every action is a store function the UI already uses, and
// every chat-bound one is called with the sessionId the controller captured.
//
// Loaded lazily by the conductor store so importing the conductor (from the
// composer, for example) does not pull the whole store graph into tests.

import type { ConductorActions } from './controller';
import type { ConductorPanel } from './grammar';
import { sessionStore } from '$lib/stores/sessions.svelte';
import { wsStore, feedStore } from '$lib/stores/websocket.svelte';
import { agentStore } from '$lib/stores/agents.svelte';
import { runStateStore } from '$lib/stores/run-state.svelte';
import { notesStore } from '$lib/stores/notes.svelte';
import { apiFetch } from '$lib/api.svelte';
import { apiUrl } from '$lib/utils/api-url';
import { playVoiceResponse, stopVoicePlayback } from '$lib/utils/voice-playback';

const MANAGER_ID = 'kory-manager';

/** The page supplies what only it knows: the composer's model selection and
 *  the send checks that come with it. */
export interface ConductorHost {
  steerManager?(sessionId: string, text: string): Promise<boolean>;
}

/** Event the shell listens for to show a panel; a handler calls
 *  preventDefault() to say it handled the request. */
export const OPEN_PANEL_EVENT = 'kory:open-panel';

export function createStoreActions(host: () => ConductorHost | null): ConductorActions {
  return {
    activeSessionId: () => sessionStore.activeSessionId,

    listWorkers: (sessionId) =>
      agentStore
        .getSessionAgents(sessionId)
        .filter((agent) => agent.identity.id !== MANAGER_ID && agent.identity.role !== 'manager')
        .map((agent) => ({
          id: agent.identity.id,
          name: agent.identity.name,
          role: agent.identity.role,
          status: agent.status,
          task: agent.task,
        })),

    managerStatus: (sessionId) => runStateStore.getAgentStatusForSession(sessionId),
    isRunning: (sessionId) => runStateStore.isRunning(sessionId),
    cancelSession: (sessionId) => wsStore.cancelSession(sessionId),
    cancelAgent: (sessionId, agentId) => wsStore.cancelAgent(sessionId, agentId),

    steerManager: async (sessionId, text) => {
      const custom = host()?.steerManager;
      if (custom) return custom(sessionId, text);
      return runStateStore.isRunning(sessionId)
        ? wsStore.steerMessage(sessionId, text)
        : wsStore.sendMessage(sessionId, text);
    },
    messageAgent: (sessionId, agentId, text) => wsStore.sendAgentMessage(sessionId, agentId, text),

    listChats: () =>
      sessionStore.sessions
        .filter((session) => !session.id.startsWith('linked-'))
        .map((session) => ({ id: session.id, title: session.title })),
    createChat: () => sessionStore.newChat(),
    renameChat: (sessionId, title) => sessionStore.renameSession(sessionId, title),
    selectChat: (sessionId) => {
      sessionStore.activeSessionId = sessionId;
    },
    archiveChat: (sessionId) => sessionStore.archiveSession(sessionId),
    deleteChat: (sessionId) => sessionStore.deleteSession(sessionId),

    openPanel: (panel: ConductorPanel) => {
      if (typeof window === 'undefined') return false;
      const event = new CustomEvent(OPEN_PANEL_EVENT, { detail: { panel }, cancelable: true });
      return !window.dispatchEvent(event);
    },

    notesEnabled: () => notesStore.settings.enabled,
    currentNote: () => {
      const note = notesStore.currentNote;
      return note
        ? { id: note.id, title: note.title, content: note.content, format: note.format }
        : null;
    },
    updateNoteContent: async (noteId, content) =>
      !!(await notesStore.updateNote(noteId, { content })),
    createNote: async (title, content) => (await notesStore.createNote({ title, content }))?.id ?? null,
    trashNote: (noteId) => notesStore.deleteNote(noteId),

    lastReply: (sessionId) => {
      if (!feedStore.ownsFeed(sessionId)) return null;
      const feed = feedStore.feed;
      for (let i = feed.length - 1; i >= 0; i--) {
        const entry = feed[i];
        if (entry.type === 'content' && entry.agentId !== 'user' && entry.text?.trim())
          return { id: entry.id, text: entry.text };
      }
      return null;
    },
    speak: (id, text) => playVoiceResponse(id, text),
    stopSpeaking: () => stopVoicePlayback(),
    spokenRepliesEnabled: async () => {
      try {
        const response = await apiFetch(apiUrl('/api/voice/settings'));
        const result = await response.json();
        return response.ok && result?.data?.autoReadFinalReplies === true;
      } catch {
        return false;
      }
    },
  };
}
