import { wsStore } from '$lib/stores/websocket.svelte';
import { sessionStore } from '$lib/stores/sessions.svelte';
import { toastStore } from '$lib/stores/toast.svelte';

export interface SessionSyncOptions {
  onActiveSessionChange?: () => void;
  /** Static website demo data never has a backend to synchronize with. */
  disabled?: boolean;
}

export function useSessionSync(options: SessionSyncOptions = {}) {
  let lastSubscribedSessionId = $state('');
  let lastLoadedAgentThreadsSessionId = $state('');

  // Monotonic counter incremented every time the user switches to a
  // different session. Used to discard stale fetches that resolve after
  // a newer switch has already populated the feed.
  let loadGeneration = 0;
  let activeLoadController: AbortController | null = null;

  $effect(() => {
    if (options.disabled) return;
    const activeId = sessionStore.activeSessionId;
    if (!activeId) {
      loadGeneration++;
      activeLoadController?.abort();
      activeLoadController = null;
      // Svelte effects must not synchronously mutate the reactive stores they
      // observe. Move the atomic feed handoff to the next microtask.
      queueMicrotask(() => {
        if (!sessionStore.activeSessionId) wsStore.activateSessionFeed('');
      });
      if (lastSubscribedSessionId !== '') {
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
    activeLoadController?.abort();
    const controller = new AbortController();
    activeLoadController = controller;

    if (wsStore.status === 'connected') {
      wsStore.subscribeToSession(activeId);
    }

    queueMicrotask(async () => {
      if (
        controller.signal.aborted ||
        myGen !== loadGeneration ||
        sessionStore.activeSessionId !== activeId
      ) return;

      // Atomically restore this session's isolated snapshot before its fresh
      // history request begins, without mutating state during effect evaluation.
      const feedGeneration = wsStore.activateSessionFeed(activeId);
      try {
        const messages = await sessionStore.fetchMessages(activeId, controller.signal);
        // A newer switch has happened — drop this stale result.
        if (controller.signal.aborted || myGen !== loadGeneration) return;
        await wsStore.loadSessionMessages(activeId, messages, {
          generation: feedGeneration,
          signal: controller.signal,
        });
      } catch (err) {
        if (controller.signal.aborted || myGen !== loadGeneration) return;
        console.warn('useSessionSync: failed to load messages', err);
        const message = err instanceof Error ? err.message : 'Failed to load chat history.';
        wsStore.finishSessionLoad(activeId, feedGeneration);
        toastStore.error(message);
        wsStore.addClientError(`Chat history failed to load: ${message}`);
      }
    });
  });

  $effect(() => {
    if (options.disabled) return;
    const activeId = sessionStore.activeSessionId;
    if (activeId && activeId !== lastLoadedAgentThreadsSessionId) {
      lastLoadedAgentThreadsSessionId = activeId;
      options.onActiveSessionChange?.();
      void wsStore.loadAgentThreads(activeId);
    }
  });
}
