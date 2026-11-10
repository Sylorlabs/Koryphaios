<script lang="ts">
  /**
   * Live microphone waveform, drawn the way a dictation field draws it: a row of
   * mirrored bars around a centre line, newest sample at the right, older
   * samples fading out to the left.
   *
   * It renders only what the tap measured. With no analyser it draws the quiet
   * idle row rather than inventing motion, so a provider that owns the
   * microphone itself (system speech recognition) never shows fake levels.
   */
  interface Props {
    /** Live tap from the recording graph. Null renders the idle row. */
    analyser?: AnalyserNode | null;
    /** Mirrored bars across the strip. */
    bars?: number;
    /** Dim the strip while it is not the active focus of the recording. */
    active?: boolean;
    class?: string;
  }

  let { analyser = null, bars = 0, active = true, class: className = '' }: Props = $props();

  let canvas = $state<HTMLCanvasElement | null>(null);
  let host = $state<HTMLDivElement | null>(null);

  // Samples kept for the left-hand fade. At one sample per animation frame this
  // is a couple of seconds of history.
  const HISTORY = 1024;
  const BAR_WIDTH = 2;
  const BAR_GAP = 2;
  const MIN_HALF_HEIGHT = 1;

  // Keep the drawing loop alive while props change from recording to
  // transcribing. Re-running the canvas effect on that transition would create
  // a new empty history and replace the final audio frame with the idle row.
  let liveAnalyser: AnalyserNode | null = null;
  let liveActive = true;

  $effect(() => {
    const nextAnalyser = analyser;
    const nextActive = active;
    liveAnalyser = nextAnalyser;
    liveActive = nextActive;
  });

  $effect(() => {
    const element = canvas;
    if (!element) return;
    // Bound once, so the closures below do not re-check a $state proxy on every
    // animation frame.
    const surface: HTMLCanvasElement = element;
    const container = host;
    const ctx = surface.getContext('2d');
    if (!ctx) return;

    let width = 0;
    let height = 0;
    let resizeFrame = 0;

    function resize() {
      const measuredWidth = container?.clientWidth ?? 0;
      const measuredHeight = container?.clientHeight ?? 0;
      // Keep even a broken/oversized layout below WebKit's canvas limits.
      width = Number.isFinite(measuredWidth) ? Math.max(0, Math.min(measuredWidth, 4096)) : 0;
      height = Number.isFinite(measuredHeight) ? Math.max(0, Math.min(measuredHeight, 256)) : 0;
      const ratio = globalThis.devicePixelRatio;
      const dpr = Number.isFinite(ratio) && ratio > 0 ? Math.min(ratio, 2) : 1;
      const pixelWidth = Math.max(1, Math.floor(width * dpr));
      const pixelHeight = Math.max(1, Math.floor(height * dpr));
      // Setting either dimension clears the canvas. Avoid reallocating an
      // unchanged buffer on duplicate observer deliveries.
      if (surface.width !== pixelWidth) surface.width = pixelWidth;
      if (surface.height !== pixelHeight) surface.height = pixelHeight;
      ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function scheduleResize() {
      if (resizeFrame) return;
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = 0;
        resize();
      });
    }

    const observer =
      typeof ResizeObserver === 'undefined' || !container
        ? null
        : new ResizeObserver(scheduleResize);
    observer?.observe(container!);
    resize();

    const styles = getComputedStyle(element);
    const token = (name: string, fallback: string) =>
      styles.getPropertyValue(name).trim() || fallback;
    const accent = token('--color-accent', '#d5b261');
    const muted = token('--color-text-muted', 'rgba(255,255,255,0.35)');

    const history = new Float32Array(HISTORY);
    let filled = 0;
    let smoothed = 0;
    let buffer: Uint8Array<ArrayBuffer> | null = null;
    let cancelled = false;

    const reducedMotion =
      globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

    function measureLevel(): number {
      if (!liveAnalyser) return 0;
      if (!buffer || buffer.length !== liveAnalyser.fftSize) {
        buffer = new Uint8Array(new ArrayBuffer(liveAnalyser.fftSize));
      }
      liveAnalyser.getByteTimeDomainData(buffer);
      let sum = 0;
      for (let index = 0; index < buffer.length; index += 1) {
        const sample = (buffer[index] - 128) / 128;
        sum += sample * sample;
      }
      // Speech sits well below full scale, so the RMS is expanded and clamped
      // rather than leaving every bar pinned at the minimum.
       return Math.min(1, Math.sqrt(sum / buffer.length) * 6);
    }

    function draw() {
      if (!ctx || width <= 0 || height <= 0) return;
      ctx.clearRect(0, 0, width, height);
      const centerY = height / 2;
      const maxHalf = Math.max(MIN_HALF_HEIGHT, centerY - 2);
      const slot = BAR_WIDTH + BAR_GAP;
      const count = Math.max(1, Math.min(bars || HISTORY, Math.floor(width / slot)));

      for (let index = 0; index < count; index += 1) {
        // Oldest sample sits at the left edge, newest at the right.
        const sampleIndex = filled - count + index;
        const level = sampleIndex >= 0 ? history[sampleIndex % HISTORY] : 0;
        const age = count <= 1 ? 1 : index / (count - 1);
        const barHeight = Math.max(MIN_HALF_HEIGHT * 2, level * maxHalf);
        const x = index * slot + (width - count * slot + BAR_GAP) / 2;
        ctx.globalAlpha = (active ? 0.28 : 0.14) + age * (active ? 0.72 : 0.32);
        ctx.fillStyle = level > 0.02 ? accent : muted;
        ctx.beginPath();
        ctx.roundRect(x, centerY - barHeight, BAR_WIDTH, barHeight * 2, BAR_WIDTH / 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    let raf = 0;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    function tick() {
      if (cancelled) return;
      // Once speech ends, keep the last measured waveform on screen while the
      // recording is being transcribed. Do not append empty samples or schedule
      // another frame, otherwise the finished clip appears to keep moving.
       if (!liveActive) {
        draw();
        return;
      }
      const level = measureLevel();
      // Fast attack, slow release, so a syllable reads as a spike and the gap
      // between words decays instead of snapping to the idle row.
      smoothed = level > smoothed ? level : smoothed * 0.82 + level * 0.18;
      history[filled % HISTORY] = smoothed;
      filled += 1;
      draw();
      // Reduced motion still reports the live level, just without a scrolling
      // history re-drawn every frame.
      if (reducedMotion) timeout = setTimeout(tick, 90);
      else raf = requestAnimationFrame(tick);
    }

    if (typeof requestAnimationFrame === 'undefined') {
      draw();
    } else {
      raf = requestAnimationFrame(tick);
    }

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      if (resizeFrame) cancelAnimationFrame(resizeFrame);
      if (timeout !== undefined) clearTimeout(timeout);
      observer?.disconnect();
    };
  });
</script>

<div bind:this={host} class="voice-waveform {className}">
  <canvas bind:this={canvas} aria-hidden="true"></canvas>
</div>

<style>
  .voice-waveform {
    position: relative;
    width: 100%;
    height: 2.5rem;
    min-width: 0;
    overflow: hidden;
  }

  canvas {
    /* Backing-store dimensions must never contribute to the host's layout. */
    position: absolute;
    inset: 0;
    display: block;
    width: 100%;
    height: 100%;
  }
</style>
