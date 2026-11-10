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
// Monotonic timestamp of the most recent successful validation, for the
// coalescing window below.
let lastValidatedAt = 0;

const LOCAL_AUTH_TOKEN_KEY = 'koryphaios-local-auth-token';

// How long a successfully validated session is trusted before the next caller
// revalidates it. Chosen to comfortably outlive a typical UI burst (a session
// switch issues ~15 requests in well under two seconds) while staying short
// enough that a restarted backend is noticed almost immediately.
const AUTH_REVALIDATE_WINDOW_MS = 5_000;
// Set when a real request failed auth. Forces the next ensureSession() to
// revalidate (and mint a replacement) instead of trusting the cached window.
let authInvalidated = false;

/** Structural comparison — an identical user must not produce a new object. */
function sameAuthUser(a: AuthUser, b: AuthUser): boolean {
  return a.id === b.id && a.username === b.username && a.isAdmin === b.isAdmin;
}

/** A 401 proves the backend forgot this session; force the next validation. */
export function invalidateLocalSession() {
  authInvalidated = true;
  lastValidatedAt = 0;
}

function loadStoredToken(): string | undefined {
  if (!browser) return undefined;
  try {
    return localStorage.getItem(LOCAL_AUTH_TOKEN_KEY) || undefined;
  } catch (err: unknown) {
    console.debug('Failed to read auth token from localStorage:', err instanceof Error ? err.message : String(err));
    return undefined;
  }
}

function persistToken(nextToken: string | undefined) {
  if (!browser) return;
  try {
    if (nextToken) localStorage.setItem(LOCAL_AUTH_TOKEN_KEY, nextToken);
    else localStorage.removeItem(LOCAL_AUTH_TOKEN_KEY);
  } catch (err: unknown) {
    console.debug('Failed to persist auth token to localStorage:', err instanceof Error ? err.message : String(err));
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
  } catch (err: unknown) {
    console.debug('Failed to parse auth/me response as JSON:', err instanceof Error ? err.message : String(err));
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
  } catch (err: unknown) {
    console.debug('Failed to parse auth/session response as JSON:', err instanceof Error ? err.message : String(err));
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

    // Reuse a recently validated session instead of preflighting a fresh
    // /api/auth/me on every single API call.
    //
    // This store reassigns `user` on every successful validation, and `user` is
    // a `$state` object — so each reassignment invalidates *every* effect and
    // derived that reads it. Preflighting each request therefore turned a batch
    // of UI work into a second, self-sustaining wave of effects. Instead validate
    // once per window and let a genuine 401 (the signal that a restart really
    // happened) force the next validation through early.
    const now = Date.now();
    if (user && now - lastValidatedAt < AUTH_REVALIDATE_WINDOW_MS && !authInvalidated) {
      return true;
    }
    if (!user && authInvalidated) authInvalidated = false;

    initialization = (async () => {
      token = token ?? loadStoredToken();
      try {
        let resolvedUser: AuthUser | null = token ? await validateToken(token) : null;

        if (!resolvedUser) {
          token = await createLocalSession();
          persistToken(token);
          resolvedUser = token ? await validateToken(token) : null;
        }

        // Only publish a new object when it actually differs. A stable identity
        // keeps effects that read `user` from re-running on every request.
        if (resolvedUser && user && sameAuthUser(user, resolvedUser)) {
          lastValidatedAt = Date.now();
          authInvalidated = false;
          isInitialized = true;
          return true;
        }

        user = resolvedUser;
        lastValidatedAt = Date.now();
        authInvalidated = false;
        isInitialized = true;
        return !!resolvedUser;
      } catch (err: unknown) {
        console.warn('Auth session validation failed:', err instanceof Error ? err.message : String(err));
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
      } catch (err: unknown) {
        console.warn('Logout request failed:', err instanceof Error ? err.message : String(err));
        // Ignore logout failures and clear local state.
      }
    }
    user = null;
    token = undefined;
    persistToken(undefined);
    isInitialized = false;
  },
};
