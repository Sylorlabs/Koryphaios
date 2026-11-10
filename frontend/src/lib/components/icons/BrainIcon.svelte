<script lang="ts">
  import Brain from 'lucide-svelte/icons/brain';
  import BrainCircuit from 'lucide-svelte/icons/brain-circuit';
  import BrainCog from 'lucide-svelte/icons/brain-cog';

  interface Props {
    reasoningLevel: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'none' | string;
    size?: number;
    class?: string;
  }

  let { reasoningLevel, size = 20, class: className = '' }: Props = $props();

  function getTier(level: string): number {
    const normalized = String(level).toLowerCase().trim();

    // Token-budget style reasoning levels (e.g. Google thinking budgets)
    if (/^\d+$/.test(normalized)) {
      const budget = Number(normalized);
      if (budget <= 0) return 0;
      if (budget <= 2048) return 1;
      if (budget <= 12000) return 2;
      return 3;
    }

    switch (normalized) {
      case 'off':
      case '0':
      case 'none':
        return 0;
      case 'minimal':
      case 'low':
        return 1;
      case 'default':
      case 'medium':
        return 2;
      case 'high':
        return 3;
      case 'xhigh':
        return 4;
      case 'max':
        return 4;
      default:
        return 2;
    }
  }

  let normalized = $derived(String(reasoningLevel).toLowerCase().trim());
  let tier = $derived(getTier(normalized));
  let isXHigh = $derived(normalized === 'xhigh');
  // The CodeBuddy CLI's internal top tier (and any provider that surfaces
  // 'ultra') gets its own glyph: a brain shaped into a ring with a purple
  // four-point star at its center.
  let isUltracode = $derived(normalized === 'ultracode' || normalized === 'ultra');
  let isMax = $derived(normalized === 'max');
  let isAuto = $derived(normalized === 'adaptive' || normalized === 'auto');
  let isMedium = $derived(normalized === 'default' || normalized === 'medium');
  let isHigh = $derived(normalized === 'high');
  let Icon = $derived(tier >= 3 ? BrainCircuit : tier === 2 ? BrainCog : Brain);
  let opacity = $derived(tier === 0 ? 0.45 : 1);
</script>

<span
  class={`brain-icon ${className}`}
  style={`--icon-size: ${size}px; opacity: ${opacity};`}
  aria-hidden="true"
