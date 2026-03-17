<script lang="ts">
  interface Props {
    value?: string | number;
    type?: 'text' | 'password' | 'email' | 'number' | 'url';
    placeholder?: string;
    disabled?: boolean;
    required?: boolean;
    minlength?: number;
    min?: number;
    max?: number;
    step?: number;
    class?: string;
    id?: string;
    oninput?: (e: Event) => void;
    onchange?: (e: Event) => void;
    [key: string]: unknown;
  }

  let {
    value = $bindable(''),
    type = 'text',
    placeholder = '',
    disabled = false,
    required = false,
    minlength,
    min,
    max,
    step,
    class: className = '',
    id,
    oninput,
    onchange,
    ...rest
  }: Props = $props();
</script>

<input
  {id}
  {type}
  bind:value
  {placeholder}
  {disabled}
  {required}
  {minlength}
  {min}
  {max}
  {step}
  {oninput}
  {onchange}
  class="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 {className}"
  {...rest}
/>
