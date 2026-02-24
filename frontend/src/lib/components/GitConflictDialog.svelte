<script lang="ts">
  import { AlertTriangle, Send, X, Check } from 'lucide-svelte';
  import { gitStore } from '$lib/stores/git.svelte';
  import { wsStore } from '$lib/stores/websocket.svelte';
  import { sessionStore } from '$lib/stores/sessions.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';

  interface Props {
    conflicts: string[];
    onClose: () => void;
  }

  let { conflicts, onClose }: Props = $props();

  async function sendToKory() {
    const sessionId = sessionStore.activeSessionId;
    if (!sessionId) {
      toastStore.error('No active session to send conflicts to');
      return;
    }

    const fileList = conflicts.join('\n- ');
    const message = `I encountered Git merge conflicts in the following files:
- ${fileList}

Please help me resolve these conflicts. You can read the files to see the conflict markers.`;
    
    wsStore.sendMessage(sessionId, message);
    toastStore.success('Conflict details sent to Kory');
    gitStore.clearConflicts();
    onClose();
  }
</script>

<div 
  class="fixed inset-0 z-[100] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4" 
  onclick={onClose}
  role="presentation"
>
  <div 
    class="w-full max-w-md rounded-xl overflow-hidden bg-[var(--color-surface-1)] border border-red-500/30 shadow-2xl" 
    onclick={e => e.stopPropagation()}
    onkeydown={e => { if (e.key === 'Escape') onClose(); }}
    role="dialog"
    aria-modal="true"
    aria-labelledby="conflict-title"
    tabindex="-1"
  >
    <!-- Header -->
    <div class="bg-red-500/10 px-4 py-3 border-b border-red-500/20 flex items-center gap-3">
      <div class="w-8 h-8 rounded-full bg-red-500/20 flex items-center justify-center text-red-500">
        <AlertTriangle size={18} />
      </div>
      <div>
        <h3 id="conflict-title" class="text-sm font-bold text-red-500">Merge Conflicts Detected</h3>
        <p class="text-[10px] text-red-400/80 uppercase tracking-wider font-medium">Automatic merge failed</p>
      </div>
      <button class="ml-auto p-1 hover:bg-red-500/10 rounded text-red-500/50" onclick={onClose}>
        <X size={16} />
      </button>
    </div>

    <!-- Body -->
    <div class="p-4">
      <p class="text-xs text-[var(--color-text-secondary)] mb-3">
        Git encountered conflicts in {conflicts.length} file{conflicts.length !== 1 ? 's' : ''}. You need to resolve these markers before committing.
      </p>
      
      <div class="max-h-40 overflow-y-auto rounded-lg bg-[var(--color-surface-0)] border border-[var(--color-border)] mb-4">
        {#each conflicts as file}
          <div class="px-3 py-2 text-[11px] font-mono border-b border-[var(--color-border)] last:border-0 flex items-center gap-2">
            <div class="w-1.5 h-1.5 rounded-full bg-red-500"></div>
            <span class="truncate text-[var(--color-text-primary)]">{file}</span>
          </div>
        {/each}
      </div>

      <div class="bg-amber-500/5 rounded-lg border border-amber-500/10 p-3 mb-4">
        <div class="flex gap-2">
          <Send size={14} class="text-amber-500 shrink-0 mt-0.5" />
          <p class="text-[11px] text-amber-200/70 leading-relaxed">
            <span class="font-bold text-amber-500">AI Resolution:</span> Would you like to send these conflict details to Kory? Kory can analyze the markers and propose a fix.
          </p>
        </div>
      </div>
    </div>

    <!-- Footer -->
    <div class="px-4 py-3 bg-[var(--color-surface-2)] border-t border-[var(--color-border)] flex gap-2">
      <button class="flex-1 btn btn-secondary text-xs" onclick={onClose}>
        Resolve Manually
      </button>
      <button class="flex-1 btn btn-primary bg-amber-600 hover:bg-amber-500 border-none text-xs gap-2" onclick={sendToKory}>
        <Send size={12} /> Send to Kory
      </button>
    </div>
  </div>
</div>
