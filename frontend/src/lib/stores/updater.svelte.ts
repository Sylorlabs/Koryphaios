import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-shell";

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
}

// Update check interval: 2 hours in milliseconds
const UPDATE_CHECK_INTERVAL = 2 * 60 * 60 * 1000;

// Use a factory function to create reactive state
function createUpdaterStore() {
  // State - using runes at top level of function
  let checking = $state(false);
  let updateAvailable = $state(false);
  let updateInfo = $state<UpdateInfo | null>(null);
  let lastChecked = $state<Date | null>(null);
  let error = $state<string | null>(null);
  
  // Private
  let checkInterval: ReturnType<typeof setInterval> | null = null;
  const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

  // Auto-check on startup if in Tauri
  if (isTauri) {
    // Wait a bit for app to fully load
    setTimeout(() => {
      checkForUpdates(true);
    }, 5000);
    
    // Set up periodic checks every 2 hours
    startPeriodicChecks();
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
      }>("check_for_updates");

      const info: UpdateInfo = {
        available: result.available,
        version: result.version,
        notes: result.notes,
        pubDate: result.pub_date,
      };

      updateInfo = info;
      updateAvailable = result.available;
      lastChecked = new Date();

      return info;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      error = errorMsg;
      
      if (!silent) {
        console.error("Failed to check for updates:", err);
      }
      
      return null;
    } finally {
      checking = false;
    }
  }

  /**
   * Install the available update
   */
  async function installUpdate(): Promise<boolean> {
    if (!isTauri || !updateAvailable) {
      return false;
    }

    try {
      await invoke("install_update");
      // App will restart automatically after update
      return true;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      error = errorMsg;
      console.error("Failed to install update:", err);
      return false;
    }
  }

  /**
   * Open the changelog page in browser
   */
  async function openChangelog(): Promise<void> {
    await open("https://koryphaios.com/changelog");
  }

  /**
   * Dismiss the current update notification
   */
  function dismissUpdate(): void {
    updateAvailable = false;
  }

  /**
   * Start periodic update checks (every 2 hours)
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
   * Get formatted last checked time
   */
  function getLastCheckedText(): string {
    if (!lastChecked) {
      return "Never";
    }

    const now = new Date();
    const diff = now.getTime() - lastChecked.getTime();
    
    // Less than a minute
    if (diff < 60000) {
      return "Just now";
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

  // Return store interface
  return {
    get checking() { return checking; },
    get updateAvailable() { return updateAvailable; },
    get updateInfo() { return updateInfo; },
    get lastChecked() { return lastChecked; },
    get error() { return error; },
    checkForUpdates,
    installUpdate,
    openChangelog,
    dismissUpdate,
    startPeriodicChecks,
    stopPeriodicChecks,
    getLastCheckedText,
  };
}

// Export singleton instance
export const updater = createUpdaterStore();
