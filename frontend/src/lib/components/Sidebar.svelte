<script lang="ts">
  import { MessageSquare, GitBranch } from 'lucide-svelte';
  import SessionSidebar from './SessionSidebar.svelte';
  import SourceControlPanel from './SourceControlPanel.svelte';

  let activeTab = $state<'sessions' | 'git'>('sessions');

  interface Props {
    currentSessionId?: string;
  }

  let { currentSessionId = $bindable('') }: Props = $props();
</script>

<div class="h-full flex flex-col bg-[var(--color-surface-1)]">
  <!-- Sidebar Tabs (Activity Bar style) -->
  <div class="flex items-center gap-1 px-2 pt-2 border-b border-[var(--color-border)] shrink-0">
    <button
      class="flex-1 flex items-center justify-center gap-2 py-2 text-xs font-medium rounded-t-lg transition-colors border-t border-x border-b-0 relative top-[1px]
             {activeTab === 'sessions' ? 'bg-[var(--color-surface-1)] text-[var(--color-text-primary)] border-[var(--color-border)]' : 'bg-[var(--color-surface-2)] text-[var(--color-text-muted)] border-transparent hover:text-[var(--color-text-secondary)]'}"
      onclick={() => activeTab = 'sessions'}
    >
      <MessageSquare size={14} />
      <span>Chats</span>
    </button>
    <button
      class="flex-1 flex items-center justify-center gap-2 py-2 text-xs font-medium rounded-t-lg transition-colors border-t border-x border-b-0 relative top-[1px]
             {activeTab === 'git' ? 'bg-[var(--color-surface-1)] text-[var(--color-text-primary)] border-[var(--color-border)]' : 'bg-[var(--color-surface-2)] text-[var(--color-text-muted)] border-transparent hover:text-[var(--color-text-secondary)]'}"
      onclick={() => activeTab = 'git'}
    >
      <GitBranch size={14} />
      <span>Git</span>
    </button>
  </div>

  <div class="flex-1 overflow-hidden relative">
    {#if activeTab === 'sessions'}
      <div class="absolute inset-0">
        <SessionSidebar {currentSessionId} />
      </div>
    {:else}
      <div class="absolute inset-0">
        <SourceControlPanel />
      </div>
    {/if}
  </div>
</div>
