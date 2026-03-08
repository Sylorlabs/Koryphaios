<script lang="ts">
  import { modeStore } from "$lib/stores/mode.svelte";
  import { Sparkles, Terminal } from "lucide-svelte";

  interface Props {
    variant?: "buttons" | "switch" | "dropdown";
  }

  let { variant = "buttons" }: Props = $props();

  function handleToggle() {
    modeStore.toggleMode();
  }

  function handleSetMode(mode: "beginner" | "advanced") {
    modeStore.setMode(mode);
  }
</script>

{#if variant === "buttons"}
  <div class="flex items-center gap-1 p-1 rounded-lg" style="background: var(--color-surface-2);">
    <button
      class="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-all"
      class:active={modeStore.isBeginner}
      onclick={() => handleSetMode("beginner")}
      disabled={modeStore.isLoading}
      title="Beginner mode - Simple and guided"
    >
      <Sparkles size={14} />
      <span>Beginner</span>
    </button>
    <button
      class="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-all"
      class:active={modeStore.isAdvanced}
      onclick={() => handleSetMode("advanced")}
      disabled={modeStore.isLoading}
      title="Advanced mode - Full control"
    >
      <Terminal size={14} />
      <span>Advanced</span>
    </button>
  </div>
{:else if variant === "switch"}
  <button
    class="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-all"
    style="background: var(--color-surface-2);"
    onclick={handleToggle}
    disabled={modeStore.isLoading}
    title={`Currently in ${modeStore.displayName} mode. Click to switch.`}
  >
    {#if modeStore.isBeginner}
      <Sparkles size={14} />
      <span>Beginner</span>
    {:else}
      <Terminal size={14} />
      <span>Advanced</span>
    {/if}
  </button>
{/if}

<style>
  button {
    color: var(--color-text-muted);
  }
  
  button:hover:not(:disabled) {
    color: var(--color-text-primary);
    background: var(--color-surface-3);
  }
  
  button.active {
    color: var(--color-text-primary);
    background: var(--color-surface-0);
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1);
  }
  
  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
