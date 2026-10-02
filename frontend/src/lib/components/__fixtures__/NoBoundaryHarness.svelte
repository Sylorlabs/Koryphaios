<script lang="ts">
  /**
   * Test fixture: the same throwing effect and probe as `BoundaryHarness`, but
   * with **no** `<svelte:boundary>` anywhere.
   *
   * This is the counterfactual that proves the containment test is not vacuous:
   * `Boundary.error()` re-throws when it has neither an `onerror` nor a `failed`
   * snippet, so the throw escapes into `flush_queued_effects` and aborts the
   * loop, leaving the probe stuck on its initial `pending` state.
   */
  import EffectProbe from './EffectProbe.svelte';
  import ThrowingEffect from './ThrowingEffect.svelte';

  interface Props {
    message?: string;
  }

  let { message = 'effect exploded' }: Props = $props();
</script>

<ThrowingEffect {message} />
<EffectProbe label="sibling-probe" />
