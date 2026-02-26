// App initialization orchestrator — Svelte 5 runes
// Single source of truth for startup sequence: auth → sessions → websocket
// Prevents race conditions where components call APIs before auth is ready

import { browser } from '$app/environment';
import { authStore } from './auth.svelte';

interface AppState {
  authReady: boolean;
  authError: string | null;
  sessionsLoaded: boolean;
  backendUnreachable: boolean;
  projectName: string;
}

let state = $state<AppState>({
  authReady: false,
  authError: null,
  sessionsLoaded: false,
  backendUnreachable: false,
  projectName: '',
});

export const appStore = {
  get authReady() { return state.authReady; },
  get authError() { return state.authError; },
  get sessionsLoaded() { return state.sessionsLoaded; },
  get backendUnreachable() { return state.backendUnreachable; },
  get projectName() { return state.projectName; },
  get isReady() { return state.authReady && state.sessionsLoaded; },

  async initialize(authStoreInit: any, sessionStore: any) {
    if (!browser) return;
    state.backendUnreachable = false;

    try {
      const authOk = await authStoreInit.initialize();
      state.authReady = true;
      state.authError = null;
      if (!authOk) state.backendUnreachable = true;
    } catch (err) {
      state.authError = String(err);
      state.authReady = false;
      state.backendUnreachable = true;
      return;
    }

    try {
      if (state.authReady) {
        const ok = await sessionStore.fetchSessions();
        state.sessionsLoaded = ok;
        if (!ok) state.backendUnreachable = true;
      }
    } catch (err) {
      console.error('Failed to load sessions:', err);
      state.sessionsLoaded = false;
      state.backendUnreachable = true;
    }

    try {
      if (state.authReady) {
        const res = await fetch('/api/project', {
          headers: authStore.token ? { Authorization: `Bearer ${authStore.token}` } : {},
        });
        if (res.ok) {
          const json = await res.json();
          state.projectName = json?.data?.projectName ?? '';
        }
      }
    } catch {
      state.projectName = '';
    }
  },

  reset() {
    state = { authReady: false, authError: null, sessionsLoaded: false, backendUnreachable: false, projectName: '' };
  },
};
