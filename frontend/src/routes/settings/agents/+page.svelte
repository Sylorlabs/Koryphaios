<script>
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  
  onMount(() => {
    // Redirect to main app - agent settings are in the main settings drawer
    goto('/');
  });
</script>

<div class="flex items-center justify-center h-full">
  <div class="text-muted-foreground">Redirecting to Agent Settings...</div>
</div>
