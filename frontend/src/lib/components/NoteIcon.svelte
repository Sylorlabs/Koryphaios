<script lang="ts">
  import FileText from 'lucide-svelte/icons/file-text';
  import { isNoteIcon, type NoteIcon } from '@koryphaios/shared';
  let { icon, size = 16 }: { icon?: NoteIcon; size?: number } = $props();
</script>

<span class="note-icon" style:width={`${size}px`} style:height={`${size}px`} style:font-size={`${size}px`}
  title={icon?.label ?? undefined} aria-label={icon?.label ?? undefined} aria-hidden={icon?.label ? undefined : true}>
  {#if icon && isNoteIcon(icon)}
    {#if icon.kind === 'image'}<img src={icon.value} alt="" />{:else}{icon.value}{/if}
  {:else}<FileText {size} />{/if}
</span>

<style>
  .note-icon { display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; line-height: 1; color: var(--color-text-muted); }
  img { width: 100%; height: 100%; object-fit: contain; border-radius: 4px; }
</style>
