<script lang="ts">
  import { modeStore } from "$lib/stores/mode.svelte";
  import { gitStore } from "$lib/stores/git.svelte";
  import { Shield, X, BookOpen } from "lucide-svelte";
  import { toastStore } from "$lib/stores/toast.svelte";

  let dismissed = $state(false);

  function handleDismiss() {
    dismissed = true;
    modeStore.dismissNoGitWarning();
  }

  function handleLearnMore() {
    toastStore.info("Git helps you track changes and collaborate with others. It's like a save history for your code!");
  }

  // Show warning only in beginner mode when no repo exists and not dismissed
  let shouldShow = $derived(
    modeStore.isBeginner && 
    !gitStore.state.isRepo && 
    !dismissed &&
    modeStore.shouldWarnNoGit
  );
</script>

{#if shouldShow}
  <div class="git-warning">
    <div class="git-warning-content">
      <div class="git-warning-icon">
        <Shield size={20} />
      </div>
      <div class="git-warning-text">
        <p class="git-warning-title">Backup Recommended</p>
        <p class="git-warning-desc">
          No backup system detected. Add your project to Git to safely save your work and track changes.
        </p>
      </div>
      <div class="git-warning-actions">
        <button 
          class="git-warning-btn learn"
          onclick={handleLearnMore}
          title="Learn more about Git"
        >
          <BookOpen size={14} />
          <span>Learn More</span>
        </button>
        <button 
          class="git-warning-btn dismiss"
          onclick={handleDismiss}
          title="Dismiss this warning"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .git-warning {
    padding: var(--space-3);
    background: linear-gradient(135deg, rgba(245, 158, 11, 0.1) 0%, rgba(245, 158, 11, 0.05) 100%);
    border: 1px solid rgba(245, 158, 11, 0.3);
    border-radius: var(--radius-lg);
    margin: var(--space-3);
  }

  .git-warning-content {
    display: flex;
    align-items: flex-start;
    gap: var(--space-3);
  }

  .git-warning-icon {
    flex-shrink: 0;
    width: 36px;
    height: 36px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(245, 158, 11, 0.2);
    border-radius: var(--radius-md);
    color: #f59e0b;
  }

  .git-warning-text {
    flex: 1;
    min-width: 0;
  }

  .git-warning-title {
    font-weight: 600;
    font-size: var(--text-sm);
    color: var(--color-text-primary);
    margin: 0 0 var(--space-1) 0;
  }

  .git-warning-desc {
    font-size: var(--text-xs);
    color: var(--color-text-muted);
    margin: 0;
    line-height: 1.5;
  }

  .git-warning-actions {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-shrink: 0;
  }

  .git-warning-btn {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    padding: var(--space-1.5) var(--space-2);
    border-radius: var(--radius-md);
    font-size: var(--text-xs);
    font-weight: 500;
    transition: all 0.15s ease;
    border: none;
    cursor: pointer;
  }

  .git-warning-btn.learn {
    background: rgba(245, 158, 11, 0.15);
    color: #f59e0b;
  }

  .git-warning-btn.learn:hover {
    background: rgba(245, 158, 11, 0.25);
  }

  .git-warning-btn.dismiss {
    background: transparent;
    color: var(--color-text-muted);
    padding: var(--space-1.5);
  }

  .git-warning-btn.dismiss:hover {
    background: var(--color-surface-3);
    color: var(--color-text-primary);
  }
</style>
