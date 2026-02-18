// App initialization orchestrator — Svelte 5 runes
// Single source of truth for startup sequence: auth → sessions → websocket
// Prevents race conditions where components call APIs before auth is ready

import { browser } from '$app/environment';

interface AppState {
  authReady: boolean;
  authError: string | null;
  sessionsLoaded: boolean;
}

let state = $state<AppState>({
  authReady: false,
  authError: null,
  sessionsLoaded: false,
});

export const appStore = {
  get authReady() { return state.authReady; },
  get authError() { return state.authError; },
  get sessionsLoaded() { return state.sessionsLoaded; },
  get isReady() { return state.authReady && state.sessionsLoaded; },

  async initialize(authStore: any, sessionStore: any) {
    if (!browser) return;

    try {
      // Step 1: Initialize auth (get or create token)
      await authStore.initialize();
      state.authReady = true;
      state.authError = null;
    } catch (err) {
      state.authError = String(err);
      state.authReady = false;
      return;
    }

    try {
      // Step 2: Load sessions (now that auth is ready)
      if (state.authReady) {
        await sessionStore.fetchSessions();
        state.sessionsLoaded = true;
      }
    } catch (err) {
      console.error('Failed to load sessions:', err);
      state.sessionsLoaded = false;
    }
  },

  reset() {
    state = { authReady: false, authError: null, sessionsLoaded: false };
  },
};
