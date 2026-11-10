import { cleanup, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import VoiceWaveform from './VoiceWaveform.svelte';

let callback: ResizeObserverCallback;
let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
let disconnect: ReturnType<typeof vi.fn>;

async function flushFrame() {
  const pending = [...frames.values()];
  frames.clear();
  for (const frame of pending) frame(performance.now());
  await tick();
}

function notify() {
  callback([], {} as ResizeObserver);
}

async function setup(props: Record<string, unknown> = {}) {
  const view = render(VoiceWaveform, props);
  await tick();
  const canvas = view.container.querySelector('canvas')!;
  const host = canvas.parentElement!;
  let width = 140;
  let height = 28;
  Object.defineProperty(host, 'clientWidth', { get: () => width });
  Object.defineProperty(host, 'clientHeight', { get: () => height });
  return {
    ...view,
    canvas,
    size(w: number, h: number) {
      width = w;
      height = h;
      notify();
    },
  };
}

describe('VoiceWaveform resize handling', () => {
  beforeEach(() => {
    frames = new Map();
    nextFrame = 0;
    disconnect = vi.fn();
    vi.stubGlobal('devicePixelRatio', 2);
    vi.stubGlobal('requestAnimationFrame', (frame: FrameRequestCallback) => {
      frames.set(++nextFrame, frame);
      return nextFrame;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: ResizeObserverCallback) {
          callback = cb;
        }
        observe() {}
        disconnect = disconnect;
      },
    );
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      setTransform: vi.fn(),
      clearRect: vi.fn(),
      beginPath: vi.fn(),
      roundRect: vi.fn(),
      fill: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('coalesces resize deliveries and commits the latest size outside the observer', async () => {
    const { canvas, size } = await setup();
    const setWidth = vi.spyOn(canvas, 'width', 'set');
    size(140, 28);
    size(180, 28);
    expect(setWidth).not.toHaveBeenCalled();
    expect(frames.size).toBe(2); // drawing + one coalesced resize
    await flushFrame();
    expect(canvas.width).toBe(360);
    expect(canvas.height).toBe(56);
    setWidth.mockClear();
    notify();
    await flushFrame();
    expect(setWidth).not.toHaveBeenCalled();
  });

  it('bounds the backing store even for runaway or invalid layout measurements', async () => {
    const { canvas, size } = await setup();
    size(67108632, 67108632);
    await flushFrame();
    expect(canvas.width).toBe(8192);
    expect(canvas.height).toBe(512);
    expect(canvas.width * canvas.height).toBeLessThan(268435456);
    size(Number.NaN, Number.POSITIVE_INFINITY);
    await flushFrame();
    expect(canvas.width).toBe(1);
    expect(canvas.height).toBe(1);
  });

  it('releases the observer and cancels drawing and pending resize work on unmount', async () => {
    const { size, unmount } = await setup();
    size(140, 28);
    expect(frames.size).toBe(2);
    unmount();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(frames.size).toBe(0);
  });

  it('uses the full recording strip width instead of a small centered cluster', async () => {
    const { canvas, size } = await setup();
    const ctx = canvas.getContext('2d')!;
    const rectangles = vi.mocked(ctx.roundRect);
    size(1000, 40);
    await flushFrame();
    rectangles.mockClear();
    await flushFrame();
    const positions = rectangles.mock.calls.map(([x]) => x);
    expect(positions.length).toBe(250);
    expect(Math.min(...positions)).toBeLessThan(4);
    expect(Math.max(...positions)).toBeGreaterThan(990);
  });

  it('freezes the last waveform frame when recording ends', async () => {
    const analyser = {
      fftSize: 4,
      getByteTimeDomainData(target: Uint8Array) {
        target.fill(220);
      },
    } as unknown as AnalyserNode;
    const view = await setup({ analyser, active: true, bars: 4 });
    const { canvas } = view;
    view.size(140, 28);
    await flushFrame();
    const ctx = canvas.getContext('2d')!;
    const rectangles = vi.mocked(ctx.roundRect);
    rectangles.mockClear();
    await flushFrame();
    const liveHeights = rectangles.mock.calls.map(([, , , height]) => height);
    expect(Math.max(...liveHeights)).toBeGreaterThan(2);

    await view.rerender({ analyser: null, active: false, bars: 4 });
    rectangles.mockClear();
    await flushFrame();

    // The pending callback draws the final state once, then no new animation
    // frame is queued while transcription keeps the strip visible.
    expect(frames.size).toBe(0);
    const frozenHeights = rectangles.mock.calls.map(([, , , height]) => height);
    expect(Math.max(...frozenHeights)).toBeGreaterThan(2);
    expect(frozenHeights).toEqual(liveHeights);
  });
});
