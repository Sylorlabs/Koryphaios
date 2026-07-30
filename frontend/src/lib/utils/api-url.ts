/**
 * API URL utilities for Tauri desktop environment
 *
 * Koryphaios is a desktop-only application using Tauri.
 * The backend runs locally on the user's machine.
 *
 * Cross-platform: Works on Windows, macOS, and Linux
 */

import { browser } from '$app/environment';
import { getBackendUrl, getWebSocketUrl, defaultConfig } from '@koryphaios/shared';
import { invoke } from '@tauri-apps/api/core';

// Cache for backend URLs
let cachedBackendUrl: string | null = null;
let cachedWebsocketUrl: string | null = null;
let urlsInitialized = false;

/**
 * Normalize URL for browser use
 * Browsers block 0.0.0.0, so convert to 127.0.0.1
 */
function normalizeUrlForBrowser(url: string): string {
  return url.replace(/\/\/0\.0\.0\.0[:/]/, '//127.0.0.1:');
}

/**
 * Get the default backend URL from Vite env or fallback
 */
function getDefaultBackendUrl(): string {
  // If we're in a browser and NOT in Tauri, we should prefer the current origin
  // since the backend is serving us on the same port.
  if (browser && typeof window !== 'undefined') {
    const inTauri = '__TAURI_INTERNALS__' in window;
    if (!inTauri) {
      return window.location.origin;
    }
  }

  // Check Vite-injected env (set by vite.config.ts based on .active-port.json)
  const viteUrl = import.meta.env.VITE_BACKEND_URL;
  if (viteUrl) return normalizeUrlForBrowser(viteUrl);
  return getBackendUrl(defaultConfig);
}

/**
 * Get the default WebSocket URL from Vite env or fallback
 */
function getDefaultWebSocketUrl(): string {
  // If we're in a browser and NOT in Tauri, we should prefer the current host
  if (browser && typeof window !== 'undefined') {
    const inTauri = '__TAURI_INTERNALS__' in window;
    if (!inTauri) {
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      return `${proto}//${window.location.host}/ws`;
    }
  }

  const viteUrl = import.meta.env.VITE_BACKEND_WS_URL;
  if (viteUrl) return normalizeUrlForBrowser(viteUrl);
  return getWebSocketUrl(defaultConfig);
}

/**
 * Get the backend URL synchronously
 * Uses cached value if available, otherwise returns default
 */
function getCachedBackendUrl(): string {
  if (cachedBackendUrl) return cachedBackendUrl;
  return getDefaultBackendUrl();
}

/**
 * Get the WebSocket URL synchronously
 * Uses cached value if available, otherwise returns default
 */
function getCachedWebSocketUrl(): string {
  if (cachedWebsocketUrl) return cachedWebsocketUrl;
  return getDefaultWebSocketUrl();
}

/**
 * Initialize backend URLs by invoking the Tauri backend
 * This should be called early in app startup
 */
export async function initUrls(): Promise<void> {
  if (!browser || urlsInitialized) return;
  await refreshUrls();
}

/**
 * Re-fetch backend URLs from the Tauri layer. Call this when the backend
 * may have restarted on a different port (e.g. after EADDRINUSE fallback).
 * The Tauri get_backend_url command reads .active-port.json to discover
 * the actual port.
 */
export async function refreshUrls(): Promise<void> {
  if (!browser) return;

  try {
    const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
    if (!inTauri) {
      cachedBackendUrl = getDefaultBackendUrl();
      cachedWebsocketUrl = getDefaultWebSocketUrl();
      urlsInitialized = true;
      return;
    }

    const [backend, ws] = await Promise.all([
      invoke('get_backend_url').catch(() => getBackendUrl(defaultConfig)),
      invoke('get_websocket_url').catch(() => getWebSocketUrl(defaultConfig)),
    ]);

    cachedBackendUrl = backend as string;
    cachedWebsocketUrl = ws as string;
    urlsInitialized = true;
  } catch (e) {
    console.warn('[API] Failed to initialize URLs:', e);
    // Fall back to defaults
    cachedBackendUrl = getDefaultBackendUrl();
    cachedWebsocketUrl = getDefaultWebSocketUrl();
    urlsInitialized = true;
  }
}

/**
 * Get the base API URL
 * Always returns the full backend URL for desktop app
 */
export function getApiBaseUrl(): string {
  if (!browser) return '';
  return getCachedBackendUrl();
}

/**
 * Get the DIRECT backend URL, bypassing the Vite dev-server proxy.
 *
 * In dev mode (browser, not Tauri), `getApiBaseUrl()` returns
 * `window.location.origin` (e.g. http://127.0.0.1:5173) so that API
 * calls go through Vite's `/api` proxy. That's fine for normal API
 * calls, but the backend-health sentinel must NOT go through the
 * proxy: Vite's HTTP/1.1 dev server has a 6-connection-per-origin
 * limit, and when the app is busy (error logging, process polling,
 * session loading) the health check can queue behind other requests
 * and exceed its 4s timeout — producing a false "backend down" alarm.
 *
 * This function returns the direct backend URL from the VITE_BACKEND_URL
 * env var (injected by vite.config.ts), falling back to the proxy URL
 * if the env var is unavailable (e.g. Tauri production builds where the
 * proxy URL IS the direct URL).
 */
export function getDirectBackendUrl(): string {
  if (!browser) return '';
  // In Tauri, the cached URL is already direct (no proxy).
  const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  if (inTauri) return getCachedBackendUrl();
  // In browser dev mode, prefer the Vite-injected direct backend URL.
  const viteUrl = import.meta.env.VITE_BACKEND_URL;
  if (viteUrl) return normalizeUrlForBrowser(viteUrl as string);
  // Fallback: use the proxy URL (same as getApiBaseUrl).
  return getCachedBackendUrl();
}

/**
 * Build a full API URL
 *
 * Usage:
 *   apiUrl('/api/sessions') -> 'http://127.0.0.1:3001/api/sessions'
 */
export function apiUrl(path: string): string {
  const base = getApiBaseUrl();
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  return `${base}${cleanPath}`;
}

/**
 * Get WebSocket URL for the backend
 *
 * Usage:
 *   getWsUrl() -> 'ws://127.0.0.1:3001/ws'
 */
export function getWsUrl(): string {
  if (!browser) return '';
  return getCachedWebSocketUrl();
}

/**
 * Get a list of WebSocket URL candidates for fallback connections
 * Ordered by preference
 */
export function getWsCandidates(): string[] {
  const candidates: string[] = [];

  // Primary: Current WS URL
  const primary = getWsUrl();
  if (primary) candidates.push(primary);

  // Fallback: Direct backend connection using default config
  const fallbackUrl = getDefaultWebSocketUrl();
  if (!candidates.includes(fallbackUrl)) {
    candidates.push(fallbackUrl);
  }

  return candidates;
}

/**
 * Check if the app is running in development mode
 */
export function isDev(): boolean {
  if (typeof import.meta.env !== 'undefined') {
    return (import.meta.env as { DEV?: boolean }).DEV === true;
  }
  return false;
}

/**
 * Get platform information
 */
export function getPlatform(): { isDev: boolean } {
  return {
    isDev: isDev(),
  };
}
