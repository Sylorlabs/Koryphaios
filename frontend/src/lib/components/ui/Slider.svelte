<script lang="ts">
  interface Props {
    value?: number[];
    min?: number;
    max?: number;
    step?: number;
    disabled?: boolean;
    class?: string;
    onValueChange?: (value: number[]) => void;
  }

  let {
    value = $bindable([0]),
    min = 0,
    max = 100,
    step = 1,
    disabled = false,
    class: className = '',
    onValueChange,
  }: Props = $props();

  function handleInput(e: Event) {
    const target = e.target as HTMLInputElement;
    const newValue = parseFloat(target.value);
    value = [newValue];
    onValueChange?.(value);
  }
</script>

<div class="relative flex w-full touch-none select-none items-center {className}">
  <input
    type="range"
    {min}
    {max}
    {step}
    {disabled}
    value={value[0]}
    oninput={handleInput}
    class="h-2 w-full cursor-pointer appearance-none rounded-full bg-secondary accent-primary disabled:cursor-not-allowed disabled:opacity-50"
  />
</div>
