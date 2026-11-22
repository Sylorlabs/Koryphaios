import { wsStore } from '$lib/stores/websocket.svelte';
import { feedStore } from '$lib/stores/feed.svelte';
import { sessionStore } from '$lib/stores/sessions.svelte';
import { toastStore } from '$lib/stores/toast.svelte';
import { getTranscriptScrollState, resumeMessageLimit } from '$lib/utils/transcript-scroll';

export interface SessionSyncOptions {
  onActiveSessionChange?: () => void;
  /** Static website demo data never has a backend to synchronize with. */
  disabled?: boolean;
}

export function useSessionSync(options: SessionSyncOptions = {}) {
  let lastSubscribedSessionId = $state('');
  let lastLoadedAgentThreadsSessionId = $state('');
  // A session switch is activated in a microtask so the effect does not
  // synchronously mutate a store it observes. Until that handoff completes,
  // do not let a reactive re-run subscribe and replay into the previous feed.
  let activatingSessionId = '';

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
      activatingSessionId = '';
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
      if (wsStore.status === 'connected' && activatingSessionId !== activeId) {
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
    activatingSessionId = activeId;

    queueMicrotask(async () => {
      if (
        controller.signal.aborted ||
        myGen !== loadGeneration ||
        sessionStore.activeSessionId !== activeId
      ) {
        if (activatingSessionId === activeId) activatingSessionId = '';
        return;
      }

      // Atomically restore this session's isolated snapshot before its fresh
      // history request or ordered-event replay begins, without mutating state
      // during effect evaluation.
      const feedGeneration = wsStore.activateSessionFeed(activeId);
      if (activatingSessionId === activeId) activatingSessionId = '';
      // HTTP history contains chat messages, not the full operational
      // transcript. Replay the durable event log as well so tools, reasoning,
      // and worker activity survive a refresh or app relaunch.
      wsStore.subscribeToSession(activeId);
      try {
        // A parked reader needs the rows from their anchor through the newest
        // message, not just the newest page. Sizing the first read to that span
        // lets VirtualList restore the exact row; a following reader keeps the
        // small default page.
        const resumeLimit = resumeMessageLimit(getTranscriptScrollState(activeId));
        // Feed persistence (deletions, visibility, client errors) is awaited
        // inside the history merge. Starting it here overlaps it with the
        // messages fetch instead of adding a second round trip to the
        // critical path.
        void feedStore.loadFeedPersistence(activeId, controller.signal);
        const messages = await sessionStore.fetchMessages(
          activeId,
          controller.signal,
          resumeLimit === undefined ? undefined : { limit: resumeLimit },
        );
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
        wsStore.addClientError(activeId, `Chat history failed to load: ${message}`);
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
