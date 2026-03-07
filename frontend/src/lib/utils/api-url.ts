/**
 * API URL utilities for handling both web and Tauri desktop environments
 * 
 * In web mode (browser): Use relative URLs that work with Vite proxy in dev
 * In Tauri mode: Use full backend URLs since there's no proxy
 * 
 * Cross-platform: Works on Windows, macOS, and Linux
 */

import { browser } from '$app/environment';
import { getBackendUrl, getWebSocketUrl, defaultConfig } from '@koryphaios/shared';

// Cache for Tauri config
let tauriBackendUrl: string | null = null;
let tauriWebsocketUrl: string | null = null;
let tauriUrlsInitialized = false;

/**
 * Check if running inside Tauri
 * Tauri injects __TAURI__ object into the window
 */
function isTauri(): boolean {
  if (!browser) return false;
  
  // Check for Tauri-specific properties
  const win = window as any;
  
  // Primary check: __TAURI__ object exists
  if (typeof win.__TAURI__ !== 'undefined') return true;
  
  // Protocol check: tauri:// or similar custom protocol
  if (win.location?.protocol?.startsWith('tauri')) return true;
  
  // User agent check (fallback)
  const userAgent = navigator.userAgent.toLowerCase();
  if (userAgent.includes('tauri')) return true;
  
  return false;
}

/**
 * Get the backend URL synchronously
 * Uses cached value if available, otherwise returns default
 */
function getCachedBackendUrl(): string {
  if (tauriBackendUrl) return tauriBackendUrl;
  return getBackendUrl(defaultConfig);
}

/**
 * Get the WebSocket URL synchronously
 * Uses cached value if available, otherwise returns default
 */
function getCachedWebSocketUrl(): string {
  if (tauriWebsocketUrl) return tauriWebsocketUrl;
  return getWebSocketUrl(defaultConfig);
}

/**
 * Initialize Tauri URLs by invoking the backend
 * This should be called early in app startup
 */
export async function initTauriUrls(): Promise<void> {
  if (!browser || !isTauri() || tauriUrlsInitialized) return;
  
  try {
    // Access Tauri API from window.__TAURI__
    const win = window as any;
    if (!win.__TAURI__?.core?.invoke) {
      console.warn('[API] Tauri API not available on window');
      tauriBackendUrl = getBackendUrl(defaultConfig);
      tauriWebsocketUrl = getWebSocketUrl(defaultConfig);
      tauriUrlsInitialized = true;
      return;
    }
    
    const invoke = win.__TAURI__.core.invoke;
    
    const [backend, ws] = await Promise.all([
      invoke('get_backend_url').catch(() => getBackendUrl(defaultConfig)),
      invoke('get_websocket_url').catch(() => getWebSocketUrl(defaultConfig)),
    ]);
    
    tauriBackendUrl = backend;
    tauriWebsocketUrl = ws;
    tauriUrlsInitialized = true;
  } catch (e) {
    console.warn('[API] Failed to initialize Tauri URLs:', e);
    // Fall back to defaults
    tauriBackendUrl = getBackendUrl(defaultConfig);
    tauriWebsocketUrl = getWebSocketUrl(defaultConfig);
    tauriUrlsInitialized = true;
  }
}

/**
 * Get the base API URL
 * In Tauri: returns the full backend URL
 * In browser: returns empty string (relative URLs)
 */
export function getApiBaseUrl(): string {
  if (!browser) return '';
  
  // If running in Tauri, use the full backend URL
  if (isTauri()) {
    return getCachedBackendUrl();
  }
  
  // In browser, use relative URLs (Vite proxy handles it in dev)
  return '';
}

/**
 * Build a full API URL (synchronous version)
 * 
 * Usage:
 *   apiUrl('/api/sessions') -> '/api/sessions' (browser)
 *   apiUrl('/api/sessions') -> 'http://127.0.0.1:3000/api/sessions' (Tauri)
 */
export function apiUrl(path: string): string {
  const base = getApiBaseUrl();
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  return `${base}${cleanPath}`;
}

/**
 * Get WebSocket URL for the backend (synchronous version)
 * 
 * Usage:
 *   getWsUrl() -> 'ws://localhost:5173/ws' (browser dev)
 *   getWsUrl() -> 'ws://127.0.0.1:3000/ws' (Tauri)
 */
export function getWsUrl(): string {
  if (!browser) return '';
  
  // If running in Tauri, connect directly to backend
  if (isTauri()) {
    return getCachedWebSocketUrl();
  }
  
  // In browser, use same origin (Vite proxy handles WebSocket upgrade)
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${window.location.host}/ws`;
}

/**
 * Get a list of WebSocket URL candidates for fallback connections
 * Ordered by preference
 */
export function getWsCandidates(): string[] {
  const candidates: string[] = [];
  
  // Primary: Current environment's WS URL
  const primary = getWsUrl();
  if (primary) candidates.push(primary);
  
  // Fallback: Direct backend connection using default config
  const fallbackUrl = getWebSocketUrl(defaultConfig);
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
export function getPlatform(): { isTauri: boolean; isBrowser: boolean; isDev: boolean } {
  return {
    isTauri: isTauri(),
    isBrowser: browser && !isTauri(),
    isDev: isDev(),
  };
}
