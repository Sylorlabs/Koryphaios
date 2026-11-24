<script lang="ts">
  import { updater } from '$lib/stores/updater.svelte';
  import Download from 'lucide-svelte/icons/download';
  import Loader2 from 'lucide-svelte/icons/loader-2';
</script>

{#if updater.launchInstalling}
  <div class="launch-update" role="status" aria-live="polite">
    <div class="launch-update-card">
      <div class="launch-update-icon">
        {#if updater.downloadProgress > 0}
          <Loader2 size={22} class="animate-spin" />
        {:else}
          <Download size={22} />
        {/if}
      </div>
      <h1>Updating Koryphaios</h1>
      <p class="launch-update-version">
        {#if updater.updateInfo?.version}
          v{updater.updateInfo.version} is being installed before launch.
        {:else}
          A new version is being installed before launch.
        {/if}
      </p>
      {#if updater.downloadProgress > 0}
        <div class="launch-update-progress" aria-hidden="true">
          <div style="width: {updater.downloadProgress}%"></div>
        </div>
        <p class="launch-update-percent">{updater.downloadProgress}%</p>
      {:else}
        <p class="launch-update-hint">Downloading the verified update…</p>
      {/if}
      <p class="launch-update-hint">The app will restart automatically.</p>
    </div>
  </div>
{/if}

<style>
  .launch-update {
    position: fixed;
    inset: 0;
    z-index: 100000;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    background: var(--color-surface-0, #09090b);
    color: var(--color-text-primary, #fafafa);
  }

  .launch-update-card {
    width: 100%;
    max-width: 380px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    padding: 32px 28px;
    text-align: center;
    border: 1px solid var(--color-border, #27272a);
    border-radius: 18px;
    background: var(--color-surface-1, #111113);
    box-shadow: 0 24px 60px rgba(0, 0, 0, 0.45);
  }

  .launch-update-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 46px;
    height: 46px;
    margin-bottom: 4px;
    border-radius: 14px;
    color: var(--color-accent, #e0b44a);
    background: color-mix(in srgb, var(--color-accent, #e0b44a) 14%, transparent);
  }

  h1 {
    font-size: 1.05rem;
    font-weight: 650;
    line-height: 1.2;
  }

  .launch-update-version {
    font-size: 0.9rem;
    line-height: 1.5;
    color: var(--color-text-secondary, #a1a1aa);
  }

  .launch-update-hint,
  .launch-update-percent {
    font-size: 0.78rem;
    color: var(--color-text-muted, #71717a);
  }

  .launch-update-progress {
    width: 100%;
    height: 6px;
    margin-top: 4px;
    overflow: hidden;
    border-radius: 999px;
    background: var(--color-surface-3, #27272a);
  }

  .launch-update-progress > div {
    height: 100%;
    border-radius: inherit;
    background: var(--color-accent, #e0b44a);
    transition: width 150ms ease-out;
  }

  @media (prefers-reduced-motion: reduce) {
    .launch-update-progress > div {
      transition: none;
    }
  }
</style>
