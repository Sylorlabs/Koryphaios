<script lang="ts">
  import { agentStore } from '$lib/stores/agents.svelte';
  import FeedEntry from '../FeedEntry.svelte';
  let { sessionId, agentId } = $props<{ sessionId: string; agentId: string }>();
  const entries = $derived.by(() => {
    void agentStore.agentThreadVersion;
    return agentStore.getAgentThreadFeed(sessionId, agentId);
  });
</script>

{#each entries as entry (entry.id)}
  <FeedEntry
    {entry}
    isSelected={false}
    isExpanded={false}
    onSelect={() => {}}
    onToggleGroup={() => {}}
    onDelete={() => {}}
  />
{/each}
