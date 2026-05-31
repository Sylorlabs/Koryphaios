// App initialization orchestrator — Svelte 5 runes
// Single source of truth for startup sequence: auth → sessions → websocket
// Prevents race conditions where components call APIs before auth is ready

import { browser } from '$app/environment';
import { authStore } from './auth.svelte';
import { apiUrl } from '$lib/utils/api-url';
import { getAuthHeaders } from '$lib/api.svelte';

const LAST_PROJECT_KEY = 'koryphaios-last-project';

interface AppState {
  authReady: boolean;
  authError: string | null;
  sessionsLoaded: boolean;
  backendUnreachable: boolean;
  projectName: string;
}

// Load last project from localStorage
function loadLastProject(): string {
  if (!browser) return '';
  try {
    return localStorage.getItem(LAST_PROJECT_KEY) || '';
  } catch {
    return '';
  }
}

// Save project to localStorage
function saveLastProject(name: string): void {
  if (!browser) return;
  try {
    if (name) {
      localStorage.setItem(LAST_PROJECT_KEY, name);
    } else {
      localStorage.removeItem(LAST_PROJECT_KEY);
    }
  } catch {
    // Ignore localStorage errors
  }
}

let state = $state<AppState>({
  authReady: false,
  authError: null,
  sessionsLoaded: false,
  backendUnreachable: false,
  projectName: loadLastProject(),
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
    saveLastProject(name);
  },
  get isReady() {
    return state.authReady && state.sessionsLoaded;
  },

  async initialize(authStoreInit: any, sessionStore: any) {
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
          // Only override localStorage value if server has a project
          // Otherwise, keep the last project from localStorage for continuity
          if (serverProjectName) {
            state.projectName = serverProjectName;
            saveLastProject(serverProjectName);
          }
        }
      }
    } catch {
      // Keep the localStorage value on error
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
