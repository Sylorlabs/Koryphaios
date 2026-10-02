<script lang="ts">
  /**
   * Test fixture: a component whose `$effect` throws. Used to prove that a
   * `<svelte:boundary>` with a `failed` snippet contains an effect throw —
   * without one, Svelte rethrows out of the reactive flush and every later
   * effect in the queue is skipped, which freezes the UI.
   */
  interface Props {
    message?: string;
  }

  let { message = 'effect exploded' }: Props = $props();

  $effect(() => {
    throw new Error(message);
  });
</script>

<p>this subtree should never render</p>
