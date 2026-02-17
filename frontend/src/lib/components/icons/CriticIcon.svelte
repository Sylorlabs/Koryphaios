<script lang="ts">
  interface Props {
    size?: number;
    class?: string;
  }

  let { size = 16, class: className = '' }: Props = $props();
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  xmlns="http://www.w3.org/2000/svg"
  class={className}
  aria-label="Critic grade icon"
>
  <path d="M5.2 10.3L14.8 6.2V17.8L5.2 13.7V10.3Z" fill="currentColor" fill-opacity="0.16" />
  <path d="M5.2 10.3L14.8 6.2V17.8L5.2 13.7V10.3Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />
  <path d="M3 10.4H5.2V13.6H3C2.5 13.6 2 13.1 2 12C2 10.9 2.5 10.4 3 10.4Z" fill="currentColor" fill-opacity="0.1" />
  <path d="M3 10.4H5.2V13.6H3C2.5 13.6 2 13.1 2 12C2 10.9 2.5 10.4 3 10.4Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />
  <path d="M6 13.7L7.6 20C7.8 20.6 8.3 20.9 8.9 20.7L10.4 20.3C11 20.1 11.3 19.6 11.1 19L9.8 14.9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
  <path d="M17.2 9.7C18.1 10.3 18.7 11.1 18.7 12C18.7 12.9 18.1 13.7 17.2 14.3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
  <path d="M19.5 8.2C20.8 9.1 21.6 10.5 21.6 12C21.6 13.5 20.8 14.9 19.5 15.8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
  <path d="M21.8 6.7C23.4 7.9 24 9.9 24 12C24 14.1 23.4 16.1 21.8 17.3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
</svg>
