<script lang="ts">
  /**
   * Test fixture: a `<svelte:boundary>` around a subtree that throws from an
   * `$effect`, plus a probe *outside* the boundary that must still run.
   *
   * Mirrors the shape of the real boundaries in `routes/+layout.svelte` and
   * `components/shell/AppShell.svelte`.
   */
  import EffectProbe from './EffectProbe.svelte';
  import ThrowingEffect from './ThrowingEffect.svelte';

  interface Props {
    shouldThrow?: boolean;
    message?: string;
  }

  let { shouldThrow = true, message = 'effect exploded' }: Props = $props();
  let clicks = $state(0);
</script>

<svelte:boundary>
  {#if shouldThrow}
    <ThrowingEffect {message} />
  {:else}
    <p>content recovered</p>
  {/if}

  {#snippet failed(error, reset)}
    <p role="alert">contained: {error instanceof Error ? error.message : String(error)}</p>
    <button type="button" onclick={reset}>reset boundary</button>
  {/snippet}
</svelte:boundary>

<EffectProbe label="sibling-probe" />

<button type="button" onclick={() => (clicks += 1)}>sibling {clicks}</button>
