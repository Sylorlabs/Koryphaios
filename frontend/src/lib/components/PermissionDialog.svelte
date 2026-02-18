<script lang="ts">
  import { wsStore } from "$lib/stores/websocket.svelte";
  import { sessionStore } from "$lib/stores/sessions.svelte";
  import { AlertTriangle, X, Check, Shield, ShieldAlert, ShieldCheck, ArrowRight } from "lucide-svelte";

  function getRiskColor(risk: string): string {
    switch (risk) {
      case "low": return "text-green-400";
      case "medium": return "text-yellow-400";
      case "high": return "text-red-400";
      default: return "text-text-muted";
    }
  }

  function getRiskBorder(risk: string): string {
    switch (risk) {
      case "low": return "border-green-500/30";
      case "medium": return "border-yellow-500/30";
      case "high": return "border-red-500/30";
      default: return "border-border";
    }
  }

  function getRiskIcon(risk: string) {
    switch (risk) {
      case "low": return ShieldCheck;
      case "medium": return ShieldAlert;
      case "high": return Shield;
      default: return Shield;
    }
  }

  function determineRiskLevel(toolName: string): "low" | "medium" | "high" {
    const highRisk = ['bash', 'write_file', 'edit_file', 'delete_file', 'move_file', 'patch', 'run'];
    const mediumRisk = ['read_file', 'grep', 'glob', 'web_fetch', 'diff'];
    const lowRisk = ['ls', 'glob', 'search'];

    if (highRisk.includes(toolName)) return "high";
    if (mediumRisk.includes(toolName)) return "medium";
    return "low";
  }

  let pendingPermissions = $derived(wsStore.pendingPermissions.filter(p => p.sessionId === sessionStore.activeSessionId));

  function approve(id: string) {
    wsStore.respondToPermission(id, true);
  }

  function deny(id: string) {
    wsStore.respondToPermission(id, false);
  }

  function approveAll() {
    for (const p of pendingPermissions) {
      wsStore.respondToPermission(p.id, true);
    }
  }
</script>

{#if pendingPermissions.length > 0}
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
    <div class="bg-surface-2 border border-border rounded-2xl shadow-2xl max-w-lg w-full mx-4 overflow-hidden">
      <div class="px-5 py-4 border-b border-border flex items-center justify-between">
        <div class="flex items-center gap-2">
          <div class="w-3 h-3 rounded-full bg-yellow-400 animate-pulse"></div>
          <h3 class="text-sm font-semibold text-text-primary">Permission Required</h3>
        </div>
        <span class="text-xs text-text-muted">
          {pendingPermissions.length} pending
        </span>
      </div>

      <div class="max-h-80 overflow-y-auto p-4 space-y-3">
        {#each pendingPermissions as perm (perm.id)}
          {@const risk = determineRiskLevel(perm.toolName)}
          {@const RiskIcon = getRiskIcon(risk)}
          <div class="p-3 rounded-xl border {getRiskBorder(risk)} bg-surface-3">
            <div class="flex items-start justify-between mb-2">
              <div>
                <span class="text-xs font-mono text-text-secondary">{perm.toolName}</span>
                <ArrowRight size={10} class="mx-1" style="color: var(--color-text-muted);" />
                <span class="text-xs font-mono font-bold text-text-primary">{perm.description}</span>
              </div>
              <span class="flex items-center gap-1 text-[10px] uppercase font-bold {getRiskColor(risk)}">
                <RiskIcon size={12} />
                {risk}
              </span>
            </div>
            {#if perm.path}
              <p class="text-xs text-text-muted font-mono mb-3">
                {perm.path}
              </p>
            {/if}
            <div class="flex gap-2 justify-end">
              <button
                onclick={() => deny(perm.id)}
                class="px-3 py-1 text-xs rounded-lg bg-surface-4 text-text-secondary hover:bg-red-500/20 hover:text-red-400 transition-colors"
              >
                Deny
              </button>
              <button
                onclick={() => approve(perm.id)}
                class="px-3 py-1 text-xs rounded-lg bg-accent/20 text-accent hover:bg-accent/30 transition-colors"
              >
                Approve
              </button>
            </div>
          </div>
        {/each}
      </div>

      {#if pendingPermissions.length > 1}
        <div class="px-5 py-3 border-t border-border flex justify-end">
          <button
            onclick={approveAll}
            class="px-4 py-1.5 text-xs rounded-lg font-medium transition-colors"
            style="background: var(--color-accent); color: var(--color-surface-0);"
          >
            Approve All ({pendingPermissions.length})
          </button>
        </div>
      {/if}
    </div>
  </div>
{/if}
