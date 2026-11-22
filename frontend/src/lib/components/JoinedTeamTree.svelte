<script lang="ts">
  import { collaborationStore } from '$lib/stores/collaboration.svelte';
  import ChevronDown from 'lucide-svelte/icons/chevron-down';
  import ChevronRight from 'lucide-svelte/icons/chevron-right';
  import FolderOpen from 'lucide-svelte/icons/folder-open';
  import Users from 'lucide-svelte/icons/users';
  import LogOut from 'lucide-svelte/icons/log-out';
  let collapsed = $state<Set<string>>(new Set());
  function toggle(id: string) {
    const next = new Set(collapsed);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    collapsed = next;
  }
</script>

{#each collaborationStore.joinedSessions as team (team.sessionId)}
  {@const folders = team.sharedFolders ?? []}
  {@const active = collaborationStore.activeJoinedSession?.sessionId === team.sessionId}
  <div class="mx-1 mb-1">
    <div class="group flex items-center gap-1 rounded-md px-1 transition-colors hover:bg-[var(--color-surface-2)]">
      <button type="button" onclick={() => toggle(team.sessionId)}
        aria-label={`${collapsed.has(team.sessionId) ? 'Expand' : 'Collapse'} ${team.hostName || 'Host'} shared folders`}
        aria-expanded={!collapsed.has(team.sessionId)}
        class="flex size-6 shrink-0 items-center justify-center rounded text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]">
        {#if collapsed.has(team.sessionId)}<ChevronRight size={13} />{:else}<ChevronDown size={13} />{/if}
      </button>
      <button type="button" onclick={() => collaborationStore.openJoinedSession(team.sessionId)}
        aria-label={`Open ${team.sessionName} hosted by ${team.hostName || 'Host'}`}
        class="flex min-w-0 flex-1 items-center gap-2 py-2 text-left">
        <Users size={15} class="shrink-0 text-[var(--color-accent)]" />
        <span class="min-w-0">
          <span class="block truncate text-xs font-semibold text-[var(--color-text-primary)]">{team.hostName || 'Host'}</span>
          <span class="block truncate text-[11px] text-[var(--color-text-muted)]">{team.sessionName} · {team.tierId}</span>
        </span>
      </button>
      <button type="button" onclick={() => collaborationStore.leaveJoinedSession(team.sessionId)}
        aria-label={`Leave ${team.sessionName}`}
        class="flex size-7 shrink-0 items-center justify-center rounded text-[var(--color-text-muted)] opacity-0 transition-opacity hover:text-[var(--color-error)] group-hover:opacity-100 focus-visible:opacity-100">
        <LogOut size={13} />
      </button>
    </div>
    {#if !collapsed.has(team.sessionId)}
      <div class="ml-5 border-l border-[var(--color-border)] pl-2">
        {#each folders as folder (folder.id)}
          <button type="button" onclick={() => collaborationStore.openJoinedSession(team.sessionId, folder.id)}
            aria-label={`Open shared folder ${folder.name} from ${team.hostName || 'Host'}`}
            aria-current={active && collaborationStore.activeJoinedFolder?.id === folder.id ? 'page' : undefined}
            title={`${team.hostName || 'Host'} / ${folder.name} · Hosted folder`}
            class="flex min-h-8 w-full items-center gap-2 rounded-md border border-transparent px-2 py-1.5 text-left text-xs text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-2)] focus-visible:outline-none focus-visible:border-[var(--color-accent)]">
            <FolderOpen size={14} class="shrink-0 text-[var(--color-accent)]" />
            <span class="min-w-0 flex-1 truncate">{folder.name}</span>
            <span class="text-[11px] text-[var(--color-text-muted)]">Shared</span>
          </button>
        {:else}
          <p class="px-2 py-2 text-[11px] text-[var(--color-text-muted)]">No shared folder reported by the host.</p>
        {/each}
      </div>
    {/if}
  </div>
{/each}
