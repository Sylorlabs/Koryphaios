<script lang="ts">
  import {
    resolveProjectIcon,
    automaticProjectIcon,
    segmentGraphemes,
    type ProjectIconSpec,
    type ProjectIdentity,
  } from '@koryphaios/shared';
  import { projectIconAssetUrl } from '$lib/utils/project-icon-assets.svelte';
  import { PROJECT_ICON_COLOR_CSS } from '$lib/utils/project-icon-colors';

  interface Props {
    identity: ProjectIdentity;
    /** Optional server URL for the opaque image asset reference. */
    assetUrl?: string;
    icon?: ProjectIconSpec;
    size?: number;
    status?: 'running' | 'attention' | 'failed' | 'offline' | 'verified';
    class?: string;
    oncontextmenu?: (event: MouseEvent) => void;
  }

  let {
    identity,
    assetUrl = identity.assetUrl ?? '',
    icon: iconSpec,
    size = 32,
    status,
    class: className = '',
    oncontextmenu,
  }: Props = $props();

  const resolvedIcon = $derived(resolveProjectIcon(identity, iconSpec ?? identity.icon));
  const fallbackIcon = $derived(
    resolvedIcon.mode === 'image'
      ? { ...automaticProjectIcon(identity), color: resolvedIcon.color }
      : resolvedIcon,
  );

  const iconColor = $derived(
    PROJECT_ICON_COLOR_CSS[resolvedIcon.color ?? fallbackIcon.color ?? 'accent'],
  );
  const customColor = $derived(resolvedIcon.customColor);
  const isColorTile = $derived(resolvedIcon.mode === 'color');
  const iconShape = $derived(resolvedIcon.shape ?? 'rounded-square');
  // Asset routes require the Bearer token apiFetch adds, so the bytes arrive
  // as a data: URL. Failure is tracked per resolved URL so a new URL retries.
  const resolvedAssetUrl = $derived(
    resolvedIcon.mode === 'image' ? projectIconAssetUrl(assetUrl) : null,
  );
  let failedAssetUrl = $state('');
  const showImage = $derived(
    resolvedIcon.mode === 'image' &&
      Boolean(resolvedAssetUrl) &&
      failedAssetUrl !== resolvedAssetUrl,
  );

  // A monogram may mix letters and emoji ("K", "🚀", "🚀K"). Split the
  // graphemes so both parts can be drawn together instead of as one flat
  // string at text size.
  const iconValue = $derived('value' in fallbackIcon ? (fallbackIcon.value ?? '') : '');
  const iconParts = $derived.by(() => {
    const emoji: string[] = [];
    const text: string[] = [];
    for (const grapheme of segmentGraphemes(iconValue)) {
      if (/\p{Extended_Pictographic}/u.test(grapheme)) emoji.push(grapheme);
      else if (grapheme.trim()) text.push(grapheme);
    }
    return { emoji: emoji.join(''), text: text.join('') };
  });

  function markImageFailed() {
    failedAssetUrl = resolvedAssetUrl ?? '';
  }
</script>

<span
  class={`project-icon project-icon-shape-${iconShape} inline-flex shrink-0 items-center justify-center overflow-hidden font-semibold leading-none ${className}`}
  style={`width: ${size}px; height: ${size}px; ${iconShape === 'transparent' ? '' : isColorTile ? `background: ${customColor ?? iconColor};` : `background: color-mix(in srgb, ${customColor ?? iconColor} 18%, var(--color-surface-3));`} color: ${customColor ?? iconColor};`}
  data-testid="project-icon"
  data-project-id={identity.id}
  data-project-shape={iconShape}
  aria-hidden="true"
  oncontextmenu={oncontextmenu}
>
  {#if isColorTile}
    <!-- Color only: a solid clipped tile, no glyph. -->
  {:else if showImage}
    <img src={resolvedAssetUrl ?? ''} alt="" width={size} height={size} onerror={markImageFailed} />
  {:else if iconParts.emoji && iconParts.text}
    <span class="project-icon-stack" style={`gap: ${Math.max(1, Math.round(size * 0.04))}px;`}>
      <span style={`font-size: ${Math.max(12, Math.round(size * (iconShape === 'transparent' ? 0.6 : 0.46)))}px;`}
        >{iconParts.emoji}</span
      >
      <span style={`font-size: ${Math.max(9, Math.round(size * (iconShape === 'transparent' ? 0.34 : 0.26)))}px;`}
        >{iconParts.text}</span
      >
    </span>
  {:else if iconParts.emoji && !iconParts.text}
    <span style={`font-size: ${Math.max(12, Math.round(size * (iconShape === 'transparent' ? 0.72 : 0.56)))}px;`}
      >{iconParts.emoji}</span
    >
  {:else}
    <span style={`font-size: ${Math.max(11, Math.round(size * (iconShape === 'transparent' ? 0.5 : 0.38)))}px;`}
      >{iconParts.text}</span
    >
  {/if}

  {#if status}
    <span class={`project-icon-status project-icon-status-${status}`} aria-label={status}></span>
  {/if}
</span>

<style>
  .project-icon {
    position: relative;
    box-sizing: border-box;
  }

  .project-icon-shape-circle {
    border-radius: 999px;
  }

  .project-icon-shape-rounded-square {
    border-radius: 24%;
  }

  .project-icon-shape-square {
    border-radius: 0;
  }

  .project-icon-shape-transparent {
    border-radius: 0;
    overflow: visible;
    border: none;
  }

  .project-icon img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .project-icon-shape-transparent img {
    object-fit: contain;
  }

  .project-icon-stack {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    line-height: 1;
  }

  .project-icon-status {
    position: absolute;
    right: 1px;
    bottom: 1px;
    width: 7px;
    height: 7px;
    border: 2px solid var(--color-surface-3);
    border-radius: 999px;
    background: var(--color-text-muted);
  }

  .project-icon-status-running,
  .project-icon-status-verified {
    background: var(--color-success);
  }

  .project-icon-status-attention {
    background: var(--color-warning);
  }

  .project-icon-status-failed {
    background: var(--color-error);
  }

  .project-icon-status-offline {
    background: var(--color-text-muted);
  }
</style>
