<script lang="ts">
  /**
   * Test fixture: pushes a throwing `$effect` one component level further from
   * the boundary, so containment is proven to survive the parent-chain walk in
   * `invoke_error_boundary` rather than only at depth 1.
   *
   * Mirrors the real shape: the `+layout.svelte` boundary wraps `{@render
   * children()}`, so the failing effect is many component levels below it.
   */
  import ThrowingEffect from './ThrowingEffect.svelte';

  interface Props {
    message?: string;
  }

  let { message = 'effect exploded' }: Props = $props();
</script>

<div class="route-shell">
  <main>
    <ThrowingEffect {message} />
  </main>
</div>
