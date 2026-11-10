<script lang="ts">
  import type { WelcomeBackground as WelcomeBackgroundSettings } from '@koryphaios/shared';
  import {
    welcomeTextColorForPixels,
    type WelcomeTextColor,
  } from '$lib/utils/welcome-background-contrast';

  let {
    background,
    baseSurface = 'surface-0',
    contrastOpacity = 1,
    onTextColor,
  }: {
    background?: WelcomeBackgroundSettings;
    baseSurface?: 'surface-0' | 'surface-1';
    /** Additional image contribution from an overlay applied above the image. */
    contrastOpacity?: number;
    onTextColor?: (color: WelcomeTextColor | undefined) => void;
  } = $props();

  let imageElement = $state<HTMLImageElement>();

  function positionFraction(value: string, start: string, end: string): number {
    if (value === start) return 0;
    if (value === end) return 1;
    const percentage = /^(\d+(?:\.\d+)?)%$/.exec(value);
    return percentage ? Math.max(0, Math.min(1, Number(percentage[1]) / 100)) : 0.5;
  }

  function measureBackground() {
    if (!background?.source || !imageElement?.naturalWidth || !imageElement.naturalHeight) return;

    const renderedWidth = imageElement.clientWidth || imageElement.naturalWidth;
    const renderedHeight = imageElement.clientHeight || imageElement.naturalHeight;
    const scale = 32 / Math.max(renderedWidth, renderedHeight);
    const sampleWidth = Math.max(1, Math.round(renderedWidth * scale));
    const sampleHeight = Math.max(1, Math.round(renderedHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = sampleWidth;
    canvas.height = sampleHeight;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return;

    try {
      const surfaceColor = getComputedStyle(document.documentElement)
        .getPropertyValue(`--color-${baseSurface}`)
        .trim();
      if (!/^#[\da-f]{6}$/i.test(surfaceColor)) {
        onTextColor?.(undefined);
        return;
      }

      // Paint the real base surface first so image alpha and the preview's
      // overlay are reflected in the same composite that the user sees.
      context.fillStyle = surfaceColor;
      context.fillRect(0, 0, sampleWidth, sampleHeight);
      context.globalAlpha = Math.max(0, Math.min(1, background.opacity * contrastOpacity));

      const imageWidth = imageElement.naturalWidth;
      const imageHeight = imageElement.naturalHeight;
      const imageRatio = imageWidth / imageHeight;
      const sampleRatio = sampleWidth / sampleHeight;
      const positions = background.position.toLowerCase().split(/\s+/);
      let horizontal = 'center';
      let vertical = 'center';
      for (const part of positions) {
        if (part === 'left' || part === 'right') horizontal = part;
        else if (part === 'top' || part === 'bottom') vertical = part;
      }

      if (background.fit === 'cover') {
        if (imageRatio > sampleRatio) {
          const cropWidth = imageHeight * sampleRatio;
          const sourceX = (imageWidth - cropWidth) * positionFraction(horizontal, 'left', 'right');
          context.drawImage(imageElement, sourceX, 0, cropWidth, imageHeight, 0, 0, sampleWidth, sampleHeight);
        } else {
          const cropHeight = imageWidth / sampleRatio;
          const sourceY = (imageHeight - cropHeight) * positionFraction(vertical, 'top', 'bottom');
          context.drawImage(imageElement, 0, sourceY, imageWidth, cropHeight, 0, 0, sampleWidth, sampleHeight);
        }
      } else if (background.fit === 'contain') {
        const fitScale = Math.min(sampleWidth / imageWidth, sampleHeight / imageHeight);
        const drawWidth = imageWidth * fitScale;
        const drawHeight = imageHeight * fitScale;
        const drawX = (sampleWidth - drawWidth) * positionFraction(horizontal, 'left', 'right');
        const drawY = (sampleHeight - drawHeight) * positionFraction(vertical, 'top', 'bottom');
        context.drawImage(imageElement, drawX, drawY, drawWidth, drawHeight);
      } else {
        context.drawImage(imageElement, 0, 0, sampleWidth, sampleHeight);
      }

      context.globalAlpha = 1;
      const pixels = context.getImageData(0, 0, sampleWidth, sampleHeight).data;
      onTextColor?.(welcomeTextColorForPixels(pixels, 1, surfaceColor));
    } catch {
      // If the browser cannot sample the image, leave the normal theme colors.
      onTextColor?.(undefined);
    }
  }

  $effect(() => {
    if (typeof document === 'undefined') return;
    const observer = new MutationObserver(measureBackground);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  });

  $effect(() => {
    const source = background?.source;
    const opacity = background?.opacity;
    const fit = background?.fit;
    const position = background?.position;
    const layerOpacity = contrastOpacity;
    const surface = baseSurface;

    if (!source) {
      onTextColor?.(undefined);
      return;
    }
    if (imageElement?.complete && imageElement.naturalWidth > 0) {
      queueMicrotask(measureBackground);
    }
    void opacity;
    void fit;
    void position;
    void layerOpacity;
    void surface;

    if (typeof ResizeObserver !== 'undefined' && imageElement) {
      const observer = new ResizeObserver(measureBackground);
      observer.observe(imageElement);
      return () => observer.disconnect();
    }
  });
</script>

{#if background?.source}
  <img bind:this={imageElement} class="welcome-background" src={background.source} alt=""
    style:object-fit={background.fit} style:object-position={background.position}
    style:opacity={background.opacity} onload={measureBackground} />
{/if}

<style>
  .welcome-background { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
</style>
