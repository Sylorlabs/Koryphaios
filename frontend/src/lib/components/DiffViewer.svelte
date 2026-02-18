<script lang="ts">
  import { wsStore } from "$lib/stores/websocket.svelte";

  interface Props {
    sessionId?: string;
  }

  let { sessionId }: Props = $props();

  // Collect diffs from tool results
  let diffs = $derived(
    wsStore.feed
      .filter((item) => {
        if (item.type !== "tool_result") return false;
        // Look for edit/write tool results that contain diff-like output
        return item.text && (
          item.text.includes("@@") ||
          item.text.includes("+++ ") ||
          item.text.includes("--- ")
        );
      })
      .map((item) => ({
        id: item.id,
        agentId: item.agentId ?? "unknown",
        agentName: item.agentName ?? "unknown",
        content: item.text,
        timestamp: item.timestamp,
      }))
      .slice(-20) // Keep last 20 diffs
  );

  let selectedDiff = $state<number | null>(null);

  function parseDiff(raw: string): Array<{ type: "add" | "remove" | "context" | "header"; text: string }> {
    return raw.split("\n").map((line) => {
      if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")) {
        return { type: "header" as const, text: line };
      } else if (line.startsWith("+")) {
        return { type: "add" as const, text: line };
      } else if (line.startsWith("-")) {
        return { type: "remove" as const, text: line };
      } else {
        return { type: "context" as const, text: line };
      }
    });
  }

  function lineClass(type: "add" | "remove" | "context" | "header"): string {
    switch (type) {
      case "add": return "bg-green-500/10 text-green-400";
      case "remove": return "bg-red-500/10 text-red-400";
      case "header": return "bg-blue-500/10 text-blue-400 font-bold";
      case "context": return "text-text-muted";
    }
  }
</script>

<div class="h-full flex flex-col">
  <div class="px-4 py-3 border-b border-border flex items-center justify-between">
    <h2 class="text-xs font-semibold text-text-primary tracking-wide uppercase">Diffs</h2>
    <span class="text-[10px] text-text-muted">{diffs.length} change{diffs.length !== 1 ? 's' : ''}</span>
  </div>

  {#if diffs.length === 0}
    <div class="flex-1 flex items-center justify-center text-text-muted text-xs">
      No file changes yet
    </div>
  {:else}
    <div class="flex-1 flex overflow-hidden">
      <!-- Diff list -->
      <div class="w-48 border-r border-border overflow-y-auto">
        {#each diffs as diff, i (diff.id)}
          <button
            onclick={() => selectedDiff = i}
            class="w-full text-left px-3 py-2 text-xs border-b border-border/50 hover:bg-surface-3 transition-colors
              {selectedDiff === i ? 'bg-accent/10 border-l-2 border-l-accent' : ''}"
          >
            <div class="font-mono text-text-secondary truncate">
              {diff.agentName}
            </div>
            <div class="text-[10px] text-text-muted mt-0.5">
              {new Date(diff.timestamp).toLocaleTimeString()}
            </div>
          </button>
        {/each}
      </div>

      <!-- Diff content -->
      <div class="flex-1 overflow-auto">
        {#if selectedDiff !== null && diffs[selectedDiff]}
          {@const lines = parseDiff(diffs[selectedDiff].content)}
          <pre class="text-[11px] leading-relaxed font-mono p-3">
            {#each lines as line, lineNum}
<span class="inline-block w-8 text-right mr-3 text-text-muted select-none opacity-50">{lineNum + 1}</span><span class="{lineClass(line.type)} px-1">{line.text}</span>
            {/each}
          </pre>
        {:else}
          <div class="flex-1 flex items-center justify-center text-text-muted text-xs">
            Select a diff to view
          </div>
        {/if}
      </div>
    </div>
  {/if}
</div>
