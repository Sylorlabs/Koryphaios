<script lang="ts">
  let {
    label,
    meta = '',
    status = '',
  } = $props<{
    label: string;
    meta?: string;
    status?: string;
  }>();
</script>

<div class="activity-row">
  <span class="label">{label}</span>
  {#if status}<span class="status">{status}</span>{/if}
  {#if meta}<span class="meta">{meta}</span>{/if}
</div>

<style>
  .activity-row {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 28px;
    font-size: 12px;
  }

  .label {
    color: var(--color-text-primary);
    font-weight: 500;
  }

  .status,
  .meta {
    color: var(--color-text-muted);
    font-size: 11px;
  }

  .meta {
    margin-left: auto;
  }
</style>
