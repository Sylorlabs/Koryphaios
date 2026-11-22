<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { tooltipAnchorRect } from '$lib/utils/tooltip-anchor';

  let tooltipElement = $state<HTMLDivElement | null>(null);
  let activeTarget: HTMLElement | null = null;
  let originalTitle: string | null = null;
  let text = $state('');
  let visible = $state(false);
  let left = $state(0);
  let top = $state(0);
  let placement = $state<'top' | 'bottom' | 'right' | 'left'>('top');
  /** Horizontal centre of the tail, in tooltip-local pixels. A tail pinned to
   *  the box's own centre reads as a random floating card: when the tooltip is
   *  clamped at a viewport edge it no longer sits over its trigger. Anchoring
   *  the tail to the trigger's centre keeps every callout visibly attached to
   *  the control it came from. */
  let tailX = $state(0);
  /** Vertical centre of the tail for side placements, in tooltip-local pixels. */
  let tailY = $state(0);
  let positionFrame: number | null = null;

  function candidateFrom(target: EventTarget | null): HTMLElement | null {
    if (!(target instanceof Element)) return null;
    return target.closest<HTMLElement>('[title], [data-kory-tooltip]');
  }

  function restoreNativeTitle(): void {
    if (activeTarget && originalTitle !== null && !activeTarget.hasAttribute('title')) {
      activeTarget.setAttribute('title', originalTitle);
    }
    originalTitle = null;
  }

  function hide(): void {
    if (positionFrame !== null) cancelAnimationFrame(positionFrame);
    positionFrame = null;
    restoreNativeTitle();
    activeTarget = null;
    visible = false;
  }

  function schedulePosition(): void {
    if (positionFrame !== null) cancelAnimationFrame(positionFrame);
    positionFrame = requestAnimationFrame(() => {
      positionFrame = null;
      if (!activeTarget || !tooltipElement || !visible) return;

      const tooltipRect = tooltipElement.getBoundingClientRect();
      const viewportPadding = 10;
      const gap = 9;
      // Keep the tail's rotated square inside the rounded corners so it joins
      // the border cleanly instead of clipping against the radius.
      const tailInset = 12;

      // Opt-in side placement for stacked lists (e.g. the settings nav), where
      // a tooltip above the trigger would cover the neighbouring item. Side
      // placements anchor to the element box, not the text, so the callout
      // clears the whole row.
      if (activeTarget.dataset.tooltipPlacement === 'right') {
        const box = activeTarget.getBoundingClientRect();
        const rightCandidate = box.right + gap;
        const fitsRight = rightCandidate + tooltipRect.width <= window.innerWidth - viewportPadding;
        const leftCandidate = box.left - gap - tooltipRect.width;
        if (fitsRight || leftCandidate < viewportPadding) {
          placement = 'right';
          left = Math.min(
            rightCandidate,
            Math.max(viewportPadding, window.innerWidth - tooltipRect.width - viewportPadding),
          );
        } else {
          placement = 'left';
          left = leftCandidate;
        }
        const centeredTop = box.top + box.height / 2 - tooltipRect.height / 2;
        top = Math.min(
          Math.max(centeredTop, viewportPadding),
          Math.max(viewportPadding, window.innerHeight - tooltipRect.height - viewportPadding),
        );
        const targetMiddle = box.top + box.height / 2;
        tailY = Math.min(
          Math.max(targetMiddle - top, tailInset),
          Math.max(tailInset, tooltipRect.height - tailInset),
        );
        return;
      }

      const targetRect = tooltipAnchorRect(activeTarget);
      const centeredLeft = targetRect.left + targetRect.width / 2 - tooltipRect.width / 2;

      left = Math.min(
        Math.max(centeredLeft, viewportPadding),
        Math.max(viewportPadding, window.innerWidth - tooltipRect.width - viewportPadding),
      );

      const topCandidate = targetRect.top - tooltipRect.height - gap;
      if (topCandidate >= viewportPadding) {
        placement = 'top';
        top = topCandidate;
      } else {
        placement = 'bottom';
        top = Math.min(
          targetRect.bottom + gap,
          Math.max(viewportPadding, window.innerHeight - tooltipRect.height - viewportPadding),
        );
      }

      const targetCenter = targetRect.left + targetRect.width / 2;
      tailX = Math.min(
        Math.max(targetCenter - left, tailInset),
        Math.max(tailInset, tooltipRect.width - tailInset),
      );
    });
  }

  async function show(target: HTMLElement): Promise<void> {
    if (activeTarget !== target) {
      restoreNativeTitle();
      activeTarget = target;
      originalTitle = null;
    }

    const nativeTitle = target.getAttribute('title');
    const nextText = (nativeTitle ?? target.dataset.koryTooltip ?? '').trim();
    if (!nextText) return;

    if (nativeTitle !== null) {
      originalTitle = nativeTitle;
      target.dataset.koryTooltip = nativeTitle;
      target.removeAttribute('title');
    }

    text = nextText;
    visible = true;
    await tick();
    schedulePosition();
  }

  onMount(() => {
    const handlePointerOver = (event: PointerEvent) => {
      const target = candidateFrom(event.target);
      if (!target) return;
      void show(target);
    };

    const handlePointerOut = (event: PointerEvent) => {
      if (!activeTarget) return;
      const related = event.relatedTarget;
      if (related instanceof Node && activeTarget.contains(related)) return;
      const relatedTarget = candidateFrom(related);
      if (relatedTarget === activeTarget) return;
      hide();
    };

    const handleFocusIn = (event: FocusEvent) => {
      const target = candidateFrom(event.target);
      if (!target) return;
      void show(target);
    };

    const handleFocusOut = (event: FocusEvent) => {
      if (!activeTarget) return;
      const related = event.relatedTarget;
      if (related instanceof Node && activeTarget.contains(related)) return;
      // Removing a focused element during Svelte's render can synchronously
      // dispatch focusout. Defer reactive writes until that render completes,
      // and do not hide a tooltip acquired by a newer focus event.
      const previousTarget = activeTarget;
      queueMicrotask(() => {
        if (activeTarget === previousTarget) hide();
      });
    };

    const reposition = () => schedulePosition();

    document.addEventListener('pointerover', handlePointerOver, true);
    document.addEventListener('pointerout', handlePointerOut, true);
    document.addEventListener('focusin', handleFocusIn, true);
    document.addEventListener('focusout', handleFocusOut, true);
    window.addEventListener('resize', reposition);
    document.addEventListener('scroll', reposition, true);

    return () => {
      hide();
      document.removeEventListener('pointerover', handlePointerOver, true);
      document.removeEventListener('pointerout', handlePointerOut, true);
      document.removeEventListener('focusin', handleFocusIn, true);
      document.removeEventListener('focusout', handleFocusOut, true);
      window.removeEventListener('resize', reposition);
      document.removeEventListener('scroll', reposition, true);
    };
  });