>
  {#if isUltracode}
    <!-- Brain formed into a ring with a purple 4-point star center. -->
    <svg
      class="tier-glyph ultracode-glyph"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <g stroke-width="1.8">
        <!-- Ring: the brain folding into a closed circle -->
        <path d="M19.967 17.483A4 4 0 1 1 12 18a4 4 0 1 1-7.967-.517" />
        <path d="M6 18a4 4 0 0 1-2-7.464" />
        <path d="M18 18a4 4 0 0 0 2-7.464" />
        <path d="M6.003 5.125a4 4 0 0 0-2.526 5.77" />
        <path d="M17.997 5.125a4 4 0 0 1 2.526 5.77" />
        <path d="M17.598 6.5A3 3 0 1 0 12 5a3 3 0 1 0-5.598 1.5" />
      </g>
      <g stroke-width="1.4">
        <!-- purple 4-point star center -->
        <path
          d="M12 8.6c.5 1.9 1.5 2.9 3.4 3.4-1.9.5-2.9 1.5-3.4 3.4-.5-1.9-1.5-2.9-3.4-3.4 1.9-.5 2.9-1.5 3.4-3.4z"
          fill="var(--color-accent, #a855f7)"
          stroke="var(--color-accent, #a855f7)"
        />
      </g>
    </svg>
  {/if}
  {#if isMax}
    <!-- Max uses the former High brain-circuit icon. -->
    <BrainCircuit {size} strokeWidth={1.9} />
  {:else if isXHigh}
    <!-- Xhigh uses the former Medium brain-cog icon. -->
    <BrainCog {size} strokeWidth={1.9} />
  {:else if isMedium}
    <!-- Medium uses the denser former Max brain. -->
    <svg
      class="tier-glyph medium-glyph"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <g stroke-width="1.8">
        <path d="M12 18V5" />
        <path d="M15 13a4.17 4.17 0 0 1-3-4 4.17 4.17 0 0 1-3 4" />
        <path d="M17.598 6.5A3 3 0 1 0 12 5a3 3 0 1 0-5.598 1.5" />
        <path d="M17.997 5.125a4 4 0 0 1 2.526 5.77" />
        <path d="M18 18a4 4 0 0 0 2-7.464" />
        <path d="M19.967 17.483A4 4 0 1 1 12 18a4 4 0 1 1-7.967-.517" />
        <path d="M6 18a4 4 0 0 1-2-7.464" />
        <path d="M6.003 5.125a4 4 0 0 0-2.526 5.77" />
      </g>
      <g stroke-width="1.1">
        <path d="M5.1 8.1c.8-.45 1.65-.25 2.05.4.4.65 1.1.85 1.7.5" />
        <path d="M18.9 8.1c-.8-.45-1.65-.25-2.05.4-.4.65-1.1.85-1.7.5" />
        <path d="M5 13.2c.8-.45 1.65-.25 2.05.4.4.65 1.1.85 1.7.5" />
        <path d="M19 13.2c-.8-.45-1.65-.25-2.05.4-.4.65-1.1.85-1.7.5" />
      </g>
    </svg>
  {:else if isHigh}
    <!-- High uses the lighter former Xhigh brain. -->
    <svg
      class="tier-glyph high-glyph"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <g stroke-width="1.8">
        <path d="M12 18V5" />
        <path d="M15 13a4.17 4.17 0 0 1-3-4 4.17 4.17 0 0 1-3 4" />
        <path d="M17.598 6.5A3 3 0 1 0 12 5a3 3 0 1 0-5.598 1.5" />
        <path d="M17.997 5.125a4 4 0 0 1 2.526 5.77" />
        <path d="M18 18a4 4 0 0 0 2-7.464" />
        <path d="M19.967 17.483A4 4 0 1 1 12 18a4 4 0 1 1-7.967-.517" />
        <path d="M6 18a4 4 0 0 1-2-7.464" />
        <path d="M6.003 5.125a4 4 0 0 0-2.526 5.77" />
      </g>
      <g stroke-width="1.05">
        <path d="M5.1 8.1c.8-.45 1.65-.25 2.05.4.4.65 1.1.85 1.7.5" />
        <path d="M18.9 8.1c-.8-.45-1.65-.25-2.05.4-.4.65-1.1.85-1.7.5" />
        <path d="M5 11c.75-.4 1.5-.15 1.9.45.4.6 1.05.75 1.6.35" />
        <path d="M19 11c-.75-.4-1.5-.15-1.9.45-.4.6-1.05.75-1.6.35" />
        <path d="M5 13.9c.8-.45 1.65-.25 2.05.4.4.65 1.1.85 1.7.5" />
        <path d="M19 13.9c-.8-.45-1.65-.25-2.05.4-.4.65-1.1.85-1.7.5" />
        <path d="M7.1 16.15c.75-.35 1.45-.1 1.8.55" />
        <path d="M16.9 16.15c-.75-.35-1.45-.1-1.8.55" />
      </g>
    </svg>
  {:else if isAuto}
    <div class="auto-icon-wrapper">
      <Brain size={size * 0.75} strokeWidth={1.9} />
      <svg class="auto-loop" viewBox="0 0 24 24" fill="none" stroke="currentColor">
        <circle cx="12" cy="12" r="10.5" stroke-width="1.2" stroke-dasharray="3 3" />
      </svg>
    </div>
  {:else}
    <Icon {size} strokeWidth={1.9} />
  {/if}
</span>

<style>
  .brain-icon {
    position: relative;
    display: inline-flex;
    width: var(--icon-size);
    height: var(--icon-size);
    align-items: center;
    justify-content: center;
    color: currentColor;
  }

  .auto-icon-wrapper {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 100%;
  }

  .auto-loop {
    position: absolute;
    inset: -2px;
    width: calc(100% + 4px);
    height: calc(100% + 4px);
    animation: spin 10s linear infinite;
    opacity: 0.8;
  }

  .tier-glyph {
    display: block;
    flex: 0 0 auto;
  }

  @keyframes spin {
    from {
      transform: rotate(0deg);
    }
    to {
      transform: rotate(360deg);
    }
  }
</style>
