// Voice-recording state, mirrored out of the composer so a strip above the
// context bar can show the same capture without the composer's own controls.
//
// The composer owns recording; this store only carries what another surface
// needs to render. It retains the analyser reference during transcription so
// the waveform component can freeze its last measured frame before clearing.

export type VoicePhase = 'idle' | 'recording' | 'transcribing';

export interface VoiceRecorderState {
  phase: VoicePhase;
  /** The live tap, retained for the frozen frame during transcription. */
  analyser: AnalyserNode | null;
  elapsedMs: number;
}

const initial: VoiceRecorderState = { phase: 'idle', analyser: null, elapsedMs: 0 };

let state = $state<VoiceRecorderState>({ ...initial });

export const voiceRecorder = {
  get state() {
    return state;
  },

  /** True while the strip should be visible at all. */
  get active(): boolean {
    return state.phase !== 'idle';
  },

  begin(phase: VoicePhase, analyser: AnalyserNode | null, elapsedMs = 0) {
    state = { phase, analyser, elapsedMs };
  },

  setElapsed(elapsedMs: number) {
    if (state.phase === 'idle') return;
    state = { ...state, elapsedMs };
  },

  end() {
    state = { ...initial };
  },
};
