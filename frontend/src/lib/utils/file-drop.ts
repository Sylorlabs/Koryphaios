/**
 * Native file drop handling for Tauri desktop app
 * 
 * This module handles file drops from the native OS file manager
 * into the application window.
 */

import { browser } from '$app/environment';

export interface FileDropPayload {
  paths: string[];
  position?: { x: number; y: number };
}

export type FileDropHandler = (payload: FileDropPayload) => void;

// Store the unlisten function
let unlistenFn: (() => void) | null = null;

/**
 * Check if we're in Tauri environment
 */
function isTauri(): boolean {
  if (!browser) return false;
  const win = window as any;
  return !!win.__TAURI__?.event?.listen;
}

/**
 * Initialize file drop handling
 * @param handler Callback function when files are dropped
 * @returns Cleanup function to stop listening
 */
export async function initFileDrop(handler: FileDropHandler): Promise<() => void> {
  if (!browser) return () => {};
  
  // Check if we're in Tauri
  if (!isTauri()) {
    return () => {};
  }
  
  try {
    const win = window as any;
    const { listen } = win.__TAURI__.event;
    
    // Listen for file-drop events from Tauri
    const unlisten = await listen('file-drop', (event: any) => {
      if (event.payload) {
        handler(event.payload as FileDropPayload);
      }
    });
    
    unlistenFn = unlisten;
    
    return () => {
      if (unlistenFn) {
        unlistenFn();
        unlistenFn = null;
      }
    };
  } catch (error) {
    console.error('[FileDrop] Failed to initialize:', error);
    return () => {};
  }
}

/**
 * Check if native file drop is available
 */
export function isNativeFileDropAvailable(): boolean {
  return isTauri();
}

/**
 * Format file paths for display
 */
export function formatDroppedFiles(paths: string[]): string {
  if (paths.length === 0) return '';
  if (paths.length === 1) {
    const path = paths[0];
    const parts = path.split(/[/\\]/);
    return parts[parts.length - 1] || path;
  }
  return `${paths.length} files`;
}

/**
 * Get file extension from path
 */
export function getFileExtension(path: string): string {
  const parts = path.split('.');
  return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : '';
}

/**
 * Check if file is a text file that can be read
 */
export function isTextFile(path: string): boolean {
  const textExtensions = ['txt', 'md', 'json', 'yaml', 'yml', 'toml', 'csv', 'ts', 'js', 'tsx', 'jsx', 'svelte', 'css', 'html', 'rs', 'py', 'go', 'java', 'c', 'cpp', 'h', 'hpp'];
  const ext = getFileExtension(path);
  return textExtensions.includes(ext);
}
