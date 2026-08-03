<script lang="ts">
  import { MessageSquare } from 'lucide-svelte';
  import SessionSidebar from './SessionSidebar.svelte';

  interface Props {
    currentSessionId?: string;
  }

  let { currentSessionId = $bindable('') }: Props = $props();
</script>

<div class="h-full flex flex-col bg-[var(--color-surface-1)]">
  <div class="flex items-center gap-2 px-4 py-3 border-b border-[var(--color-border)] shrink-0 text-xs font-medium text-[var(--color-text-muted)]">
    <MessageSquare size={14} />
    <span>Chats</span>
  </div>

  <div class="flex-1 overflow-hidden relative">
    <div class="absolute inset-0">
      <SessionSidebar {currentSessionId} />
    </div>
  </div>
</div>
