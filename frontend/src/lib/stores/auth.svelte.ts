// Authentication store — cookie-based session (no tokens in JS/localStorage).
// Session and refresh are HttpOnly cookies; backend sets them on login/refresh.
// After a successful POST /api/auth/login, call setUser(data.data.user) so the UI shows the logged-in user.

import { browser } from '$app/environment';

export interface AuthUser {
  id: string;
  username: string;
  isAdmin: boolean;
  createdAt?: number;
}

let user = $state<AuthUser | null>(null);
let isInitialized = $state(false);

export const authStore = {
  get user() { return user; },
  get isInitialized() { return isInitialized; },
  get isAuthenticated() { return !!user; },

  /** Returns true if backend responded (even with no user), false if backend unreachable (5xx or network error). */
  async initialize(): Promise<boolean> {
    if (!browser) {
      isInitialized = true;
      return true;
    }
    if (isInitialized) return true;

    try {
      const res = await fetch('/api/auth/me', { credentials: 'include' });
      if (res.ok) {
        const text = await res.text();
        if (text.trim()) {
          try {
            const data = JSON.parse(text);
            if (data?.ok && data?.data?.user) user = data.data.user;
            else user = null;
          } catch {
            user = null;
          }
        } else {
          user = null;
        }
        isInitialized = true;
        return true;
      }
      user = null;
      isInitialized = true;
      return false; // 5xx or 4xx → backend unreachable or auth issue
    } catch {
      user = null;
      isInitialized = true;
      return false;
    }
  },

  setUser(u: AuthUser | null) {
    user = u;
  },

  logout() {
    user = null;
    isInitialized = false;
  },
};