</script>

{#if visible}
  <div
    bind:this={tooltipElement}
    id="kory-global-tooltip"
    class:below={placement === 'bottom'}
    class:side-right={placement === 'right'}
    class:side-left={placement === 'left'}
    class="kory-global-tooltip"
    role="tooltip"
    data-placement={placement}
    style="left: {left}px; top: {top}px; --tooltip-tail-x: {tailX}px; --tooltip-tail-y: {tailY}px;"
  >
    {text}
  </div>
{/if}

<style>
  .kory-global-tooltip {
    position: fixed;
    z-index: var(--z-tooltip, 700);
    max-width: min(22rem, calc(100vw - 20px));
    padding: 0.48rem 0.65rem;
    border: 1px solid color-mix(in srgb, var(--color-accent) 52%, var(--color-border));
    border-radius: var(--radius-md);
    background: color-mix(in srgb, var(--color-surface-3) 94%, var(--color-accent) 6%);
    box-shadow:
      0 10px 30px color-mix(in srgb, var(--color-surface-0) 72%, transparent),
      0 0 0 1px color-mix(in srgb, var(--color-accent) 12%, transparent);
    color: var(--color-text-primary);
    font-size: var(--text-xs);
    font-weight: 500;
    line-height: 1.35;
    /* Tooltips are newline-joined strings, and without this the newlines
       collapse so a multi-line card renders as one run-on paragraph. */
    white-space: pre-line;
    overflow-wrap: anywhere;
    pointer-events: none;
  }

  .kory-global-tooltip::after {
    content: '';
    position: absolute;
    left: var(--tooltip-tail-x, 50%);
    bottom: -5px;
    width: 8px;
    height: 8px;
    border-right: 1px solid color-mix(in srgb, var(--color-accent) 52%, var(--color-border));
    border-bottom: 1px solid color-mix(in srgb, var(--color-accent) 52%, var(--color-border));
    background: color-mix(in srgb, var(--color-surface-3) 94%, var(--color-accent) 6%);
    transform: translateX(-50%) rotate(45deg);
  }

  .kory-global-tooltip.below::after {
    top: -5px;
    bottom: auto;
    border: 0;
    border-top: 1px solid color-mix(in srgb, var(--color-accent) 52%, var(--color-border));
    border-left: 1px solid color-mix(in srgb, var(--color-accent) 52%, var(--color-border));
  }

  .kory-global-tooltip.side-right::after,
  .kory-global-tooltip.side-left::after {
    top: var(--tooltip-tail-y, 50%);
    bottom: auto;
    border: 0;
    transform: translateY(-50%) rotate(45deg);
  }

  .kory-global-tooltip.side-right::after {
    left: -5px;
    border-bottom: 1px solid color-mix(in srgb, var(--color-accent) 52%, var(--color-border));
    border-left: 1px solid color-mix(in srgb, var(--color-accent) 52%, var(--color-border));
  }

  .kory-global-tooltip.side-left::after {
    left: auto;
    right: -5px;
    border-top: 1px solid color-mix(in srgb, var(--color-accent) 52%, var(--color-border));
    border-right: 1px solid color-mix(in srgb, var(--color-accent) 52%, var(--color-border));
  }
</style>
