<script lang="ts">
  import { wsStore } from '$lib/stores/websocket.svelte';
  import { modeStore } from '$lib/stores/mode.svelte';
  import { sessionStore } from '$lib/stores/sessions.svelte';
  import SessionSidebar from '$lib/components/SessionSidebar.svelte';
  import NoGitWarning from '$lib/components/NoGitWarning.svelte';
  import ModeToggle from '$lib/components/ModeToggle.svelte';
  import { ChevronLeft, ChevronRight } from 'lucide-svelte';

  interface Props {
    showSidebar: boolean;
    zenMode: boolean;
    onToggle: () => void;
  }

  let { showSidebar, zenMode, onToggle }: Props = $props();

  let connectedProviders = $derived(wsStore.providers.filter(p => p.authenticated).length);
  let connectionDot = $derived(
    wsStore.status === 'connected' ? 'bg-emerald-500' :
    wsStore.status === 'connecting' ? 'bg-amber-500 animate-pulse' :
    'bg-red-500'
  );
</script>

{#if showSidebar}
  <nav 
    class="shrink-0 border-r flex flex-col" 
    style="
      width: var(--sidebar-width); 
      min-width: var(--sidebar-min-width); 
      max-width: var(--sidebar-max-width); 
      border-color: var(--color-border); 
      background: var(--color-surface-1);
    " 
    aria-label="Session navigation"
  >
    <!-- Logo + project -->
    <div 
      class="flex items-center justify-between px-4 border-b shrink-0" 
      style="height: var(--header-height); border-color: var(--color-border);"
    >
      <div class="flex items-center gap-3 min-w-0">
        <img src="/logo-64.png" alt="Koryphaios" class="rounded-md shrink-0" style="width: var(--size-7); height: var(--size-7);" />
        <div class="flex flex-col justify-center min-w-0">
          <h1 class="text-sm font-semibold leading-tight" style="color: var(--color-text-primary);">Koryphaios</h1>
          <p class="leading-tight" style="font-size: var(--text-xs); color: var(--color-text-muted);">v0.1.0</p>
        </div>
      </div>
      <button
        class="rounded-md transition-colors hover:bg-[var(--color-surface-3)]"
        style="padding: var(--space-2); color: var(--color-text-muted);"
        onclick={onToggle}
        title="Hide sidebar"
        aria-label="Hide sidebar"
      >
        <ChevronLeft size={14} />
      </button>
    </div>

    <!-- No Git Warning (Beginner Mode) -->
    <NoGitWarning />
    
    <div class="flex-1 overflow-hidden">
      <SessionSidebar 
        currentSessionId={sessionStore.activeSessionId} 
      />
    </div>
    
    <!-- Mode Toggle & Sidebar footer -->
    <div 
      class="px-3 py-2 border-t flex flex-col gap-2 shrink-0" 
      style="border-color: var(--color-border);"
    >
      <div class="flex justify-center">
        <ModeToggle variant="switch" />
      </div>
      
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-2">
          <div class="rounded-full {connectionDot}" style="width: var(--size-2); height: var(--size-2);"></div>
          <span class="capitalize leading-none" style="font-size: var(--text-xs); color: var(--color-text-muted);">{wsStore.status}</span>
        </div>
        <div class="flex items-center gap-1">
          {#if connectedProviders > 0}
            <span 
              class="px-1.5 py-0.5 rounded leading-none" 
              style="font-size: var(--text-xs); background: var(--color-surface-3); color: var(--color-text-muted);"
            >
              {connectedProviders} providers
            </span>
          {/if}
        </div>
      </div>
    </div>
  </nav>
{:else if !zenMode}
  <div 
    class="shrink-0 border-r flex flex-col items-center" 
    style="width: var(--sidebar-width-collapsed); border-color: var(--color-border); background: var(--color-surface-1);"
  >
    <div 
      class="w-full border-b flex items-center justify-center" 
      style="height: var(--header-height); border-color: var(--color-border);"
    >
      <button
        class="rounded-md transition-colors hover:bg-[var(--color-surface-3)]"
        style="padding: var(--space-2); color: var(--color-text-muted);"
        onclick={onToggle}
        title="Show sidebar"
        aria-label="Show sidebar"
      >
        <ChevronRight size={14} />
      </button>
    </div>
  </div>
{/if}
