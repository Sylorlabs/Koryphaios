<script lang="ts">
  /**
   * Test fixture: the shape of the real app-root boundary in
   * `routes/+layout.svelte` — a `<svelte:boundary>` sitting *above* a subtree,
   * with the failing effect several component levels below it.
   */
  import EffectProbe from './EffectProbe.svelte';
  import NestedThrow from './NestedThrow.svelte';

  interface Props {
    message?: string;
  }

  let { message = 'effect exploded' }: Props = $props();
</script>

<svelte:boundary>
  <NestedThrow {message} />

  {#snippet failed(error, reset)}
    <p role="alert">contained: {error instanceof Error ? error.message : String(error)}</p>
    <button type="button" onclick={reset}>reset boundary</button>
  {/snippet}
</svelte:boundary>

<EffectProbe label="sibling-probe" />
