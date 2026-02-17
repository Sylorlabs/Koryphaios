// Authentication store — handles session token
import { browser } from '$app/environment';

const STORAGE_KEY = 'koryphaios-session-token';
const VERSION_KEY = 'koryphaios-token-version';
const CURRENT_VERSION = 2; // Increment to auto-clear old tokens

// Validate token format and expiry without making API calls
function isTokenValid(tokenStr: string): boolean {
  try {
    const parts = tokenStr.split('.');
    if (parts.length !== 2) return false;

    // Decode payload
    const payload = JSON.parse(atob(parts[0].replace(/-/g, '+').replace(/_/g, '/')));
    
    // Check expiry
    if (!payload.expiresAt) return false;
    if (payload.expiresAt < Date.now()) return false;

    return true;
  } catch {
    return false;
  }
}

let token = $state<string>('');
let isInitialized = $state(false);

export const authStore = {
  get token() { return token; },
  get isInitialized() { return isInitialized; },
  get isAuthenticated() { return !!token; },

  async initialize() {
    if (!browser) return;
    if (isInitialized) return;

    // Check if token version has changed (triggers cache clear)
    const storedVersion = localStorage.getItem(VERSION_KEY);
    if (storedVersion !== String(CURRENT_VERSION)) {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.setItem(VERSION_KEY, String(CURRENT_VERSION));
    }

    // Try to load existing token from storage if it's valid
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && isTokenValid(stored)) {
      token = stored;
      isInitialized = true;
      return;
    }

    // Stored token is invalid or doesn't exist, request a new one from the server
    try {
      const res = await fetch('/api/auth/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      
      if (!res.ok) {
        throw new Error(`Auth failed with status ${res.status}`);
      }

      const data = await res.json() as { ok: boolean; data: { token: string; sessionId: string } };
      if (data.ok && data.data?.token) {
        token = data.data.token;
        localStorage.setItem(STORAGE_KEY, token);
      } else {
        throw new Error('Invalid auth response');
      }
    } catch (err) {
      console.error('Failed to initialize authentication:', err);
    } finally {
      isInitialized = true;
    }
  },

  logout() {
    if (browser) {
      localStorage.removeItem(STORAGE_KEY);
    }
    token = '';
    isInitialized = false;
  },
};
