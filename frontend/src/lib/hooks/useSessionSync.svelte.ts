import { wsStore } from '$lib/stores/websocket.svelte';
import { sessionStore } from '$lib/stores/sessions.svelte';

export interface SessionSyncOptions {
  onActiveSessionChange?: () => void;
}

export function useSessionSync(options: SessionSyncOptions = {}) {
  let lastSubscribedSessionId = $state('');
  let lastLoadedAgentThreadsSessionId = $state('');

  // Monotonic counter incremented every time the user switches to a
  // different session. Used to discard stale fetches that resolve after
  // a newer switch has already populated the feed.
  let loadGeneration = 0;

  $effect(() => {
    const activeId = sessionStore.activeSessionId;
    if (!activeId) {
      if (lastSubscribedSessionId !== '') {
        wsStore.clearFeed();
        lastSubscribedSessionId = '';
      }
      return;
    }

    if (activeId === lastSubscribedSessionId) {
      // Same session — just re-subscribe if the WS is up.
      if (wsStore.status === 'connected') {
        wsStore.subscribeToSession(activeId);
      }
      return;
    }

    // New session.
    lastSubscribedSessionId = activeId;
    const myGen = ++loadGeneration;

    if (wsStore.status === 'connected') {
      wsStore.subscribeToSession(activeId);
    }

    (async () => {
      try {
        const messages = await sessionStore.fetchMessages(activeId);
        // A newer switch has happened — drop this stale result.
        if (myGen !== loadGeneration) return;
        wsStore.loadSessionMessages(activeId, messages);
      } catch (err) {
        console.warn('useSessionSync: failed to load messages', err);
      }
    })();
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
