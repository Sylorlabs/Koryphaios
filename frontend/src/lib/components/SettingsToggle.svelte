<script lang="ts">
  interface Props {
    checked?: boolean;
    onchange?: () => void;
    id?: string;
    disabled?: boolean;
  }

  let { checked = false, onchange, id, disabled = false }: Props = $props();
</script>

<span class="relative inline-flex shrink-0 cursor-pointer items-center">
  <input
    type="checkbox"
    {id}
    {checked}
    {disabled}
    onchange={onchange}
    class="peer sr-only"
  />
  <div
    class="h-6 w-11 rounded-full bg-[var(--color-surface-4)] transition-colors
      peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[var(--color-accent)]
      peer-checked:bg-[var(--color-accent)]
      peer-disabled:cursor-not-allowed peer-disabled:opacity-50
      after:absolute after:left-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:bg-white after:shadow-sm
      after:transition-all after:content-['']
      peer-checked:after:translate-x-full"
    aria-hidden="true"
  ></div>
</span>