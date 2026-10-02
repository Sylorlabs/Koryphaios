<script lang="ts">
  import { useAgentRail, type AgentRailState } from '../useAgentRail.svelte';

  let { onReady }: { onReady: (rail: AgentRailState) => void } = $props();

  const rail = useAgentRail();
  $effect(() => onReady(rail));
</script>

<div data-testid="harness"></div>
