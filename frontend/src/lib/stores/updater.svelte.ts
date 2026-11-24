import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-shell';
import { listen } from '@tauri-apps/api/event';
import type { UpdateReleaseActivity, UpdateReleaseStatus } from '@koryphaios/shared';
import { apiUrl } from '$lib/utils/api-url';

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

// Signed-manifest update check interval: 30 minutes in milliseconds.
const UPDATE_CHECK_INTERVAL = 30 * 60 * 1000;
// Release-activity poll: 5 minutes, so a newly triggered GitHub Actions run
// shows up promptly without re-downloading the signed manifest every time.
const RELEASE_ACTIVITY_INTERVAL = 5 * 60 * 1000;

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
  let dialogOpen = $state(false);
  /** A GitHub Actions release that is preparing/building but not installable yet. */
  let releaseActivity = $state<UpdateReleaseActivity | null>(null);
  /** True only while the one launch-time auto-install is in flight. */
  let launchInstalling = $state(false);

  // Private
  let checkInterval: ReturnType<typeof setInterval> | null = null;
  let activityInterval: ReturnType<typeof setInterval> | null = null;
  const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  const updaterEnabled = isTauri && !import.meta.env.DEV;
  let updateDownloaded = false;
  // Running total of bytes downloaded, so we can compute a percentage from
  // the incremental chunk_length events the Rust side emits.
  let downloadedBytes = 0;

  async function setupEventListeners() {
    if (!updaterEnabled) return;

    try {
      // Listen for download progress events emitted by install_update's
      // on_chunk callback. payload = { chunkLength, contentLength }.
      await listen<{ chunkLength: number; contentLength: number | null }>(
        'tauri://update-download-progress',
        (event) => {
          const payload = event.payload;
          if (!payload) return;
          downloadedBytes += payload.chunkLength;
          const total = payload.contentLength;
          if (total && total > 0) {
            downloadProgress = Math.min(100, Math.round((downloadedBytes / total) * 100));
          } else {
            // No content-length — show bytes downloaded in MB as a fallback.
            downloadProgress = Math.round(downloadedBytes / (1024 * 1024));
          }
        },
      );
    } catch (e) {
      // Event listeners might not be available in all Tauri versions
    }
  }

  /**
   * Ask the local backend whether the configured GitHub Actions release
   * trigger is preparing or building a version. This is additive: the signed
   * manifest check below is still the only thing that can offer an install.
   */
  async function fetchReleaseActivity(): Promise<UpdateReleaseActivity | null> {
    try {
      const response = await fetch(apiUrl('/api/updates/status'), {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(6_000),
      });
      if (!response.ok) return null;
      const body = (await response.json()) as { ok?: boolean; data?: UpdateReleaseStatus };
      return body.ok && body.data ? body.data.activity : null;
    } catch {
      return null;
    }
  }

  /**
   * Check for updates
   * @param silent - If true, don't show error toasts for failed checks
   */
  /** Refresh only the GitHub Actions activity, leaving the signed check alone. */
  async function refreshReleaseActivity(): Promise<void> {
    releaseActivity = await fetchReleaseActivity();
  }

  async function checkForUpdates(silent = false): Promise<UpdateInfo | null> {
    if (!updaterEnabled) {
      return null;
    }

    checking = true;
    // A silent background check must not clear or set the error the install
    // dialog shows: a transient network failure there would otherwise read as
    // "Update failed" and disable Install until the next successful check.
    if (!silent) error = null;

    try {
      const [tauriCheck, activityResult] = await Promise.allSettled([
        invoke<{
          available: boolean;
          version: string | null;
          notes: string | null;
          pub_date: string | null;
        }>('check_for_updates'),
        fetchReleaseActivity(),
      ]);
      // The release-activity probe is independent of the signed manifest. A
      // manifest failure must not hide a release that GitHub Actions is still
      // building, and vice versa.
      if (activityResult.status === 'fulfilled') releaseActivity = activityResult.value;
      if (tauriCheck.status === 'rejected') throw tauriCheck.reason;
      const result = tauriCheck.value;

      const info: UpdateInfo = {
        available: result.available,
        version: result.version,
        notes: result.notes,
        pubDate: result.pub_date,
      };

      updateInfo = info;
      updateAvailable = result.available;
      lastChecked = new Date();

      // If update is available, show the banner.
      // NOTE: we do NOT auto-download here — the previous implementation called
      // downloadUpdate() which was a no-op (it just set downloadProgress = 0),
      // giving the false impression that the update was pre-downloaded. The
      // real download happens during installUpdateAndRestart(), with live
      // progress events wired through to the UI.
      if (result.available) {
        showUpdateBanner = true;
        downloadedBytes = 0;
        downloadProgress = 0;
      }

      return info;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      if (!silent) {
        error = errorMsg;
        console.error('Failed to check for updates:', err);
      } else {
        console.warn('Background update check failed:', errorMsg);
      }

      return null;
    } finally {
      checking = false;
    }
  }

  /**
   * Install the available update and restart.
   * Resets progress state, invokes the Rust install_update command (which
   * downloads + verifies + installs + restarts), and surfaces errors so the
   * caller can reset its UI state.
   */
  async function installUpdateAndRestart(): Promise<boolean> {
    if (!updaterEnabled || !updateAvailable) {
      return false;
    }

    // Reset progress tracking for this install attempt.
    downloadedBytes = 0;
    downloadProgress = 0;
    error = null;

    try {
      await invoke('install_update');
      // On Linux/macOS the app restarts via request_restart() inside the
      // Rust command, so this line rarely executes. On Windows the NSIS/MSI
      // installer handles relaunch. Return true either way.
      return true;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      error = errorMsg;
      console.error('Failed to install update:', err);
      // Reset progress so the UI doesn't show a stale percentage after failure.
      downloadProgress = 0;
      downloadedBytes = 0;
      return false;
    }
  }

  /** Reset the install/error state so the UI can recover after a failure. */
  function resetInstallState(): void {
    error = null;
    downloadProgress = 0;
    downloadedBytes = 0;
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
      // Keep checking even after an update is offered. A release can be
      // withdrawn or superseded, and the title-bar pill must disappear when
      // that happens rather than staying on a stale offer forever.
      checkForUpdates(true);
    }, UPDATE_CHECK_INTERVAL);

    activityInterval = setInterval(() => {
      if (updateAvailable) return;
      const hadActivity = releaseActivity !== null;
      void refreshReleaseActivity().then(() => {
        // A finished run is the moment the signed manifest may have appeared.
        // Check it immediately instead of waiting for the 30-minute tick.
        if (hadActivity && !releaseActivity) void checkForUpdates(true);
      });
    }, RELEASE_ACTIVITY_INTERVAL);
  }

  /**
   * Stop periodic update checks
   */
  function stopPeriodicChecks(): void {
    if (checkInterval) {
      clearInterval(checkInterval);
      checkInterval = null;
    }
    if (activityInterval) {
      clearInterval(activityInterval);
      activityInterval = null;
    }
  }

  /**
   * Open the changelog page in browser
   */
  async function openChangelog(): Promise<void> {
    await open('https://koryphaios.com/changelog');
  }

  /** Open the GitHub Actions run for a release that is not installable yet. */
  async function openReleaseRun(): Promise<void> {
    if (releaseActivity?.runUrl) await open(releaseActivity.runUrl);
  }

  /** Compact title-bar label for the release-activity pill. */
  function getReleaseActivityLabel(): string {
    if (!releaseActivity) return '';
    const verb = releaseActivity.phase === 'building' ? 'building' : 'preparing';
    return releaseActivity.version ? `v${releaseActivity.version} ${verb}` : `Release ${verb}`;
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
  if (updaterEnabled) {
    void (async () => {
      // Progress must be observable before an automatic launch install starts.
      await setupEventListeners();

      // Auto-install is a launch-only decision. Background/login-item launches,
      // dev builds, and KORY_DISABLE_AUTO_UPDATE=1 return false from Rust.
      let autoUpdateAtLaunch = false;
      try {
        autoUpdateAtLaunch = await invoke<boolean>('should_auto_update_at_launch');
      } catch {
        autoUpdateAtLaunch = false;
      }

      const info = await checkForUpdates(true);
      if (autoUpdateAtLaunch && info?.available) {
        launchInstalling = true;
        const installed = await installUpdateAndRestart();
        if (!installed) launchInstalling = false;
      }

      // In-session checks only notify; they never install.
      startPeriodicChecks();
    })();
  }

  function openDialog(): void {
    dialogOpen = true;
    showUpdateBanner = false;
  }
  function closeDialog(): void {
    dialogOpen = false;
  }

  /** Release notes → clean, readable sections. Strips the CHANGES_JSON HTML
   *  comment, the download boilerplate, and horizontal rules. */
  function getCleanNotes(): string {
    const raw = updateInfo?.notes ?? '';
    if (!raw.trim()) return '';
    return raw
      .replace(/<!--[\s\S]*?-->/g, '') // CHANGES_JSON block
      .split('\n')
      .filter((l) => {
        const t = l.trim();
        if (!t) return false;
        if (t === '---') return false;
        if (/download below or update automatically/i.test(t)) return false;
        return true;
      })
      .join('\n')
      .trim();
  }

  return {
    // State getters
    get dialogOpen() {
      return dialogOpen;
    },
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
    get releaseActivity() {
      return releaseActivity;
    },
    get launchInstalling() {
      return launchInstalling;
    },

    // Methods
    checkForUpdates,
    installUpdateAndRestart,
    dismissUpdate,
    showUpdateNotification,
    startPeriodicChecks,
    stopPeriodicChecks,
    openChangelog,
    openReleaseRun,
    getReleaseActivityLabel,
    openDialog,
    closeDialog,
    getCleanNotes,
    getLastCheckedText,
    getUpdateMessage,
    resetInstallState,
  };
}

// Export singleton instance
export const updater = createUpdaterStore();
