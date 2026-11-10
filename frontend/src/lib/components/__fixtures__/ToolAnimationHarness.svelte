<script lang="ts">
  import VirtualList from '../VirtualList.svelte';
  import ToolActivity from '../ToolActivity.svelte';
  import { createAutoScroll } from '$lib/utils/autoscroll.svelte';
  import type { FeedEntryLocal } from '$lib/types';

  let scroller: HTMLDivElement | undefined;
  const auto = createAutoScroll(() => scroller, { observeMutations: false });
  const items: FeedEntryLocal[] = Array.from({ length: 35 }, (_, index) => ({
    id: `tool-${index}`, type: 'tool_result', timestamp: index,
    agentId: 'kory-manager', agentName: 'Kory', glowClass: '', text: '',
    metadata: {
      toolCall: { id: `call-${index}`, name: 'call_mcp_tool', input: {
        tool_name: 'kory__grep', arguments: { pattern: 'theme' },
      } },
      toolResult: {
        callId: `call-${index}`, name: 'call_mcp_tool', isError: true,
        output: Array.from({ length: 12 }, (_, line) => `Diagnostic line ${line + 1}`).join('\n'),
      },
    },
  }));
</script>

<main style="height: 600px; width: 900px; margin: 20px;">
  <VirtualList {items} estimateHeight={() => 50} follow={auto.follow} resetKey="tool-animation-probe"
    onReady={(element) => { scroller = element; auto.attach(); }}>
    {#snippet row(entry)}
      <div style="padding: 10px 20px;" data-probe-row={entry.id}>
        <ToolActivity {entry} />
      </div>
    {/snippet}
  </VirtualList>
</main>
