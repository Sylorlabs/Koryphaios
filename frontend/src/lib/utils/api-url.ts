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

// Cache for backend URLs
let cachedBackendUrl: string | null = null;
let cachedWebsocketUrl: string | null = null;
let urlsInitialized = false;

/**
 * Get the backend URL synchronously
 * Uses cached value if available, otherwise returns default
 */
function getCachedBackendUrl(): string {
  if (cachedBackendUrl) return cachedBackendUrl;
  return getBackendUrl(defaultConfig);
}

/**
 * Get the WebSocket URL synchronously
 * Uses cached value if available, otherwise returns default
 */
function getCachedWebSocketUrl(): string {
  if (cachedWebsocketUrl) return cachedWebsocketUrl;
  return getWebSocketUrl(defaultConfig);
}

/**
 * Initialize backend URLs by invoking the Tauri backend
 * This should be called early in app startup
 */
export async function initUrls(): Promise<void> {
  if (!browser || urlsInitialized) return;
  
  try {
    // Try to import Tauri API directly (preferred method in Tauri v2)
    const tauriModule = await import('@tauri-apps/api').catch(() => null);
    if (tauriModule?.invoke) {
      console.log('[API] Using @tauri-apps/api invoke');
      const [backend, ws] = await Promise.all([
        tauriModule.invoke('get_backend_url').catch(() => getBackendUrl(defaultConfig)),
        tauriModule.invoke('get_websocket_url').catch(() => getWebSocketUrl(defaultConfig)),
      ]);
      
      cachedBackendUrl = backend;
      cachedWebsocketUrl = ws;
      urlsInitialized = true;
      console.log('[API] URLs initialized via Tauri:', { backend, ws });
      return;
    }
    
    // Fallback: Access Tauri API from window.__TAURI__
    const win = window as any;
    const invoke = win.__TAURI__?.core?.invoke || win.__TAURI__?.invoke;
    
    if (!invoke) {
      console.warn('[API] Tauri API not available, using default config (port 29473)');
      cachedBackendUrl = getBackendUrl(defaultConfig);
      cachedWebsocketUrl = getWebSocketUrl(defaultConfig);
      urlsInitialized = true;
      return;
    }
    
    console.log('[API] Using window.__TAURI__ invoke');
    const [backend, ws] = await Promise.all([
      invoke('get_backend_url').catch(() => getBackendUrl(defaultConfig)),
      invoke('get_websocket_url').catch(() => getWebSocketUrl(defaultConfig)),
    ]);
    
    cachedBackendUrl = backend;
    cachedWebsocketUrl = ws;
    urlsInitialized = true;
    console.log('[API] URLs initialized via Tauri (window):', { backend, ws });
  } catch (e) {
    console.warn('[API] Failed to initialize URLs:', e);
    // Fall back to defaults
    cachedBackendUrl = getBackendUrl(defaultConfig);
    cachedWebsocketUrl = getWebSocketUrl(defaultConfig);
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
 * Build a full API URL
 * 
 * Usage:
 *   apiUrl('/api/sessions') -> 'http://127.0.0.1:29473/api/sessions'
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
 *   getWsUrl() -> 'ws://127.0.0.1:29473/ws'
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
export function getPlatform(): { isDev: boolean } {
  return {
    isDev: isDev(),
  };
}
