<script lang="ts">
  import DiffMatchPatch from 'diff-match-patch';

  export let originalText: string = '';
  export let newText: string = '';
  export let onAccept: () => void;
  export let onReject: () => void;

  const dmp = new DiffMatchPatch();
  
  $: diffs = dmp.diff_main(originalText, newText);
  $: {
     dmp.diff_cleanupSemantic(diffs);
  }

  // dmp.diff_main returns an array of tuples: [operation, text]
  // operation: -1 (delete), 1 (insert), 0 (equal)
</script>

<div class="diff-viewer flex flex-col bg-[#1e1e1e] text-[#d4d4d4] rounded-md overflow-hidden font-mono text-sm border border-gray-700">
  <div class="flex justify-between items-center bg-[#2d2d2d] px-4 py-2 border-b border-gray-700">
    <span class="font-semibold text-gray-300">Suggested Changes</span>
    <div class="flex gap-2">
      <button 
        class="px-3 py-1 bg-red-900/50 hover:bg-red-800/70 text-red-200 rounded transition-colors cursor-pointer"
        on:click={onReject}>
        Reject
      </button>
      <button 
        class="px-3 py-1 bg-green-900/50 hover:bg-green-800/70 text-green-200 rounded transition-colors cursor-pointer"
        on:click={onAccept}>
        Accept
      </button>
    </div>
  </div>
  
  <div class="p-4 overflow-auto max-h-[500px] whitespace-pre-wrap break-all leading-relaxed">
    {#each diffs as [op, text]}
      {#if op === 1}
        <span class="bg-green-900/40 text-green-300">{text}</span>
      {:else if op === -1}
        <span class="bg-red-900/40 text-red-300 line-through opacity-70">{text}</span>
      {:else}
        <span>{text}</span>
      {/if}
    {/each}
  </div>
</div>
