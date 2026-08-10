<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { theme, type CustomAccent } from '$lib/stores/theme.svelte';
  import X from 'lucide-svelte/icons/x';
  import Check from 'lucide-svelte/icons/check';
  import Pipette from 'lucide-svelte/icons/pipette';
  import RotateCcw from 'lucide-svelte/icons/rotate-ccw';
  import NumberStepper from './NumberStepper.svelte';

  interface Props {
    open: boolean;
    onClose: () => void;
  }

  let { open, onClose }: Props = $props();

  // ---- Color state (HSV internally, hex as the canonical exchange format) ----
  // Start from the current effective accent so the picker opens on a sensible value.
  let hue = $state(0); // 0..360
  let sat = $state(0); // 0..1
  let val = $state(1); // 0..1
  let hexInput = $state('#D5B261');
  let hoverHex = $state('#F3DDB0');
  let hoverAuto = $state(true); // when true, hover is auto-derived from main

  // Canvas refs
  let wheelCanvas: HTMLCanvasElement | null = $state(null);
  let valueBar: HTMLCanvasElement | null = $state(null);
  let wheelSize = 220;
  let barWidth = 24;
  let barHeight = 220;

  let draggingWheel = false;
  let draggingBar = false;

  // ---- Color math helpers ----
  function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
    const c = v * s;
    const hp = h / 60;
    const x = c * (1 - Math.abs((hp % 2) - 1));
    let r = 0,
      g = 0,
      b = 0;
    if (hp >= 0 && hp < 1) [r, g, b] = [c, x, 0];
    else if (hp < 2) [r, g, b] = [x, c, 0];
    else if (hp < 3) [r, g, b] = [0, c, x];
    else if (hp < 4) [r, g, b] = [0, x, c];
    else if (hp < 5) [r, g, b] = [x, 0, c];
    else if (hp < 6) [r, g, b] = [c, 0, x];
    const m = v - c;
    return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
  }

  function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
    r /= 255;
    g /= 255;
    b /= 255;
    const max = Math.max(r, g, b),
      min = Math.min(r, g, b);
    const d = max - min;
    let h = 0;
    if (d !== 0) {
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
    }
    const s = max === 0 ? 0 : d / max;
    return [h, s, max];
  }

  function rgbToHex(r: number, g: number, b: number): string {
    return (
      '#' +
      [r, g, b]
        .map((n) =>
          Math.max(0, Math.min(255, Math.round(n)))
            .toString(16)
            .padStart(2, '0'),
        )
        .join('')
    ).toUpperCase();
  }

  function hexToRgb(hex: string): [number, number, number] | null {
    const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(hex.trim());
    if (!m) return null;
    let h = m[1];
    if (h.length === 3)
      h = h
        .split('')
        .map((c) => c + c)
        .join('');
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }

  // Relative luminance per WCAG
  function channelLuminance(c: number): number {
    const cs = c / 255;
    return cs <= 0.03928 ? cs / 12.92 : Math.pow((cs + 0.055) / 1.055, 2.4);
  }
  function relativeLuminance(hex: string): number {
    const rgb = hexToRgb(hex);
    if (!rgb) return 0;
    return (
      0.2126 * channelLuminance(rgb[0]) +
      0.7152 * channelLuminance(rgb[1]) +
      0.0722 * channelLuminance(rgb[2])
    );
  }
  function contrastRatio(a: string, b: string): number {
    const la = relativeLuminance(a);
    const lb = relativeLuminance(b);
    const lighter = Math.max(la, lb);
    const darker = Math.min(la, lb);
    return (lighter + 0.05) / (darker + 0.05);
  }

  // Derived current hex from HSV
  let currentHex = $derived.by(() => {
    const [r, g, b] = hsvToRgb(hue, sat, val);
    return rgbToHex(r, g, b);
  });

  // Derived RGB triplet for the readout inputs
  let currentRgb = $derived.by(() => hsvToRgb(hue, sat, val));

  function setRgbChannel(channel: 0 | 1 | 2, nextValue: number) {
    const next: [number, number, number] = [...currentRgb];
    next[channel] = nextValue;
    const [h, s, v] = rgbToHsv(next[0], next[1], next[2]);
    hue = h;
    sat = s;
    val = v;
  }

  // Auto-derive a hover color: lighten the main by mixing toward white.
  function deriveHover(main: string): string {
    const rgb = hexToRgb(main);
    if (!rgb) return main;
    const mixed = rgb.map((c) => Math.round(c + (255 - c) * 0.35)) as [number, number, number];
    return rgbToHex(mixed[0], mixed[1], mixed[2]);
  }

  let effectiveHover = $derived(hoverAuto ? deriveHover(currentHex) : hoverHex);

  // Contrast against current surface background tokens
  let surfaceBg = $derived(
    getComputedStyle(document.documentElement).getPropertyValue('--color-surface-0').trim() ||
      '#0D0B0A',
  );
  let textPrimary = $derived(
    getComputedStyle(document.documentElement).getPropertyValue('--color-text-primary').trim() ||
      '#F6EFE2',
  );
  let contrastOnBg = $derived(contrastRatio(currentHex, surfaceBg).toFixed(2));
  let contrastOnAccent = $derived(contrastRatio(textPrimary, currentHex).toFixed(2));
  let contrastHoverOnBg = $derived(contrastRatio(effectiveHover, surfaceBg).toFixed(2));

  // ---- Canvas drawing ----
  function drawWheel() {
    if (!wheelCanvas) return;
    const ctx = wheelCanvas.getContext('2d');
    if (!ctx) return;
    const size = wheelSize;
    const radius = size / 2;
    const cx = radius,
      cy = radius;
    const imageData = ctx.createImageData(size, size);
    const data = imageData.data;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = x - cx;
        const dy = y - cy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const idx = (y * size + x) * 4;
        if (dist > radius) {
          data[idx + 3] = 0;
          continue;
        }
        let h = (Math.atan2(dy, dx) * 180) / Math.PI;
        if (h < 0) h += 360;
        const s = Math.min(1, dist / radius);
        const [r, g, b] = hsvToRgb(h, s, val);
        data[idx] = r;
        data[idx + 1] = g;
        data[idx + 2] = b;
        data[idx + 3] = 255;
      }
    }
    ctx.putImageData(imageData, 0, 0);
  }

  function drawValueBar() {
    if (!valueBar) return;
    const ctx = valueBar.getContext('2d');
    if (!ctx) return;
    const w = barWidth,
      h = barHeight;
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    // Top = current hue at full value, bottom = black
    const [r, g, b] = hsvToRgb(hue, sat, 1);
    grad.addColorStop(0, `rgb(${r},${g},${b})`);
    grad.addColorStop(1, '#000000');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
  }

  function redrawAll() {
    drawWheel();
    drawValueBar();
  }

  // Pointer position on the wheel -> HSV
  function updateFromWheel(clientX: number, clientY: number) {
    if (!wheelCanvas) return;
    const rect = wheelCanvas.getBoundingClientRect();
    const x = clientX - rect.left - rect.width / 2;
    const y = clientY - rect.top - rect.height / 2;
    const radius = rect.width / 2;
    let dist = Math.sqrt(x * x + y * y);
    dist = Math.min(radius, Math.max(0, dist));
    let h = (Math.atan2(y, x) * 180) / Math.PI;
    if (h < 0) h += 360;
    hue = h;
    sat = dist / radius;
  }

  function updateFromBar(clientY: number) {
    if (!valueBar) return;
    const rect = valueBar.getBoundingClientRect();
    const ratio = 1 - Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));
    val = ratio;
  }

  function handleWheelPointer(e: PointerEvent) {
    draggingWheel = true;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    updateFromWheel(e.clientX, e.clientY);
  }
  function handleBarPointer(e: PointerEvent) {
    draggingBar = true;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    updateFromBar(e.clientY);
  }
  function handlePointerMove(e: PointerEvent) {
    if (draggingWheel) updateFromWheel(e.clientX, e.clientY);
    else if (draggingBar) updateFromBar(e.clientY);
  }
  function handlePointerUp(e: PointerEvent) {
    draggingWheel = false;
    draggingBar = false;
    (e.target as Element).releasePointerCapture?.(e.pointerId);
  }

  // Sync hex input when HSV changes (but only if hex input isn't being typed)
  let typingHex = false;
  let typingHover = false;
  $effect(() => {
    // track currentHex
    currentHex;
    if (!typingHex) hexInput = currentHex;
    if (hoverAuto) hoverHex = deriveHover(currentHex);
  });

  function commitHexInput() {
    const rgb = hexToRgb(hexInput);
    if (rgb) {
      const [h, s, v] = rgbToHsv(rgb[0], rgb[1], rgb[2]);
      hue = h;
      sat = s;
      val = v;
    } else {
      hexInput = currentHex; // reset on invalid
    }
  }
  function commitHoverHex() {
    const rgb = hexToRgb(hoverHex);
    if (!rgb) hoverHex = effectiveHover;
  }

  // Eyedropper (where supported)
  async function pickFromScreen() {
    // @ts-expect-error EyeDropper is not in lib.dom yet
    const EyeDropper = window.EyeDropper;
    if (!EyeDropper) return;
    try {
      const result = await new EyeDropper().open();
      const picked = String(result.sRGBHex).toUpperCase();
      hexInput = picked;
      commitHexInput();
    } catch (err: unknown) {
      console.debug(
        'EyeDropper cancelled or unavailable:',
        err instanceof Error ? err.message : String(err),
      );
      /* user cancelled */
    }
  }

  // Initialize from current accent when opening
  $effect(() => {
    if (!open) return;
    const cur = theme.currentAccent;
    const rgb = hexToRgb(cur.main);
    if (rgb) {
      const [h, s, v] = rgbToHsv(rgb[0], rgb[1], rgb[2]);
      hue = h;
      sat = s;
      val = v;
    }
    hexInput = cur.main.toUpperCase();
    hoverHex = cur.hover.toUpperCase();
    hoverAuto = false; // preserve their existing hover unless they toggle auto
  });

  // Redraw whenever HSV changes
  $effect(() => {
    hue;
    sat;
    val;
    if (open) redrawAll();
  });

  function apply() {
    const custom: CustomAccent = { main: currentHex, hover: effectiveHover };
    theme.setCustomAccent(custom);
    onClose();
  }

  function reset() {
    // Reset the picker to the default gold accent without closing the modal
    const defaultAccent = theme.accents[0]; // gold
    const rgb = hexToRgb(defaultAccent.color);
    if (rgb) {
      const [h, s, v] = rgbToHsv(rgb[0], rgb[1], rgb[2]);
      hue = h;
      sat = s;
      val = v;
    }
    hexInput = defaultAccent.color.toUpperCase();
    hoverAuto = true;
    hoverHex = deriveHover(defaultAccent.color).toUpperCase();
  }

  function handleKey(e: KeyboardEvent) {
    if (e.key === 'Escape') onClose();
  }

  onMount(() => {
    window.addEventListener('keydown', handleKey);
  });
  onDestroy(() => {
    window.removeEventListener('keydown', handleKey);
  });

  // Pointer position indicator on the wheel
  let indicator = $derived.by(() => {
    const radius = wheelSize / 2;
    const dist = sat * radius;
    const rad = (hue * Math.PI) / 180;
    return { x: radius + dist * Math.cos(rad), y: radius + dist * Math.sin(rad) };
  });
  // Value bar indicator
  let barIndicatorY = $derived((1 - val) * barHeight);

  let wheelStyle = `width:${wheelSize}px;height:${wheelSize}px;`;
  let barStyle = `width:${barWidth}px;height:${barHeight}px;`;
