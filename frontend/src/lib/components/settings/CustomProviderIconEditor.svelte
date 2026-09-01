<script lang="ts">
  import { onDestroy, onMount, tick } from 'svelte';
  import AlertCircle from 'lucide-svelte/icons/alert-circle';
  import Circle from 'lucide-svelte/icons/circle';
  import ImagePlus from 'lucide-svelte/icons/image-plus';
  import LoaderCircle from 'lucide-svelte/icons/loader-circle';
  import Minus from 'lucide-svelte/icons/minus';
  import Plus from 'lucide-svelte/icons/plus';
  import RefreshCw from 'lucide-svelte/icons/refresh-cw';
  import RotateCcw from 'lucide-svelte/icons/rotate-ccw';
  import Square from 'lucide-svelte/icons/square';
  import Trash2 from 'lucide-svelte/icons/trash-2';
  import KorySlider from '../KorySlider.svelte';
  import {
    CUSTOM_PROVIDER_ICON_MAX_ZOOM,
    CUSTOM_PROVIDER_ICON_MIN_ZOOM,
    CUSTOM_PROVIDER_ICON_MIME_TYPES,
    CUSTOM_PROVIDER_ICON_OUTPUT_SIZE,
    CUSTOM_PROVIDER_ICON_VIEWPORT_SIZE,
    CUSTOM_PROVIDER_ICON_ZOOM_STEP,
    clampIconZoomPercent,
    computeIconCropSourceRect,
    computeIconCropTransform,
    validateCustomProviderIconDimensions,
    validateCustomProviderIconFile,
    type CustomProviderIconSelection,
    type CustomProviderIconShape,
  } from './custom-provider-icon';

  interface Props {
    id?: string;
    existingIconUrl?: string | null;
    initialShape?: CustomProviderIconShape;
    disabled?: boolean;
    focusOnMount?: boolean;
    onchange?: (selection: CustomProviderIconSelection | null) => unknown | Promise<unknown>;
    onerror?: (message: string) => unknown | Promise<unknown>;
  }

  let {
    id = 'custom-provider-icon',
    existingIconUrl = null,
    initialShape = 'rounded-square',
    disabled = false,
    focusOnMount = false,
    onchange,
    onerror,
  }: Props = $props();

  const accept = CUSTOM_PROVIDER_ICON_MIME_TYPES.join(',');

  let fileInput = $state<HTMLInputElement>();
  let cropViewport = $state<HTMLButtonElement>();
  let chooseImageButton = $state<HTMLButtonElement>();
  let sourceImage = $state.raw<HTMLImageElement | null>(null);
  let outputBlob = $state.raw<Blob | null>(null);
  let sourceObjectUrl = $state('');
  let selectedShape = $state<CustomProviderIconShape | null>(null);
  let zoomPercent = $state(CUSTOM_PROVIDER_ICON_MIN_ZOOM);
  let panX = $state(0);
  let panY = $state(0);
  let loading = $state(false);
  let errorMessage = $state('');
  let existingImageFailed = $state(false);
  let removed = $state(false);
  let draggingPointerId = $state<number | null>(null);
  let lastPointerX = 0;
  let lastPointerY = 0;
  let renderTimer: ReturnType<typeof setTimeout> | undefined;
  let renderGeneration = 0;

  let hasExistingImage = $derived(Boolean(existingIconUrl && !removed && !existingImageFailed));
  let hasAnyImage = $derived(Boolean(sourceImage || hasExistingImage));
  let shape = $derived(selectedShape ?? initialShape);
  let isDefaultFraming = $derived(
    zoomPercent === CUSTOM_PROVIDER_ICON_MIN_ZOOM && panX === 0 && panY === 0,
  );
  let cropTransform = $derived.by(() =>
    sourceImage
      ? computeIconCropTransform(
          sourceImage.naturalWidth,
          sourceImage.naturalHeight,
          CUSTOM_PROVIDER_ICON_VIEWPORT_SIZE,
          zoomPercent,
          panX,
          panY,
        )
      : null,
  );
  let cropRadiusClass = $derived(shape === 'circle' ? 'rounded-full' : 'rounded-[26%]');

  onDestroy(() => {
    clearScheduledRender();
    renderGeneration += 1;
    if (sourceObjectUrl) URL.revokeObjectURL(sourceObjectUrl);
  });

  onMount(() => {
    if (focusOnMount) void tick().then(() => chooseImageButton?.focus());
  });

  function reportError(message: string): void {
    errorMessage = message;
    try {
      const result = onerror?.(message);
      if (result instanceof Promise) void result.catch(() => undefined);
    } catch {
      // The editor owns its visible validation state. Parent callbacks should
      // not make a recoverable image-selection error fatal to the component.
    }
  }

  function emitSelection(selection: CustomProviderIconSelection | null): void {
    try {
      const result = onchange?.(selection);
      if (result instanceof Promise) void result.catch(() => undefined);
    } catch {
      // Persistence errors belong to the integrating settings view.
    }
  }

  function clearScheduledRender(): void {
    if (renderTimer !== undefined) {
      clearTimeout(renderTimer);
      renderTimer = undefined;
    }
  }

  function cleanupLocalSource(): void {
    clearScheduledRender();
    renderGeneration += 1;
    sourceImage = null;
    outputBlob = null;
    if (sourceObjectUrl) URL.revokeObjectURL(sourceObjectUrl);
    sourceObjectUrl = '';
  }

  function decodeImage(url: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.decoding = 'async';
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('Image decode failed'));
      image.src = url;
    });
  }

  async function chooseFile(file: File): Promise<void> {
    const validationError = validateCustomProviderIconFile(file);
    if (validationError) {
      reportError(validationError);
      return;
    }

    loading = true;
    errorMessage = '';
    const candidateUrl = URL.createObjectURL(file);
    try {
      const candidateImage = await decodeImage(candidateUrl);
      const dimensionError = validateCustomProviderIconDimensions(
        candidateImage.naturalWidth,
        candidateImage.naturalHeight,
      );
      if (dimensionError) {
        URL.revokeObjectURL(candidateUrl);
        reportError(dimensionError);
        return;
      }

      cleanupLocalSource();
      sourceObjectUrl = candidateUrl;
      sourceImage = candidateImage;
      removed = false;
      existingImageFailed = false;
      zoomPercent = CUSTOM_PROVIDER_ICON_MIN_ZOOM;
      panX = 0;
      panY = 0;
      scheduleOutputRender(0);
    } catch {
      URL.revokeObjectURL(candidateUrl);
      reportError('That image could not be decoded. Choose another PNG, JPEG, or WebP file.');
    } finally {
      loading = false;
    }
  }

  function handleFileChange(event: Event): void {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (file) void chooseFile(file);
  }

  function openFilePicker(): void {
    if (!disabled && !loading) fileInput?.click();
  }

  function clampPan(nextX = panX, nextY = panY): void {
    if (!sourceImage) return;
    const transform = computeIconCropTransform(
      sourceImage.naturalWidth,
      sourceImage.naturalHeight,
      CUSTOM_PROVIDER_ICON_VIEWPORT_SIZE,
      zoomPercent,
      nextX,
      nextY,
    );
    panX = transform.panX;
    panY = transform.panY;
  }

  function setZoom(next: number): void {
    if (!sourceImage || disabled) return;
    const clamped = clampIconZoomPercent(next);
    if (clamped === zoomPercent) return;
    zoomPercent = clamped;
    clampPan();
    scheduleOutputRender();
  }

  function movePan(deltaX: number, deltaY: number, renderImmediately = false): void {
    if (!sourceImage || disabled) return;
    clampPan(panX + deltaX, panY + deltaY);
    scheduleOutputRender(renderImmediately ? 0 : 90);
  }

  function resetFraming(): void {
    if (!sourceImage || disabled) return;
    zoomPercent = CUSTOM_PROVIDER_ICON_MIN_ZOOM;
    panX = 0;
    panY = 0;
    scheduleOutputRender(0);
    cropViewport?.focus();
  }

  function setShape(next: CustomProviderIconShape): void {
    if (disabled || next === shape) return;
    selectedShape = next;
    if (!hasAnyImage) return;
    if (sourceImage && !outputBlob) scheduleOutputRender(0);
    else emitSelection({ blob: outputBlob, shape });
  }

  function removeIcon(): void {
    if (disabled || !hasAnyImage) return;
    cleanupLocalSource();
    removed = true;
    errorMessage = '';
    zoomPercent = CUSTOM_PROVIDER_ICON_MIN_ZOOM;
    panX = 0;
    panY = 0;
    emitSelection(null);
  }

  function scheduleOutputRender(delay = 90): void {
    if (!sourceImage) return;
    clearScheduledRender();
    const generation = ++renderGeneration;
    renderTimer = setTimeout(() => {
      renderTimer = undefined;
      void renderOutput(generation);
    }, delay);
  }

  async function renderOutput(generation: number): Promise<void> {
    const image = sourceImage;
    if (!image || generation !== renderGeneration) return;
    const sourceRect = computeIconCropSourceRect(
      image.naturalWidth,
      image.naturalHeight,
      CUSTOM_PROVIDER_ICON_VIEWPORT_SIZE,
      zoomPercent,
      panX,
      panY,
    );
    const canvas = document.createElement('canvas');
    canvas.width = CUSTOM_PROVIDER_ICON_OUTPUT_SIZE;
    canvas.height = CUSTOM_PROVIDER_ICON_OUTPUT_SIZE;
    const context = canvas.getContext('2d');
    if (!context) {
      reportError('Koryphaios could not prepare this icon in the current window.');
      return;
    }
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(
      image,
      sourceRect.x,
      sourceRect.y,
      sourceRect.width,
      sourceRect.height,
      0,
      0,
      CUSTOM_PROVIDER_ICON_OUTPUT_SIZE,
      CUSTOM_PROVIDER_ICON_OUTPUT_SIZE,
    );

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, 'image/png');
    });
    if (generation !== renderGeneration || image !== sourceImage) return;
    if (!blob) {
      reportError('Koryphaios could not encode this icon. Try another image.');
      return;
    }
    outputBlob = blob;
    errorMessage = '';
    emitSelection({ blob, shape });
  }

  function handlePointerDown(event: PointerEvent): void {
    if (!sourceImage || disabled || !cropViewport) return;
    event.preventDefault();
    cropViewport.focus();
    draggingPointerId = event.pointerId;
    lastPointerX = event.clientX;
    lastPointerY = event.clientY;
    cropViewport.setPointerCapture(event.pointerId);
  }

  function handlePointerMove(event: PointerEvent): void {
    if (event.pointerId !== draggingPointerId) return;
    const deltaX = event.clientX - lastPointerX;
    const deltaY = event.clientY - lastPointerY;
    lastPointerX = event.clientX;
    lastPointerY = event.clientY;
    movePan(deltaX, deltaY);
  }

  function finishPointer(event: PointerEvent): void {
    if (event.pointerId !== draggingPointerId || !cropViewport) return;
    if (cropViewport.hasPointerCapture(event.pointerId)) {
      cropViewport.releasePointerCapture(event.pointerId);
    }
    draggingPointerId = null;
    scheduleOutputRender(0);
  }

  function cancelPointer(event: PointerEvent): void {
    if (event.pointerId !== draggingPointerId || !cropViewport) return;
    if (cropViewport.hasPointerCapture(event.pointerId)) {
      cropViewport.releasePointerCapture(event.pointerId);
    }
    draggingPointerId = null;
  }

  function handleCropKeydown(event: KeyboardEvent): void {
    if (!sourceImage || disabled) return;
    const panStep = event.shiftKey ? 24 : 8;
    let handled = true;
    if (event.key === 'ArrowLeft') movePan(-panStep, 0, true);
    else if (event.key === 'ArrowRight') movePan(panStep, 0, true);
    else if (event.key === 'ArrowUp') movePan(0, -panStep, true);
    else if (event.key === 'ArrowDown') movePan(0, panStep, true);
    else if (event.key === '+' || event.key === '=') {
      setZoom(zoomPercent + CUSTOM_PROVIDER_ICON_ZOOM_STEP);
    } else if (event.key === '-' || event.key === '_') {
      setZoom(zoomPercent - CUSTOM_PROVIDER_ICON_ZOOM_STEP);
    } else if (event.key === 'Home') resetFraming();
    else handled = false;

    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  }
