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

  async initialize() {
    if (!browser) {
      isInitialized = true;
      return;
    }
    if (isInitialized) return;

    try {
      const res = await fetch('/api/auth/me', { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        if (data?.ok && data?.data?.user) {
          user = data.data.user;
        } else {
          user = null;
        }
      } else {
        user = null;
      }
    } catch {
      user = null;
    }
    isInitialized = true;
  },

  setUser(u: AuthUser | null) {
    user = u;
  },

  logout() {
    user = null;
    isInitialized = false;
  },
};
