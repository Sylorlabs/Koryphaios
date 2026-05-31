import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-shell';
import { listen } from '@tauri-apps/api/event';

export interface UpdateInfo {
  available: boolean;
  version: string | null;
  notes: string | null;
  pubDate: string | null;
}

export interface UpdateState {
  checking: boolean;
  updateAvailable: boolean;
  updateInfo: UpdateInfo | null;
  lastChecked: Date | null;
  error: string | null;
  downloaded: boolean;
  downloadProgress: number;
}

// Update check interval: 30 minutes in milliseconds
const UPDATE_CHECK_INTERVAL = 30 * 60 * 1000;

// Create updater store using Svelte 5 runes
function createUpdaterStore() {
  // State
  let checking = $state(false);
  let updateAvailable = $state(false);
  let updateInfo = $state<UpdateInfo | null>(null);
  let lastChecked = $state<Date | null>(null);
  let error = $state<string | null>(null);
  let downloaded = $state(false);
  let downloadProgress = $state(0);
  let showUpdateBanner = $state(false);

  // Private
  let checkInterval: ReturnType<typeof setInterval> | null = null;
  const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  let updateDownloaded = false;

  async function setupEventListeners() {
    if (!isTauri) return;

    try {
      // Listen for download progress events
      await listen('tauri://update-download-progress', (event: any) => {
        if (event.payload?.chunkLength) {
          downloadProgress += event.payload.chunkLength;
        }
      });
    } catch (e) {
      // Event listeners might not be available in all Tauri versions
    }
  }

  /**
   * Check for updates
   * @param silent - If true, don't show error toasts for failed checks
   */
  async function checkForUpdates(silent = false): Promise<UpdateInfo | null> {
    if (!isTauri) {
      return null;
    }

    checking = true;
    error = null;

    try {
      const result = await invoke<{
        available: boolean;
        version: string | null;
        notes: string | null;
        pub_date: string | null;
      }>('check_for_updates');

      const info: UpdateInfo = {
        available: result.available,
        version: result.version,
        notes: result.notes,
        pubDate: result.pub_date,
      };

      updateInfo = info;
      updateAvailable = result.available;
      lastChecked = new Date();

      // If update is available, show the banner
      if (result.available) {
        showUpdateBanner = true;

        // Auto-download the update in background
        downloadUpdate();
      }

      return info;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      error = errorMsg;

      if (!silent) {
        console.error('Failed to check for updates:', err);
      }

      return null;
    } finally {
      checking = false;
    }
  }

  /**
   * Download the update in the background
   */
  async function downloadUpdate(): Promise<void> {
    if (!isTauri || !updateAvailable) {
      return;
    }

    try {
      // The update is automatically downloaded when we call installUpdate
      // But we'll track the state
      downloadProgress = 0;
    } catch (err) {
      console.error('Failed to download update:', err);
    }
  }

  /**
   * Install the available update and restart
   */
  async function installUpdateAndRestart(): Promise<boolean> {
    if (!isTauri || !updateAvailable) {
      return false;
    }

    try {
      await invoke('install_update');
      // App will restart automatically after update
      return true;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      error = errorMsg;
      console.error('Failed to install update:', err);
      return false;
    }
  }

  /**
   * Dismiss the update notification
   */
  function dismissUpdate(): void {
    showUpdateBanner = false;
  }

  /**
   * Show update banner again
   */
  function showUpdateNotification(): void {
    if (updateAvailable) {
      showUpdateBanner = true;
    }
  }

  /**
   * Start periodic update checks (every 30 minutes)
   */
  function startPeriodicChecks(): void {
    if (checkInterval) {
      clearInterval(checkInterval);
    }

    checkInterval = setInterval(() => {
      // Only check if we haven't shown an update yet
      if (!updateAvailable) {
        checkForUpdates(true);
      }
    }, UPDATE_CHECK_INTERVAL);
  }

  /**
   * Stop periodic update checks
   */
  function stopPeriodicChecks(): void {
    if (checkInterval) {
      clearInterval(checkInterval);
      checkInterval = null;
    }
  }

  /**
   * Open the changelog page in browser
   */
  async function openChangelog(): Promise<void> {
    await open('https://github.com/sylorlabs/Koryphaios/releases');
  }

  /**
   * Get formatted last checked time
   */
  function getLastCheckedText(): string {
    if (!lastChecked) {
      return 'Never';
    }

    const now = new Date();
    const diff = now.getTime() - lastChecked.getTime();

    // Less than a minute
    if (diff < 60000) {
      return 'Just now';
    }

    // Less than an hour
    if (diff < 3600000) {
      const minutes = Math.floor(diff / 60000);
      return `${minutes} minute${minutes > 1 ? 's' : ''} ago`;
    }

    // Less than a day
    if (diff < 86400000) {
      const hours = Math.floor(diff / 3600000);
      return `${hours} hour${hours > 1 ? 's' : ''} ago`;
    }

    return lastChecked.toLocaleDateString();
  }

  /**
   * Get formatted update message
   */
  function getUpdateMessage(): string {
    if (!updateInfo?.version) {
      return 'A new version is available!';
    }
    return `Update to v${updateInfo.version} is ready`;
  }

  // Initialize
  if (isTauri) {
    // Check immediately on startup
    checkForUpdates(true);

    // Set up periodic checks every 30 minutes
    startPeriodicChecks();

    // Listen for update download progress
    setupEventListeners();
  }

  return {
    // State getters
    get checking() {
      return checking;
    },
    get updateAvailable() {
      return updateAvailable;
    },
    get updateInfo() {
      return updateInfo;
    },
    get lastChecked() {
      return lastChecked;
    },
    get error() {
      return error;
    },
    get downloaded() {
      return downloaded;
    },
    get downloadProgress() {
      return downloadProgress;
    },
    get showUpdateBanner() {
      return showUpdateBanner;
    },

    // Methods
    checkForUpdates,
    installUpdateAndRestart,
    dismissUpdate,
    showUpdateNotification,
    startPeriodicChecks,
    stopPeriodicChecks,
    openChangelog,
    getLastCheckedText,
    getUpdateMessage,
  };
}

// Export singleton instance
export const updater = createUpdaterStore();