</script>

<section
  class="space-y-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-2 sm:p-4"
  aria-labelledby={`${id}-heading`}
>
  <div class="flex items-start justify-between gap-4">
    <div class="min-w-0">
      <h4 id={`${id}-heading`} class="text-sm font-semibold text-[var(--color-text-primary)]">
        Custom icon
      </h4>
      <p class="mt-1 text-xs leading-relaxed text-[var(--color-text-muted)]">
        PNG, JPEG, or WebP up to 5 MiB. Koryphaios saves a private 256 × 256 PNG.
      </p>
    </div>
    {#if hasAnyImage && !loading}
      <span
        class="shrink-0 rounded-full border border-[var(--color-border)] bg-[var(--color-surface-3)] px-2.5 py-1 text-[10px] font-medium text-[var(--color-text-secondary)]"
      >
        256 × 256
      </span>
    {/if}
  </div>

  <div class="flex justify-center py-1">
    <button
      bind:this={cropViewport}
      type="button"
      disabled={!sourceImage || disabled}
      aria-label="Reposition custom provider icon"
      aria-describedby={`${id}-crop-help`}
      aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown + - Home"
      class="relative h-[184px] w-[184px] touch-none overflow-hidden border-2 border-[var(--color-border-bright)] bg-[var(--color-surface-3)] p-0 outline-none transition-[border-radius,box-shadow] focus-visible:border-[var(--color-accent)] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/45 disabled:opacity-100 {cropRadiusClass} {sourceImage &&
      !disabled
        ? draggingPointerId === null
          ? 'cursor-grab'
          : 'cursor-grabbing'
        : ''}"
      onkeydown={handleCropKeydown}
      onpointerdown={handlePointerDown}
      onpointermove={handlePointerMove}
      onpointerup={finishPointer}
      onpointercancel={cancelPointer}
    >
      {#if sourceImage && cropTransform}
        <img
          src={sourceObjectUrl}
          alt=""
          draggable="false"
          class="pointer-events-none absolute max-w-none select-none"
          style={`left: calc(50% + ${cropTransform.panX}px); top: calc(50% + ${cropTransform.panY}px); width: ${cropTransform.displayWidth}px; height: ${cropTransform.displayHeight}px; transform: translate(-50%, -50%);`}
        />
        <span
          class="pointer-events-none absolute inset-0 border border-[var(--color-border-bright)] {cropRadiusClass}"
          aria-hidden="true"
        ></span>
      {:else if hasExistingImage}
        <img
          src={existingIconUrl ?? ''}
          alt="Current custom provider icon"
          class="h-full w-full object-cover"
          onerror={() => (existingImageFailed = true)}
        />
      {:else}
        <div
          class="flex h-full w-full flex-col items-center justify-center gap-2 px-5 text-center text-[var(--color-text-muted)]"
        >
          {#if loading}
            <LoaderCircle size={28} class="animate-spin text-[var(--color-accent)]" />
            <span class="text-xs">Preparing image…</span>
          {:else}
            <ImagePlus size={28} />
            <span class="text-xs leading-relaxed">Choose an image to frame your icon</span>
          {/if}
        </div>
      {/if}
    </button>
  </div>

  <p
    id={`${id}-crop-help`}
    class="text-center text-[11px] leading-relaxed text-[var(--color-text-muted)]"
  >
    {#if sourceImage}
      Drag to reposition. Arrow keys move precisely; + and − zoom; Home resets.
    {:else if hasExistingImage}
      Replace the image to change its crop or zoom.
    {:else}
      Your image stays local until you save the provider.
    {/if}
  </p>

  <div class="grid grid-cols-[2.25rem_minmax(0,1fr)_2.25rem] items-center gap-2">
    <button
      type="button"
      class="flex h-9 w-9 items-center justify-center rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-1)] text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-accent)]/50 hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/60 disabled:cursor-not-allowed disabled:opacity-40"
      disabled={!sourceImage || disabled || zoomPercent <= CUSTOM_PROVIDER_ICON_MIN_ZOOM}
      onclick={() => setZoom(zoomPercent - CUSTOM_PROVIDER_ICON_ZOOM_STEP)}
      aria-label="Zoom icon out"
    >
      <Minus size={15} />
    </button>
    <KorySlider
      id={`${id}-zoom`}
      label="Zoom"
      value={zoomPercent}
      min={CUSTOM_PROVIDER_ICON_MIN_ZOOM}
      max={CUSTOM_PROVIDER_ICON_MAX_ZOOM}
      step={CUSTOM_PROVIDER_ICON_ZOOM_STEP}
      unit="%"
      valueText={`${zoomPercent} percent zoom`}
      description="Choose how much of the source image fills the icon."
      disabled={!sourceImage || disabled}
      onchange={setZoom}
    />
    <button
      type="button"
      class="flex h-9 w-9 items-center justify-center rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-1)] text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-accent)]/50 hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/60 disabled:cursor-not-allowed disabled:opacity-40"
      disabled={!sourceImage || disabled || zoomPercent >= CUSTOM_PROVIDER_ICON_MAX_ZOOM}
      onclick={() => setZoom(zoomPercent + CUSTOM_PROVIDER_ICON_ZOOM_STEP)}
      aria-label="Zoom icon in"
    >
      <Plus size={15} />
    </button>
  </div>

  <fieldset class="space-y-2" {disabled}>
    <legend class="text-xs font-medium text-[var(--color-text-primary)]">Icon shape</legend>
    <div
      class="grid grid-cols-2 gap-1 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-1)] p-1"
    >
      <button
        type="button"
        aria-pressed={shape === 'rounded-square'}
        class="flex min-h-9 items-center justify-center gap-2 rounded-lg px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/60 {shape ===
        'rounded-square'
          ? 'bg-[var(--color-accent)] text-[var(--color-on-accent)] shadow-sm'
          : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-3)] hover:text-[var(--color-text-primary)]'}"
        onclick={() => setShape('rounded-square')}
      >
        <Square size={14} />
        Rounded square
      </button>
      <button
        type="button"
        aria-pressed={shape === 'circle'}
        class="flex min-h-9 items-center justify-center gap-2 rounded-lg px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/60 {shape ===
        'circle'
          ? 'bg-[var(--color-accent)] text-[var(--color-on-accent)] shadow-sm'
          : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-3)] hover:text-[var(--color-text-primary)]'}"
        onclick={() => setShape('circle')}
      >
        <Circle size={14} />
        Circle
      </button>
    </div>
  </fieldset>

  <input
    bind:this={fileInput}
    class="sr-only"
    type="file"
    {accept}
    tabindex="-1"
    aria-hidden="true"
    disabled={disabled || loading}
    onchange={handleFileChange}
  />

  <div class="flex flex-wrap gap-2">
    <button
      bind:this={chooseImageButton}
      type="button"
      class="inline-flex min-h-9 items-center gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-1)] px-3 text-xs font-medium text-[var(--color-text-primary)] transition-colors hover:border-[var(--color-accent)]/50 hover:bg-[var(--color-surface-3)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/60 disabled:cursor-not-allowed disabled:opacity-50"
      disabled={disabled || loading}
      onclick={openFilePicker}
    >
      {#if loading}
        <LoaderCircle size={14} class="animate-spin" />
        Preparing…
      {:else if hasAnyImage}
        <RefreshCw size={14} />
        Replace
      {:else}
        <ImagePlus size={14} />
        Choose image
      {/if}
    </button>
    <button
      type="button"
      class="inline-flex min-h-9 items-center gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-1)] px-3 text-xs font-medium text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-accent)]/50 hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/60 disabled:cursor-not-allowed disabled:opacity-40"
      disabled={!sourceImage || disabled || isDefaultFraming}
      onclick={resetFraming}
    >
      <RotateCcw size={14} />
      Reset framing
    </button>
    <button
      type="button"
      class="inline-flex min-h-9 items-center gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-1)] px-3 text-xs font-medium text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-error)]/60 hover:bg-[var(--color-error-bg)] hover:text-[var(--color-error)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-error)]/50 disabled:cursor-not-allowed disabled:opacity-40"
      disabled={!hasAnyImage || disabled}
      onclick={removeIcon}
    >
      <Trash2 size={14} />
      Remove
    </button>
  </div>

  {#if errorMessage}
    <div
      role="alert"
      class="flex items-start gap-2 rounded-xl border border-[var(--color-error)]/40 bg-[var(--color-error-bg)] px-3 py-2.5 text-xs leading-relaxed text-[var(--color-error)]"
    >
      <AlertCircle size={14} class="mt-0.5 shrink-0" />
      <span>{errorMessage}</span>
    </div>
  {:else if sourceImage && outputBlob}
    <p
      aria-live="polite"
      class="flex items-center gap-2 text-[11px] text-[var(--color-text-muted)]"
    >
      <ImagePlus size={13} class="text-[var(--color-success)]" />
      Icon is framed and ready to save.
    </p>
  {/if}
</section>
