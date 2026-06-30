import { wsStore } from '$lib/stores/websocket.svelte';
import { sessionStore } from '$lib/stores/sessions.svelte';

export interface SessionSyncOptions {
  onActiveSessionChange?: () => void;
}

export function useSessionSync(options: SessionSyncOptions = {}) {
  let lastSubscribedSessionId = $state('');
  let lastLoadedAgentThreadsSessionId = $state('');

  $effect(() => {
    const activeId = sessionStore.activeSessionId;
    if (!activeId) {
      if (lastSubscribedSessionId !== '') {
        wsStore.clearFeed();
        lastSubscribedSessionId = '';
      }
      return;
    }

    if (activeId !== lastSubscribedSessionId) {
      lastSubscribedSessionId = activeId;

      if (wsStore.status === 'connected') {
        wsStore.subscribeToSession(activeId);
      }

      void (async () => {
        const messages = await sessionStore.fetchMessages(activeId);
        wsStore.loadSessionMessages(activeId, messages);
      })();
    } else if (wsStore.status === 'connected' && activeId === lastSubscribedSessionId) {
      wsStore.subscribeToSession(activeId);
    }
  });

  $effect(() => {
    const activeId = sessionStore.activeSessionId;
    if (activeId && activeId !== lastLoadedAgentThreadsSessionId) {
      lastLoadedAgentThreadsSessionId = activeId;
      options.onActiveSessionChange?.();
      void wsStore.loadAgentThreads(activeId);
    }
  });
}