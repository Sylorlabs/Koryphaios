/**
 * A live microphone tap for the composer waveform.
 *
 * Recording already needs an AudioContext for the local PCM path, so the tap
 * is created from the same graph where one exists. It is deliberately separate
 * from transcription: a provider that owns the microphone itself (system speech
 * recognition) has no stream to tap, and callers pass `null` there rather than
 * showing a waveform driven by nothing.
 */

export interface VoiceTap {
  analyser: AnalyserNode;
  /** Tear the tap down. The owning recorder's stream and context are not closed. */
  release: () => void;
}

/** Window length for the waveform. 1024 gives ~21ms at 48kHz, which reads as
 *  speech rather than as individual samples. */
const FFT_SIZE = 1024;

/**
 * Attach an analyser to a stream, reusing `context` when the caller already has
 * one. Returns null when the platform has no Web Audio support, so the caller
 * can record without a waveform instead of failing the recording.
 */
export function createVoiceTap(
  stream: MediaStream,
  context?: AudioContext,
): { tap: VoiceTap; context: AudioContext } | null {
  // A supplied context is already proven to work, so it is used as-is even
  // where the global constructor is absent.
  if (!context) {
    const AudioCtor =
      globalThis.AudioContext ??
      (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtor) return null;
    context = new AudioCtor();
  }
  const ctx = context;
  try {
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    // Waveforms should react instantly to a syllable; too much smoothing reads
    // as a flat line that lags the speaker.
    analyser.fftSize = FFT_SIZE;
    analyser.smoothingTimeConstant = 0.2;
    source.connect(analyser);
    // The analyser is a leaf: it is never connected onward, so no audible path
    // to the speakers is created.
    return {
      context: ctx,
      tap: {
        analyser,
        release: () => {
          source.disconnect();
          analyser.disconnect();
        },
      },
    };
  } catch {
    return null;
  }
}
