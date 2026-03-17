<script>
  import { Info } from 'lucide-svelte';
</script>

<div class="mx-auto max-w-2xl space-y-6">
  <div>
    <h1 class="text-2xl font-bold">Notifications</h1>
    <p class="text-muted-foreground">Manage your notification preferences</p>
  </div>

  <div class="flex items-start gap-4 rounded-lg border border-border bg-card p-6">
    <Info class="h-5 w-5 text-muted-foreground mt-0.5" />
    <div>
      <h3 class="font-medium">Coming Soon</h3>
      <p class="text-sm text-muted-foreground mt-1">
        Notification settings will be available in a future update. 
        For now, notifications are managed through your system settings.
      </p>
    </div>
  </div>
</div>
