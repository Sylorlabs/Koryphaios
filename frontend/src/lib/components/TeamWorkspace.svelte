<script lang="ts">
  import { collaborationStore } from '$lib/stores/collaboration.svelte';
  import Users from 'lucide-svelte/icons/users';
  import FolderOpen from 'lucide-svelte/icons/folder-open';
  import ArrowLeft from 'lucide-svelte/icons/arrow-left';
  import LogOut from 'lucide-svelte/icons/log-out';
  const team = $derived(collaborationStore.activeJoinedSession);
  const selectedFolder = $derived(collaborationStore.activeJoinedFolder);
  let frame = $state<HTMLIFrameElement>();

  function receiveMetadata(event: MessageEvent) {
    if (!team || !frame || event.source !== frame.contentWindow) return;
    if (event.origin !== new URL(team.inviteUrl).origin || event.data?.type !== 'kory-team-metadata') return;
    collaborationStore.updateJoinedMetadata(team.sessionId, event.data);
  }
</script>

<svelte:window onmessage={receiveMetadata} />

{#if team}
  <div class="flex h-full min-h-0 flex-col bg-[var(--color-surface-0)]">
    <header class="flex shrink-0 items-center gap-3 border-b border-[var(--color-border)] px-5 py-3">
      <button type="button" onclick={() => collaborationStore.closeJoinedSession()}
        class="rounded-md p-2 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-3)]"
        aria-label="Back to personal workspace"><ArrowLeft size={16} /></button>
      <Users size={18} class="shrink-0 text-[var(--color-accent)]" />
      <div class="min-w-0 flex-1">
        <h2 class="truncate text-sm font-semibold text-[var(--color-text-primary)]">{team.hostName || 'Host'} · {team.sessionName}</h2>
        <p class="mt-0.5 text-[11px] text-[var(--color-text-muted)]">{team.tierId} access · Hosted workspace</p>
      </div>
      <button type="button" onclick={() => collaborationStore.leaveJoinedSession(team.sessionId)}
        class="rounded-md p-2 text-[var(--color-text-muted)] hover:text-[var(--color-error)]"
        aria-label="Leave team session"><LogOut size={15} /></button>
    </header>
    {#if team.sharedFolders?.length}
      <nav aria-label="Host shared folders" class="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--color-border)] px-5 py-2">
        {#each team.sharedFolders as folder (folder.id)}
          <button type="button" onclick={() => collaborationStore.openJoinedSession(team.sessionId, folder.id)}
            aria-pressed={selectedFolder?.id === folder.id}
            class="inline-flex items-center gap-2 rounded-md border border-transparent px-2 py-1 text-xs text-[var(--color-text-secondary)] hover:border-[var(--color-border-bright)] aria-pressed:border-[var(--color-border-bright)]">
            <FolderOpen size={14} class="text-[var(--color-accent)]" /> {folder.name}
          </button>
        {/each}
      </nav>
    {/if}
    <div class="relative min-h-0 flex-1">
      <iframe bind:this={frame} title={team.sessionName} src={team.inviteUrl}
        class="absolute inset-0 h-full w-full border-0" sandbox="allow-scripts allow-same-origin allow-forms"></iframe>
    </div>
  </div>
{/if}
