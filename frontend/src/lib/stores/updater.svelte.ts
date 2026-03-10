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

class UpdaterStore {
  // State
  checking = $state(false);
  updateAvailable = $state(false);
  updateInfo = $state<UpdateInfo | null>(null);
  lastChecked = $state<Date | null>(null);
  error = $state<string | null>(null);
  
  // Private
  private checkInterval: ReturnType<typeof setInterval> | null = null;
  private isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

  constructor() {
    // Auto-check on startup if in Tauri
    if (this.isTauri) {
      // Wait a bit for app to fully load
      setTimeout(() => {
        this.checkForUpdates(true);
      }, 5000);
      
      // Set up periodic checks every 2 hours
      this.startPeriodicChecks();
    }
  }

  /**
   * Check for updates
   * @param silent - If true, don't show error toasts for failed checks
   */
  async checkForUpdates(silent = false): Promise<UpdateInfo | null> {
    if (!this.isTauri) {
      return null;
    }

    this.checking = true;
    this.error = null;

    try {
      const result = await invoke<{
        available: boolean;
        version: string | null;
        notes: string | null;
        pub_date: string | null;
      }>("check_for_updates");

      const updateInfo: UpdateInfo = {
        available: result.available,
        version: result.version,
        notes: result.notes,
        pubDate: result.pub_date,
      };

      this.updateInfo = updateInfo;
      this.updateAvailable = result.available;
      this.lastChecked = new Date();

      return updateInfo;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.error = errorMsg;
      
      if (!silent) {
        console.error("Failed to check for updates:", err);
      }
      
      return null;
    } finally {
      this.checking = false;
    }
  }

  /**
   * Install the available update
   */
  async installUpdate(): Promise<boolean> {
    if (!this.isTauri || !this.updateAvailable) {
      return false;
    }

    try {
      await invoke("install_update");
      // App will restart automatically after update
      return true;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.error = errorMsg;
      console.error("Failed to install update:", err);
      return false;
    }
  }

  /**
   * Open the changelog page in browser
   */
  async openChangelog(): Promise<void> {
    await open("https://koryphaios.com/changelog");
  }

  /**
   * Dismiss the current update notification
   */
  dismissUpdate(): void {
    this.updateAvailable = false;
  }

  /**
   * Start periodic update checks (every 2 hours)
   */
  startPeriodicChecks(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
    }

    this.checkInterval = setInterval(() => {
      // Only check if we haven't shown an update yet
      if (!this.updateAvailable) {
        this.checkForUpdates(true);
      }
    }, UPDATE_CHECK_INTERVAL);
  }

  /**
   * Stop periodic update checks
   */
  stopPeriodicChecks(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }

  /**
   * Get formatted last checked time
   */
  getLastCheckedText(): string {
    if (!this.lastChecked) {
      return "Never";
    }

    const now = new Date();
    const diff = now.getTime() - this.lastChecked.getTime();
    
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
    
    return this.lastChecked.toLocaleDateString();
  }
}

// Export singleton instance
export const updater = new UpdaterStore();
