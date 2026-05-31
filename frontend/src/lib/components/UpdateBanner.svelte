<script lang="ts">
  import { updater } from "$lib/stores/updater.svelte";
  import { theme } from "$lib/stores/theme.svelte";
  import { Download, X, RefreshCw, Sparkles, Info } from "lucide-svelte";
  import { fade, slide } from "svelte/transition";
  import UpdateDialog from "./UpdateDialog.svelte";

  let updateDialog: UpdateDialog;

  async function handleRestart() {
    await updater.installUpdateAndRestart();
  }

  function handleDismiss() {
    updater.dismissUpdate();
  }

  function handleCheck() {
    updater.checkForUpdates(false);
  }

  function handleShowDetails() {
    // Hide banner and show dialog
    updater.dismissUpdate();
    updateDialog?.openDialog();
  }

  // Use accent color from theme for the glow effect
  $effect(() => {
    // This ensures the component re-renders when theme changes
    theme.preset;
    theme.accent;
  });
</script>

<!-- Instance of UpdateDialog that we can control -->
<UpdateDialog bind:this={updateDialog} />

{#if updater.showUpdateBanner && updater.updateAvailable}
  <div 
    class="update-banner"
    class:light={!theme.isDark}
    transition:slide={{ duration: 300 }}
  >
    <div class="update-content">
      <div class="update-icon">
        <Sparkles class="w-5 h-5" />
      </div>
      
      <div class="update-text">
        <span class="update-title">{updater.getUpdateMessage()}</span>
        <span class="update-subtitle">
          Restart now to get the latest features and improvements
        </span>
      </div>

      <div class="update-actions">
        <button 
          class="btn-details"
          onclick={handleShowDetails}
          title="View update details"
        >
          <Info class="w-4 h-4" />
        </button>
        
        <button 
          class="btn-restart"
          onclick={handleRestart}
          title="Restart to update"
        >
          <Download class="w-4 h-4" />
          <span>Restart to Update</span>
        </button>
        
        <button 
          class="btn-dismiss"
          onclick={handleDismiss}
          title="Dismiss"
        >
          <X class="w-4 h-4" />
        </button>
      </div>
    </div>

    <!-- Progress bar if downloading -->
    {#if updater.downloadProgress > 0 && !updater.downloaded}
      <div class="download-progress">
        <div 
          class="progress-bar"
          style="width: {Math.min(updater.downloadProgress / 100, 100)}%"
        ></div>
      </div>
    {/if}
  </div>
{/if}

<!-- Compact update indicator in corner when banner is dismissed but update available -->
{#if !updater.showUpdateBanner && updater.updateAvailable}
  <button 
    class="update-indicator"
    class:light={!theme.isDark}
    onclick={() => updater.showUpdateNotification()}
    transition:fade={{ duration: 200 }}
    title="Update available - Click to view"
  >
    <Sparkles class="w-4 h-4" />
    <span>Update Ready</span>
  </button>
{/if}

<style>
  /* Base styles using theme CSS variables */
  .update-banner {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    z-index: 9999;
    /* Use accent color for the gradient base */
    background: linear-gradient(
      135deg, 
      var(--color-accent) 0%, 
      var(--color-accent-hover) 100%
    );
    /* Adapt text color based on theme brightness */
    color: var(--color-surface-0);
    box-shadow: 
      0 4px 6px -1px rgba(0, 0, 0, 0.1), 
      0 2px 4px -1px rgba(0, 0, 0, 0.06),
      0 0 20px rgba(213, 178, 97, 0.3);
    font-family: var(--font-sans);
  }

  /* Light theme adjustments */
  .update-banner.light {
    color: var(--color-surface-0);
    box-shadow: 
      0 4px 6px -1px rgba(0, 0, 0, 0.1), 
      0 2px 4px -1px rgba(0, 0, 0, 0.06),
      0 0 20px rgba(213, 178, 97, 0.4);
  }

  .update-content {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--space-3) var(--space-6);
    max-width: 1920px;
    margin: 0 auto;
    gap: var(--space-4);
  }

  .update-icon {
    flex-shrink: 0;
    opacity: 0.9;
    animation: pulse 2s ease-in-out infinite;
  }

  @keyframes pulse {
    0%, 100% { opacity: 0.9; }
    50% { opacity: 0.6; }
  }

  .update-text {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
    gap: var(--space-1);
  }

  .update-title {
    font-weight: var(--font-semibold);
    font-size: var(--text-base);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .update-subtitle {
    font-size: var(--text-sm);
    opacity: 0.85;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .update-actions {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-shrink: 0;
  }

  .btn-restart,
  .btn-details {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-4);
    background: var(--color-surface-0);
    border: 1px solid var(--color-border-bright);
    border-radius: var(--radius-md);
    color: var(--color-accent);
    font-size: var(--text-sm);
    font-weight: var(--font-medium);
    font-family: var(--font-sans);
    cursor: pointer;
    transition: all var(--duration-normal) var(--ease-out);
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
  }

  .btn-details {
    padding: var(--space-2);
  }

  .btn-restart:hover,
  .btn-details:hover {
    transform: translateY(-1px);
    box-shadow: 0 4px 8px rgba(0, 0, 0, 0.15);
    background: var(--color-surface-1);
  }

  .btn-restart:active,
  .btn-details:active {
    transform: translateY(0);
  }

  .btn-dismiss {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: var(--space-2);
    background: transparent;
    border: none;
    border-radius: var(--radius-md);
    color: inherit;
    opacity: 0.7;
    cursor: pointer;
    transition: all var(--duration-fast) var(--ease-out);
  }

  .btn-dismiss:hover {
    opacity: 1;
    background: rgba(0, 0, 0, 0.1);
  }

  .download-progress {
    height: 2px;
    background: rgba(0, 0, 0, 0.15);
    overflow: hidden;
  }

  .progress-bar {
    height: 100%;
    background: var(--color-surface-0);
    transition: width var(--duration-normal) var(--ease-out);
  }

  /* Floating indicator */
  .update-indicator {
    position: fixed;
    bottom: var(--space-4);
    right: var(--space-4);
    z-index: 9998;
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-4);
    background: linear-gradient(
      135deg, 
      var(--color-accent) 0%, 
      var(--color-accent-hover) 100%
    );
    color: var(--color-surface-0);
    border: none;
    border-radius: var(--radius-full);
    font-size: var(--text-sm);
    font-weight: var(--font-medium);
    font-family: var(--font-sans);
    cursor: pointer;
    box-shadow: 
      0 4px 6px -1px rgba(0, 0, 0, 0.1),
      0 0 15px rgba(213, 178, 97, 0.4);
    transition: all var(--duration-normal) var(--ease-out);
    animation: indicator-pulse 2s infinite;
  }

  .update-indicator.light {
    color: var(--color-surface-0);
    box-shadow: 
      0 4px 6px -1px rgba(0, 0, 0, 0.1),
      0 0 15px rgba(213, 178, 97, 0.5);
  }

  .update-indicator:hover {
    transform: scale(1.05);
    box-shadow: 
      0 6px 8px -1px rgba(0, 0, 0, 0.15),
      0 0 20px rgba(213, 178, 97, 0.5);
  }

  @keyframes indicator-pulse {
    0%, 100% {
      opacity: 1;
      box-shadow: 
        0 4px 6px -1px rgba(0, 0, 0, 0.1),
        0 0 15px rgba(213, 178, 97, 0.4);
    }
    50% {
      opacity: 0.95;
      box-shadow: 
        0 4px 6px -1px rgba(0, 0, 0, 0.1),
        0 0 25px rgba(213, 178, 97, 0.6);
    }
  }

  /* Responsive adjustments using design tokens */
  @media (max-width: 640px) {
    .update-content {
      padding: var(--space-3) var(--space-4);
    }

    .update-subtitle {
      display: none;
    }

    .btn-restart span {
      display: none;
    }

    .btn-restart,
    .btn-details {
      padding: var(--space-2);
    }
  }

  /* Respect user's motion preferences */
  @media (prefers-reduced-motion: reduce) {
    .update-icon,
    .update-indicator {
      animation: none;
    }
    
    .btn-restart,
    .update-indicator {
      transition: none;
    }
  }
</style>
