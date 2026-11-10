import { describe, expect, it, vi } from 'vitest';
import { createVoiceTap } from './voice-tap';

class FakeAnalyser {
  fftSize = 0;
  smoothingTimeConstant = 0;
  connect = vi.fn();
  disconnect = vi.fn();
}

class FakeContext {
  analysers: FakeAnalyser[] = [];
  sources: Array<{ connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }> = [];
  createAnalyser() {
    const analyser = new FakeAnalyser();
    this.analysers.push(analyser);
    return analyser;
  }
  createMediaStreamSource() {
    const source = { connect: vi.fn(), disconnect: vi.fn() };
    this.sources.push(source);
    return source;
  }
}

function fakeStream() {
  return { getTracks: () => [] } as unknown as MediaStream;
}

describe('createVoiceTap', () => {
  it('taps a stream on a window sized for speech and connects it as a leaf', () => {
    const context = new FakeContext();
    const result = createVoiceTap(fakeStream(), context as unknown as AudioContext);

    expect(result).not.toBeNull();
    expect(result?.context).toBe(context as unknown as AudioContext);
    expect(result?.tap.analyser.fftSize).toBe(1024);
    // Smoothing is kept low so a syllable shows up instead of a flat average.
    expect(result?.tap.analyser.smoothingTimeConstant).toBeLessThan(0.5);
    // A leaf: connected from the source, never onward to the speakers.
    expect(context.sources[0].connect).toHaveBeenCalledWith(context.analysers[0]);
    expect(context.analysers[0].connect).not.toHaveBeenCalled();
  });

  it('releases both nodes so the waveform cannot read a dead tap', () => {
    const context = new FakeContext();
    const result = createVoiceTap(fakeStream(), context as unknown as AudioContext);
    result?.tap.release();
    expect(context.sources[0].disconnect).toHaveBeenCalled();
    expect(context.analysers[0].disconnect).toHaveBeenCalled();
  });

  it('returns null when the runtime has no Web Audio, rather than throwing', () => {
    const original = globalThis.AudioContext;
    // @ts-expect-error deliberately removing the global for this case
    delete globalThis.AudioContext;
    try {
      expect(createVoiceTap(fakeStream())).toBeNull();
    } finally {
      globalThis.AudioContext = original;
    }
  });

  it('returns null when the graph rejects the source', () => {
    const context = {
      createAnalyser: () => new FakeAnalyser(),
      createMediaStreamSource: () => {
        throw new Error('no source');
      },
    } as unknown as AudioContext;
    expect(createVoiceTap(fakeStream(), context)).toBeNull();
  });
});
