<script lang="ts">
  import { wsStore } from "$lib/stores/websocket.svelte";
  import { sessionStore } from "$lib/stores/sessions.svelte";
  import { MessageSquare, ArrowRight, CornerDownRight } from "lucide-svelte";

  let otherValue = $state("");
  let showOther = $state(false);

  let pendingQuestion = $derived(wsStore.pendingQuestion);

  function select(option: string) {
    if (option.toLowerCase().includes("other") || option.toLowerCase().includes("something else")) {
      showOther = true;
      return;
    }
    submit(option);
  }

  function submit(val: string) {
    if (!sessionStore.activeSessionId) return;
    wsStore.sendUserInput(sessionStore.activeSessionId, val);
    otherValue = "";
    showOther = false;
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && otherValue.trim()) {
      submit(otherValue);
    }
  }
</script>

{#if pendingQuestion}
  <div class="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
    <div class="w-full max-w-lg bg-[var(--color-surface-1)] border border-[var(--color-border)] rounded-2xl shadow-2xl overflow-hidden animate-in fade-in zoom-in duration-200">
      <div class="px-6 py-5 border-b border-[var(--color-border)] bg-[var(--color-surface-2)] flex items-center gap-3">
        <div class="w-8 h-8 rounded-full bg-amber-500/20 flex items-center justify-center text-amber-500">
          <MessageSquare size={18} />
        </div>
        <div>
          <h3 class="text-sm font-semibold text-[var(--color-text-primary)]">Kory needs guidance</h3>
          <p class="text-[10px] text-[var(--color-text-muted)]">Please select an option to continue</p>
        </div>
      </div>

      <div class="p-6">
        <p class="text-sm text-[var(--color-text-secondary)] mb-6 leading-relaxed">
          {pendingQuestion.question}
        </p>

        {#if !showOther}
          <div class="space-y-2">
            {#each pendingQuestion.options as option}
              <button
                class="w-full flex items-center justify-between px-4 py-3 text-left text-sm rounded-xl transition-all border border-[var(--color-border)] bg-[var(--color-surface-2)] hover:bg-[var(--color-surface-3)] hover:border-amber-500/50 group"
                onclick={() => select(option)}
              >
                <span class="text-[var(--color-text-primary)] group-hover:text-amber-400 transition-colors">{option}</span>
                <ArrowRight size={14} class="text-[var(--color-text-muted)] group-hover:text-amber-400 group-hover:translate-x-0.5 transition-all" />
              </button>
            {/each}
          </div>
        {:else}
          <div class="space-y-4">
            <div class="relative">
              <div class="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]">
                <CornerDownRight size={16} />
              </div>
              <input
                type="text"
                bind:value={otherValue}
                onkeydown={handleKeydown}
                placeholder="Type your own answer..."
                class="w-full pl-10 pr-4 py-3 bg-[var(--color-surface-2)] border border-[var(--color-border)] rounded-xl text-sm focus:outline-none focus:border-amber-500 transition-colors"
              />
            </div>
            <div class="flex gap-2">
              <button
                class="flex-1 px-4 py-2.5 text-sm font-medium rounded-xl bg-amber-500 text-black hover:bg-amber-400 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                onclick={() => submit(otherValue)}
                disabled={!otherValue.trim()}
              >
                Confirm
              </button>
              <button
                class="px-4 py-2.5 text-sm font-medium rounded-xl bg-[var(--color-surface-3)] text-[var(--color-text-primary)] hover:bg-[var(--color-surface-4)] transition-colors"
                onclick={() => showOther = false}
              >
                Back
              </button>
            </div>
          </div>
        {/if}
      </div>
    </div>
  </div>
{/if}
