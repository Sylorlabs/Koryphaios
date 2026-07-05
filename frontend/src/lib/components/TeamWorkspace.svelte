<script lang="ts">
  import { collaborationStore } from '$lib/stores/collaboration.svelte';
  import { Users, ShieldCheck, ArrowLeft, LogOut, Wifi } from 'lucide-svelte';
  const team = $derived(collaborationStore.activeJoinedSession);
</script>

{#if team}
  <div class="flex h-full min-h-0 flex-col" style="background:var(--color-surface-0)">
    <header class="flex shrink-0 items-center gap-3 border-b px-5 py-3" style="border-color:var(--color-border);background:var(--color-surface-1)">
      <button type="button" onclick={() => collaborationStore.closeJoinedSession()} class="rounded-xl p-2 transition-colors hover:bg-[var(--color-surface-3)]" style="color:var(--color-text-muted)" title="Back to personal workspace"><ArrowLeft size={16}/></button>
      <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl" style="background:color-mix(in srgb,var(--color-accent) 14%,transparent);color:var(--color-accent)"><Users size={17}/></div>
      <div class="min-w-0 flex-1"><div class="truncate text-sm font-semibold" style="color:var(--color-text-primary)">{team.sessionName}</div><div class="mt-0.5 flex items-center gap-2 text-[10px]" style="color:var(--color-text-muted)"><span class="flex items-center gap-1 text-emerald-400"><Wifi size={10}/> Team workspace</span><span>·</span><span>{team.tierId} access</span><span>·</span><span>Separate from your personal sessions</span></div></div>
      <div class="hidden items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[10px] sm:flex" style="border-color:var(--color-border);color:var(--color-text-muted)"><ShieldCheck size={12} class="text-emerald-400"/> Host permissions enforced</div>
      <button type="button" onclick={() => collaborationStore.leaveJoinedSession(team.sessionId)} class="rounded-xl p-2 text-red-400 transition-colors hover:bg-red-500/10" title="Leave team session"><LogOut size={15}/></button>
    </header>
    <div class="relative min-h-0 flex-1">
      <iframe title={team.sessionName} src={team.inviteUrl} class="absolute inset-0 h-full w-full border-0" sandbox="allow-scripts allow-same-origin allow-forms"></iframe>
    </div>
  </div>
{/if}
