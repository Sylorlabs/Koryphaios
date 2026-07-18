// Authentication store — local bearer bootstrap for the desktop backend.

import { browser } from '$app/environment';
import { apiUrl } from '$lib/utils/api-url';

export interface AuthUser {
  id: string;
  username: string;
  isAdmin: boolean;
  createdAt?: number;
}

let user = $state<AuthUser | null>(null);
let isInitialized = $state(false);
let token = $state<string | undefined>(undefined);
let initialization: Promise<boolean> | null = null;

const LOCAL_AUTH_TOKEN_KEY = 'koryphaios-local-auth-token';

function loadStoredToken(): string | undefined {
  if (!browser) return undefined;
  try {
    return localStorage.getItem(LOCAL_AUTH_TOKEN_KEY) || undefined;
  } catch {
    return undefined;
  }
}

function persistToken(nextToken: string | undefined) {
  if (!browser) return;
  try {
    if (nextToken) localStorage.setItem(LOCAL_AUTH_TOKEN_KEY, nextToken);
    else localStorage.removeItem(LOCAL_AUTH_TOKEN_KEY);
  } catch {
    // Ignore localStorage failures.
  }
}

async function validateToken(candidate: string): Promise<AuthUser | null> {
  const res = await fetch(apiUrl('/api/auth/me'), {
    credentials: 'include',
    headers: { Authorization: candidate },
  });
  if (!res.ok) return null;
  const text = await res.text();
  if (!text.trim()) return null;
  try {
    const data = JSON.parse(text);
    return data?.ok && data?.data?.user ? (data.data.user as AuthUser) : null;
  } catch {
    return null;
  }
}

async function createLocalSession(): Promise<string | undefined> {
  const res = await fetch(apiUrl('/api/auth/session'), {
    method: 'POST',
    credentials: 'include',
  });
  if (!res.ok) return undefined;
  const text = await res.text();
  if (!text.trim()) return undefined;
  try {
    const data = JSON.parse(text);
    return data?.ok ? data?.data?.bearerToken : undefined;
  } catch {
    return undefined;
  }
}

export const authStore = {
  get user() {
    return user;
  },
  get isInitialized() {
    return isInitialized;
  },
  get isAuthenticated() {
    return !!user;
  },
  /** Present when using API-key auth; undefined for local/cookie auth. */
  get token() {
    return token;
  },

  /**
   * Establishes and validates the local bearer session. This intentionally
   * validates even when a token is already in memory: the local backend is
   * restarted during development and its in-memory session registry is reset,
   * while the desktop webview keeps its token in localStorage. Revalidating
   * through /api/auth/me (which returns 200 for an invalid bearer) lets us
   * mint a replacement before any protected route can emit a noisy 401.
   */
  async ensureSession(): Promise<boolean> {
    if (!browser) {
      isInitialized = true;
      return true;
    }

    // Coalesce mount-time and API callers so they create at most one session.
    if (initialization) return initialization;

    initialization = (async () => {
      token = token ?? loadStoredToken();
      try {
        let resolvedUser: AuthUser | null = token ? await validateToken(token) : null;

        if (!resolvedUser) {
          token = await createLocalSession();
          persistToken(token);
          resolvedUser = token ? await validateToken(token) : null;
        }

        user = resolvedUser;
        isInitialized = true;
        return !!resolvedUser;
      } catch {
        user = null;
        token = undefined;
        persistToken(undefined);
        isInitialized = true;
        return false;
      }
    })();

    try {
      return await initialization;
    } finally {
      initialization = null;
    }
  },

  /** Backward-compatible startup entrypoint. */
  async initialize(): Promise<boolean> {
    return this.ensureSession();
  },

  setUser(u: AuthUser | null) {
    user = u;
  },

  async logout() {
    if (token) {
      try {
        await fetch(apiUrl('/api/auth/session'), {
          method: 'DELETE',
          credentials: 'include',
          headers: { Authorization: token },
        });
      } catch {
        // Ignore logout failures and clear local state.
      }
    }
    user = null;
    token = undefined;
    persistToken(undefined);
    isInitialized = false;
  },
};
