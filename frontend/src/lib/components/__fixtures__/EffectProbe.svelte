<script lang="ts">
  /**
   * Test fixture: a probe whose `$effect` writes to state, so its rendered text
   * is observable evidence that the effect actually ran.
   *
   * Placed *after* a throwing sibling in the template, it becomes a witness for
   * whether the reactive flush survived: Svelte's `flush_queued_effects` has no
   * try/catch around `update_effect`, so an uncontained throw aborts the loop and
   * every effect queued behind it — including this one — is silently skipped.
   */
  let { label = 'probe' }: { label?: string } = $props();

  let status = $state('pending');

  $effect(() => {
    status = 'ran';
  });
</script>

<p data-testid={label}>{status}</p>