</script>

{#if open}
  <div
    class="fixed inset-0 z-[120] flex items-start justify-center pt-[8vh] px-4 backdrop-blur-sm"
    style="background: rgba(0,0,0,0.5);"
    onmousedown={onClose}
    role="presentation"
  >
    <div
      class="w-full max-w-lg rounded-2xl border shadow-2xl overflow-hidden"
      style="background: var(--color-surface-1); border-color: var(--color-border);"
      onmousedown={(e) => e.stopPropagation()}
      role="presentation"
    >
      <!-- Header -->
      <div
        class="flex items-center justify-between px-5 py-4 border-b"
        style="border-color: var(--color-border);"
      >
        <div class="flex items-center gap-2.5">
          <Pipette size={16} style="color: var(--color-accent);" />
          <div>
            <div class="text-sm font-bold" style="color: var(--color-text-primary);">
              Custom Accent Color
            </div>
            <div class="text-[11px]" style="color: var(--color-text-muted);">
              Pick any color with the wheel, hex, or eyedropper
            </div>
          </div>
        </div>
        <button
          class="p-1.5 rounded-lg transition-colors hover:bg-[var(--color-surface-3)]"
          style="color: var(--color-text-muted);"
          onclick={onClose}
          aria-label="Close color picker"
        >
          <X size={16} />
        </button>
      </div>

      <!-- Body -->
      <div class="p-5 space-y-5">
        <!-- Wheel + value bar -->
        <div class="flex gap-4 items-start justify-center">
          <div class="relative" style={wheelStyle}>
            <canvas
              bind:this={wheelCanvas}
              width={wheelSize}
              height={wheelSize}
              class="rounded-full cursor-crosshair touch-none select-none"
              style="display:block;"
              onpointerdown={handleWheelPointer}
              onpointermove={handlePointerMove}
              onpointerup={handlePointerUp}
            ></canvas>
            <!-- Indicator -->
            <div
              class="absolute pointer-events-none rounded-full border-2 border-white shadow-md"
              style="width:14px;height:14px;left:{indicator.x - 7}px;top:{indicator.y -
                7}px;background:{currentHex};box-shadow:0 0 0 1px rgba(0,0,0,0.4);"
            ></div>
          </div>
          <div class="relative" style={barStyle}>
            <canvas
              bind:this={valueBar}
              width={barWidth}
              height={barHeight}
              class="rounded-lg cursor-pointer touch-none select-none"
              style="display:block;"
              onpointerdown={handleBarPointer}
              onpointermove={handlePointerMove}
              onpointerup={handlePointerUp}
            ></canvas>
            <div
              class="absolute pointer-events-none w-full h-1 -translate-y-1/2 rounded-full border border-white shadow"
              style="top:{barIndicatorY}px;background:{currentHex};"
            ></div>
          </div>
        </div>

        <!-- Hex + eyedropper -->
        <div class="flex items-center gap-3">
          <div class="flex-1">
            <label
              for="cp-hex"
              class="block text-[10px] font-bold uppercase tracking-wider mb-1.5"
              style="color: var(--color-text-muted);">Hex</label
            >
            <div class="flex items-center gap-2">
              <input
                type="text"
                id="cp-hex"
                bind:value={hexInput}
                onfocus={() => (typingHex = true)}
                onblur={() => {
                  typingHex = false;
                  commitHexInput();
                }}
                onkeydown={(e) => {
                  if (e.key === 'Enter') {
                    (e.target as HTMLInputElement).blur();
                  }
                }}
                class="flex-1 px-3 py-2 rounded-lg text-sm font-mono border outline-none transition-colors"
                style="background: var(--color-surface-2); border-color: var(--color-border); color: var(--color-text-primary);"
                maxlength="7"
                spellcheck="false"
              />
              <button
                type="button"
                class="p-2 rounded-lg border transition-colors hover:bg-[var(--color-surface-3)]"
                style="background: var(--color-surface-2); border-color: var(--color-border); color: var(--color-text-secondary);"
                onclick={pickFromScreen}
                title="Pick color from screen (eyedropper)"
              >
                <Pipette size={15} />
              </button>
            </div>
          </div>
          <div
            class="w-16 h-16 rounded-xl border shadow-inner"
            style="background:{currentHex};border-color: var(--color-border);"
          ></div>
        </div>

        <!-- RGB readout -->
        <div class="grid grid-cols-3 gap-3">
          <div>
            <div
              class="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]"
            >
              R
            </div>
            <NumberStepper
              compact
              value={currentRgb[0]}
              min={0}
              max={255}
              label="Red channel"
              onchange={(value) => setRgbChannel(0, value)}
            />
          </div>
          <div>
            <div
              class="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]"
            >
              G
            </div>
            <NumberStepper
              compact
              value={currentRgb[1]}
              min={0}
              max={255}
              label="Green channel"
              onchange={(value) => setRgbChannel(1, value)}
            />
          </div>
          <div>
            <div
              class="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]"
            >
              B
            </div>
            <NumberStepper
              compact
              value={currentRgb[2]}
              min={0}
              max={255}
              label="Blue channel"
              onchange={(value) => setRgbChannel(2, value)}
            />
          </div>
        </div>

        <!-- Hover color -->
        <div class="pt-3 border-t" style="border-color: var(--color-border);">
          <div class="flex items-center justify-between mb-2">
            <span
              class="text-[10px] font-bold uppercase tracking-wider"
              style="color: var(--color-text-muted);">Hover Color</span
            >
            <button
              type="button"
              class="text-[10px] px-2 py-1 rounded-md border transition-colors flex items-center gap-1"
              style="background: var(--color-surface-2); border-color: var(--color-border); color: {hoverAuto
                ? 'var(--color-accent)'
                : 'var(--color-text-secondary)'};"
              onclick={() => {
                hoverAuto = !hoverAuto;
                if (hoverAuto) hoverHex = deriveHover(currentHex).toUpperCase();
              }}
              title="Toggle auto-derive from main color"
            >
              {hoverAuto ? 'Auto' : 'Manual'}
            </button>
          </div>
          <div class="flex items-center gap-3">
            <div
              class="w-10 h-10 rounded-lg border shadow-inner shrink-0"
              style="background:{effectiveHover};border-color: var(--color-border);"
            ></div>
            <input
              type="text"
              bind:value={hoverHex}
              onfocus={() => {
                typingHover = true;
                hoverAuto = false;
              }}
              onblur={() => {
                typingHover = false;
                commitHoverHex();
              }}
              onkeydown={(e) => {
                if (e.key === 'Enter') {
                  (e.target as HTMLInputElement).blur();
                }
              }}
              class="flex-1 px-3 py-2 rounded-lg text-sm font-mono border outline-none transition-colors"
              style="background: var(--color-surface-2); border-color: var(--color-border); color: var(--color-text-primary);"
              maxlength="7"
              spellcheck="false"
            />
          </div>
          {#if hoverAuto}
            <p class="text-[10px] mt-1.5" style="color: var(--color-text-muted);">
              Auto-derived from main (+35% toward white). Click the hex field or toggle to Manual to
              customize.
            </p>
          {/if}
        </div>

        <!-- Contrast checker -->
        <div class="pt-3 border-t" style="border-color: var(--color-border);">
          <div
            class="text-[10px] font-bold uppercase tracking-wider mb-2"
            style="color: var(--color-text-muted);"
          >
            Contrast (WCAG)
          </div>
          <div class="grid grid-cols-3 gap-2">
            <div
              class="rounded-lg p-2.5 border"
              style="background: var(--color-surface-2); border-color: var(--color-border);"
            >
              <div class="text-[10px] mb-1" style="color: var(--color-text-muted);">On surface</div>
              <div
                class="text-base font-bold font-mono"
                style="color: {Number(contrastOnBg) >= 4.5
                  ? 'var(--color-success)'
                  : Number(contrastOnBg) >= 3
                    ? 'var(--color-warning)'
                    : 'var(--color-error)'};"
              >
                {contrastOnBg}
              </div>
              <div class="text-[9px] mt-0.5" style="color: var(--color-text-muted);">
                {Number(contrastOnBg) >= 4.5
                  ? 'AAA'
                  : Number(contrastOnBg) >= 3
                    ? 'AA Large'
                    : 'Fail'}
              </div>
            </div>
            <div
              class="rounded-lg p-2.5 border"
              style="background: var(--color-surface-2); border-color: var(--color-border);"
            >
              <div class="text-[10px] mb-1" style="color: var(--color-text-muted);">
                Text on accent
              </div>
              <div
                class="text-base font-bold font-mono"
                style="color: {Number(contrastOnAccent) >= 4.5
                  ? 'var(--color-success)'
                  : Number(contrastOnAccent) >= 3
                    ? 'var(--color-warning)'
                    : 'var(--color-error)'};"
              >
                {contrastOnAccent}
              </div>
              <div class="text-[9px] mt-0.5" style="color: var(--color-text-muted);">
                {Number(contrastOnAccent) >= 4.5
                  ? 'AAA'
                  : Number(contrastOnAccent) >= 3
                    ? 'AA Large'
                    : 'Fail'}
              </div>
            </div>
            <div
              class="rounded-lg p-2.5 border"
              style="background: var(--color-surface-2); border-color: var(--color-border);"
            >
              <div class="text-[10px] mb-1" style="color: var(--color-text-muted);">
                Hover on surf.
              </div>
              <div
                class="text-base font-bold font-mono"
                style="color: {Number(contrastHoverOnBg) >= 4.5
                  ? 'var(--color-success)'
                  : Number(contrastHoverOnBg) >= 3
                    ? 'var(--color-warning)'
                    : 'var(--color-error)'};"
              >
                {contrastHoverOnBg}
              </div>
              <div class="text-[9px] mt-0.5" style="color: var(--color-text-muted);">
                {Number(contrastHoverOnBg) >= 4.5
                  ? 'AAA'
                  : Number(contrastHoverOnBg) >= 3
                    ? 'AA Large'
                    : 'Fail'}
              </div>
            </div>
          </div>
          <!-- Live preview -->
          <div
            class="mt-3 rounded-lg p-3 flex items-center gap-3"
            style="background: var(--color-surface-0);"
          >
            <button
              type="button"
              class="px-3 py-1.5 rounded-lg text-xs font-bold"
              style="background:{currentHex};color:{Number(contrastOnAccent) >= 3
                ? 'var(--color-surface-0)'
                : 'var(--color-text-primary)'};">Primary</button
            >
            <button
              type="button"
              class="px-3 py-1.5 rounded-lg text-xs font-bold"
              style="background:{effectiveHover};color:{Number(contrastHoverOnBg) >= 3
                ? 'var(--color-surface-0)'
                : 'var(--color-text-primary)'};">Hover</button
            >
            <span class="text-xs ml-auto" style="color: var(--color-text-secondary);">Preview</span>
          </div>
        </div>
      </div>

      <!-- Footer -->
      <div
        class="flex items-center justify-between px-5 py-4 border-t"
        style="border-color: var(--color-border);"
      >
        <button
          type="button"
          class="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition-colors hover:bg-[var(--color-surface-3)]"
          style="color: var(--color-text-muted);"
          onclick={reset}
        >
          <RotateCcw size={13} /> Reset to default
        </button>
        <div class="flex items-center gap-2">
          <button
            type="button"
            class="px-4 py-2 rounded-lg text-xs font-medium border transition-colors hover:bg-[var(--color-surface-3)]"
            style="background: var(--color-surface-2); border-color: var(--color-border); color: var(--color-text-secondary);"
            onclick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            class="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-bold transition-transform active:scale-95"
            style="background:{currentHex};color:{Number(contrastOnAccent) >= 3
              ? 'var(--color-surface-0)'
              : 'var(--color-text-primary)'};"
            onclick={apply}
          >
            <Check size={13} strokeWidth={3} /> Apply
          </button>
        </div>
      </div>
    </div>
  </div>
{/if}
