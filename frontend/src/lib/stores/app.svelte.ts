// App initialization orchestrator — Svelte 5 runes
// Single source of truth for startup sequence: auth → sessions → websocket
// Prevents race conditions where components call APIs before auth is ready

import { browser } from '$app/environment';
import { authStore } from './auth.svelte';
import { apiUrl } from '$lib/utils/api-url';
import { getAuthHeaders } from '$lib/api.svelte';

interface AppState {
  authReady: boolean;
  authError: string | null;
  sessionsLoaded: boolean;
  backendUnreachable: boolean;
  projectName: string;
}

interface AuthStoreInitializer {
  initialize(): Promise<boolean>;
}

interface SessionStoreInitializer {
  fetchSessions(): Promise<boolean>;
}

let state = $state<AppState>({
  authReady: false,
  authError: null,
  sessionsLoaded: false,
  backendUnreachable: false,
  projectName: '',
});

export const appStore = {
  get authReady() {
    return state.authReady;
  },
  get authError() {
    return state.authError;
  },
  get sessionsLoaded() {
    return state.sessionsLoaded;
  },
  get backendUnreachable() {
    return state.backendUnreachable;
  },
  get projectName() {
    return state.projectName;
  },
  set projectName(name: string) {
    state.projectName = name;
  },
  get isReady() {
    return state.authReady && state.sessionsLoaded;
  },

  async initialize(authStoreInit: AuthStoreInitializer, sessionStore: SessionStoreInitializer) {
    if (!browser) return;
    state.backendUnreachable = false;

    try {
      const authOk = await authStoreInit.initialize();
      state.authReady = authOk;
      state.authError = authOk ? null : 'Authentication unavailable';
      if (!authOk) {
        state.backendUnreachable = true;
        state.sessionsLoaded = false;
        return;
      }
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
      console.error('Failed to load sessions:', err); // eslint-disable-line no-console
      state.sessionsLoaded = false;
      state.backendUnreachable = true;
    }

    try {
      if (state.authReady) {
        const res = await fetch(apiUrl('/api/project'), {
          headers: getAuthHeaders(),
        });
        if (res.ok) {
          const json = await res.json();
          const serverProjectName = json?.data?.projectName ?? '';
          if (serverProjectName) {
            state.projectName = serverProjectName;
          }
        }
      }
    } catch (err: unknown) {
      console.warn(
        'Failed to fetch project name:',
        err instanceof Error ? err.message : String(err),
      );
      // The backend remains authoritative; do not restore stale browser state.
    }
  },

  reset() {
    state = {
      authReady: false,
      authError: null,
      sessionsLoaded: false,
      backendUnreachable: false,
      projectName: '',
    };
  },
};
