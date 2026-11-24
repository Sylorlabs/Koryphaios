// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.hoisted(() => vi.fn());
const apiFetch = vi.hoisted(() => vi.fn());
const nativeListeners = vi.hoisted(() => new Map<string, () => void>());

vi.mock('$lib/api.svelte', () => ({ apiFetch, parseJsonResponse: vi.fn() }));
vi.mock('$lib/utils/api-url', () => ({ apiUrl: (path: string) => path }));
vi.mock('./icons/ProviderIcon.svelte', async () => ({
  default: (await import('lucide-svelte/icons/circle')).default,
}));
vi.mock('$lib/stores/websocket.svelte', () => ({
  wsStore: {
    providers: [{ name: 'openai', enabled: true, authenticated: true, models: ['test-model'] }],
    feed: [],
    setYoloMode: vi.fn(),
    contextUsage: null,
  },
}));
vi.mock('$lib/stores/sessions.svelte', () => ({ sessionStore: { activeSessionId: null } }));
vi.mock('$lib/stores/project.svelte', () => ({ projectStore: { currentPath: null } }));
vi.mock('$lib/stores/goals.svelte', () => ({
  goalStore: { goals: [], loaded: true, refresh: vi.fn(), selectedGoalId: '' },
}));
vi.mock('$lib/stores/goal-display.svelte', () => ({
  goalDisplayStore: { composer: false, update: vi.fn() },
}));
vi.mock('$lib/utils/now-signal.svelte', () => ({
  useNow: () => ({ now: Date.now(), unsubscribe: vi.fn() }),
  useSecondClock: () => ({ now: Date.now(), unsubscribe: vi.fn() }),
}));
vi.mock('$lib/stores/agent-settings.svelte', () => ({
  agentSettingsStore: { settings: {}, loadSettings: vi.fn() },
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name: string, callback: () => void) => {
    nativeListeners.set(name, callback);
    return () => nativeListeners.delete(name);
  }),
}));

// jsdom has no ResizeObserver, and the composer observes its own height.
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= NoopResizeObserver;

import CommandInput from './CommandInput.svelte';
import { voiceRecorder } from '$lib/stores/voice-recorder.svelte';
import { shortcutStore, defaultShortcuts } from '$lib/stores/shortcuts.svelte';
import { formatChord } from '$lib/utils/platform';

const VOICE_SETTINGS = {
  input: { provider: 'kory-local', modelId: 'kory-local-voice', language: 'en' },
  output: {
    provider: 'system',
    modelId: 'web-speech-synthesis',
    voiceId: 'system-default',
    speed: 1,
  },
  autoReadFinalReplies: false,
  voiceModeEnabled: true,
  localVoiceSetupVersion: 1,
};

type FakeNode = {
  connect: () => void;
  disconnect: () => void;
  onaudioprocess?: unknown;
  fftSize?: number;
  smoothingTimeConstant?: number;
  frequencyBinCount?: number;
  getByteTimeDomainData?: (target: Uint8Array) => void;
  getChannelData?: (index: number) => Float32Array;
};

/** A filled constant, so the waveform's live tap has real samples to read. */
const LIVE_SAMPLE = 0.4;

class FakeAnalyser implements FakeNode {
  fftSize = 0;
  smoothingTimeConstant = 0;
  frequencyBinCount = 0;
  connect = vi.fn();
  disconnect = vi.fn();
  getByteTimeDomainData(target: Uint8Array) {
    for (let index = 0; index < target.length; index += 1) {
      target[index] = Math.round(128 + LIVE_SAMPLE * 127);
    }
  }
}

class FakeAudioContext {
  static processors: FakeNode[] = [];
  static analysers: FakeAnalyser[] = [];
  sampleRate = 48_000;
  resume = vi.fn(async () => {});
  close = vi.fn(async () => {});
  destination = {};
  createMediaStreamSource() {
    return { connect: vi.fn(), disconnect: vi.fn() };
  }
  createAnalyser() {
    const analyser = new FakeAnalyser();
    FakeAudioContext.analysers.push(analyser);
    return analyser;
  }
  createScriptProcessor() {
    const processor: FakeNode = { connect: vi.fn(), disconnect: vi.fn(), onaudioprocess: null };
    FakeAudioContext.processors.push(processor);
    return processor;
  }
  createGain() {
    return { connect: vi.fn(), disconnect: vi.fn(), gain: { value: 1 } };
  }
  /** Push a block of audio, the way a real capture callback would. */
  static emitAudio(frames = 4096) {
    for (const processor of FakeAudioContext.processors) {
      const handler = processor.onaudioprocess as
        ((event: { inputBuffer: { getChannelData: (i: number) => Float32Array } }) => void) | null;
      handler?.({
        inputBuffer: {
          getChannelData: () => new Float32Array(frames).fill(LIVE_SAMPLE),
        },
      });
    }
  }
}

function installMicrophone(permissionState: PermissionState = 'granted') {
  const getUserMedia = vi.fn(async () => ({
    getTracks: () => [{ stop: vi.fn() }],
  }));
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia },
  });
  // The composer's consent sheet is skipped when the OS has already ruled:
  // recording tests install an already-granted platform.
  Object.defineProperty(navigator, 'permissions', {
    configurable: true,
    value: {
      query: vi.fn(async () => ({ state: permissionState, onchange: null })),
    },
  });
  (globalThis as { AudioContext?: unknown }).AudioContext = FakeAudioContext;
  return getUserMedia;
}

function composer() {
  return render(CommandInput, {
    onSend: vi.fn(),
    selectedModel: 'openai:test-model',
    disableModelPreviewRequests: true,
    draftKey: 'voice-toggle-test',
  });
}

/** Presses the voice binding, which is Control+Space on every platform. */
function pressVoiceToggle(repeat = false) {
  window.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: ' ',
      ctrlKey: true,
      repeat,
      bubbles: true,
      cancelable: true,
    }),
  );
}

/** Releases the held binding: the voice shortcut is push-to-talk. */
function releaseVoiceToggle() {
  window.dispatchEvent(
    new KeyboardEvent('keyup', {
      key: ' ',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    }),
  );
}

/** The hint the microphone button advertises, composed the way the UI does. */
function voiceShortcutHint() {
  return formatChord(...shortcutStore.keys('voice_mode'));
}

/** Transcriptions requested so far, ignoring the model-status probe. */
function transcribeCalls() {
  return invoke.mock.calls.filter(([command]) => command === 'transcribe_local_voice').length;
}

function recorderPanel() {
  return screen.getByTestId('composer-voice-recorder');
}

function micButton() {
  return within(recorderPanel()).getByRole('button', {
    name: /stop recording and transcribe|record a voice prompt/i,
  });
}

describe('voice mode toggling and microphone control', () => {
  beforeEach(() => {
    localStorage.clear();
    // The store is a singleton, so an in-memory reassignment from an earlier
    // test would still be bound when the next composer mounts.
    shortcutStore.list = defaultShortcuts.map((shortcut) => ({
      ...shortcut,
      keys: [...shortcut.keys],
    }));
    invoke.mockReset();
    apiFetch.mockReset();
    voiceRecorder.end();
    FakeAudioContext.processors = [];
    FakeAudioContext.analysers = [];
    nativeListeners.clear();
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    apiFetch.mockImplementation(async (url: string) => {
      if (url.includes('/api/voice/settings')) {
        return new Response(JSON.stringify({ ok: true, data: VOICE_SETTINGS }));
      }
      return new Response('{}');
    });
    invoke.mockImplementation(async (command: string) => {
      if (command === 'local_voice_model_status') {
        return {
          installed: true,
          modelId: 'kory-local-voice',
          name: 'ggml-tiny.bin',
          format: 'Ggml',
        };
      }
      if (command === 'transcribe_local_voice') return { text: 'toggle works' };
      return undefined;
    });
  });
  it('records while the shortcut is held and transcribes when it is released', async () => {
    const getUserMedia = installMicrophone();
    const { unmount } = composer();
    await screen.findByRole('button', { name: /record a voice prompt/i });

    pressVoiceToggle();
    await waitFor(() => expect(getUserMedia).toHaveBeenCalled());
    await waitFor(() => expect(recorderPanel()).toHaveAttribute('data-state', 'recording'));

    // A held key repeats keydown, and the repeat must not stop the capture.
    pressVoiceToggle(true);
    expect(recorderPanel()).toHaveAttribute('data-state', 'recording');
    expect(invoke).not.toHaveBeenCalledWith('transcribe_local_voice', expect.anything());

    FakeAudioContext.emitAudio();
    releaseVoiceToggle();
    // Even a fast local transcription must get a paint with the stopped,
    // frozen waveform before the strip is cleared.
    expect(voiceRecorder.state.phase).toBe('transcribing');
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        'transcribe_local_voice',
        expect.objectContaining({ language: 'en' }),
      ),
    );
    // Transcription resolves fast here, so the panel settles back to idle rather
    // than being caught mid-transcription.
    await waitFor(() => expect(recorderPanel()).toHaveAttribute('data-state', 'idle'));
    unmount();
  });

  it('ends a held capture when the window loses focus so the key cannot stick', async () => {
    installMicrophone();
    const { unmount } = composer();
    await screen.findByRole('button', { name: /record a voice prompt/i });

    pressVoiceToggle();
    await waitFor(() => expect(recorderPanel()).toHaveAttribute('data-state', 'recording'));

    // A release outside the window never reaches the keyup listener, so losing
    // focus has to end the hold instead of leaving the microphone open.
    FakeAudioContext.emitAudio();
    window.dispatchEvent(new Event('blur'));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        'transcribe_local_voice',
        expect.objectContaining({ language: 'en' }),
      ),
    );
    unmount();
  });

  it('keeps only the unboxed microphone in the toolbar during capture', async () => {
    installMicrophone();
    const { unmount } = composer();
    const mic = await screen.findByRole('button', { name: /record a voice prompt/i });

    expect(recorderPanel().contains(mic)).toBe(true);
    expect(screen.getAllByRole('button', { name: /record a voice prompt/i })).toHaveLength(1);
    expect(recorderPanel().querySelector('canvas')).toBeNull();

    // It sits in the composer's own flow, never floating over the chat.
    expect(recorderPanel().className).not.toContain('absolute');

    pressVoiceToggle();
    await waitFor(() => expect(recorderPanel()).toHaveAttribute('data-state', 'recording'));

    expect(recorderPanel().querySelector('canvas')).toBeNull();
    expect(recorderPanel().textContent?.trim()).toBe('');
    expect(recorderPanel().getAttribute('style') ?? '').not.toContain('background');
    unmount();
  });

  it('publishes the capture to the strip above the context bar', async () => {
    installMicrophone();
    const { unmount } = composer();
    await screen.findByRole('button', { name: /record a voice prompt/i });

    pressVoiceToggle();
    await waitFor(() => expect(recorderPanel()).toHaveAttribute('data-state', 'recording'));

    // The strip reads the same live tap the composer does.
    await waitFor(() => expect(voiceRecorder.state.phase).toBe('recording'));
    expect(voiceRecorder.state.analyser).toBe(FakeAudioContext.analysers[0]);
    expect(voiceRecorder.active).toBe(true);

    FakeAudioContext.emitAudio();
    releaseVoiceToggle();
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        'transcribe_local_voice',
        expect.objectContaining({ language: 'en' }),
      ),
    );

    // Every stop path clears it, so the strip can never outlive the capture.
    await waitFor(() => expect(voiceRecorder.active).toBe(false));
    expect(voiceRecorder.state.analyser).toBeNull();
    unmount();
  });

  it('keeps the final audio analyser published while transcription is pending', async () => {
    let resolveTranscription!: (value: { text: string }) => void;
    const transcription = new Promise<{ text: string }>((resolve) => {
      resolveTranscription = resolve;
    });
    invoke.mockImplementation(async (command: string) => {
      if (command === 'local_voice_model_status') {
        return {
          installed: true,
          modelId: 'kory-local-voice',
          name: 'ggml-tiny.bin',
          format: 'Ggml',
        };
      }
      if (command === 'transcribe_local_voice') return transcription;
      return undefined;
    });

    const { unmount } = composer();
    await screen.findByRole('button', { name: /record a voice prompt/i });
    pressVoiceToggle();
    await waitFor(() => expect(recorderPanel()).toHaveAttribute('data-state', 'recording'));
    const analyser = FakeAudioContext.analysers[0];
    FakeAudioContext.emitAudio();
    releaseVoiceToggle();

    await waitFor(() => expect(recorderPanel()).toHaveAttribute('data-state', 'transcribing'));
    expect(voiceRecorder.active).toBe(true);
    expect(voiceRecorder.state.phase).toBe('transcribing');
    expect(voiceRecorder.state.analyser).toBe(analyser);

    resolveTranscription({ text: 'pending capture' });
    await waitFor(() => expect(voiceRecorder.active).toBe(false));
    unmount();
  });

  it('taps the live graph so the waveform reads real audio', async () => {
    installMicrophone();
    const { unmount } = composer();
    await screen.findByRole('button', { name: /record a voice prompt/i });

    pressVoiceToggle();
    await waitFor(() => expect(recorderPanel()).toHaveAttribute('data-state', 'recording'));

    // One analyser for the tap, created from the recorder's own context.
    expect(FakeAudioContext.analysers).toHaveLength(1);
    const analyser = FakeAudioContext.analysers[0];
    expect(analyser.fftSize).toBeGreaterThan(0);

    const sample = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(sample);
    expect(sample[0]).toBeGreaterThan(128);
    unmount();
  });

  it('offers the shortcut in the microphone tooltip', async () => {
    installMicrophone();
    const { unmount } = composer();
    const mic = await screen.findByRole('button', { name: /record a voice prompt/i });
    // The chord is composed the way the UI composes it, never hard-coded.
    expect(mic.getAttribute('title')).toBe(
      `Click to record · hold ${voiceShortcutHint()} to talk · hold ${formatChord(
        ...shortcutStore.keys('voice_conductor'),
      )} for a voice command`,
    );
    unmount();
  });

  it('also supports click-to-start and click-to-stop', async () => {
    const getUserMedia = installMicrophone();
    const { unmount } = composer();
    await screen.findByRole('button', { name: /record a voice prompt/i });

    screen.getByRole('button', { name: /record a voice prompt/i }).click();
    await waitFor(() => expect(getUserMedia).toHaveBeenCalled());
    await waitFor(() => expect(recorderPanel()).toHaveAttribute('data-state', 'recording'));

    FakeAudioContext.emitAudio();
    micButton().click();
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        'transcribe_local_voice',
        expect.objectContaining({ language: 'en' }),
      ),
    );
    unmount();
  });

  it('reports an elapsed recording time', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      installMicrophone();
      const { unmount } = composer();
      await screen.findByRole('button', { name: /record a voice prompt/i });

      pressVoiceToggle();
      await waitFor(() => expect(recorderPanel()).toHaveAttribute('data-state', 'recording'));
      expect(voiceRecorder.state.elapsedMs).toBe(0);

      await vi.advanceTimersByTimeAsync(65_000);
      await waitFor(() => expect(voiceRecorder.state.elapsedMs).toBeGreaterThanOrEqual(65_000));
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases the tap and the timer when the recording ends', async () => {
    const getUserMedia = installMicrophone();
    const { unmount } = composer();
    await screen.findByRole('button', { name: /record a voice prompt/i });

    pressVoiceToggle();
    await waitFor(() => expect(getUserMedia).toHaveBeenCalled());
    await waitFor(() => expect(recorderPanel()).toHaveAttribute('data-state', 'recording'));
    FakeAudioContext.emitAudio();
    releaseVoiceToggle();
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        'transcribe_local_voice',
        expect.objectContaining({ language: 'en' }),
      ),
    );

    // The analyser is disconnected with the recorder, so the waveform cannot
    // keep reading a dead node.
    expect(FakeAudioContext.analysers[0].disconnect).toHaveBeenCalled();
    unmount();
  });

  it('allows the voice shortcut while typing in the composer', async () => {
    installMicrophone();
    const { unmount } = composer();
    await screen.findByRole('button', { name: /record a voice prompt/i });
    screen.getByRole('textbox').focus();
    pressVoiceToggle();
    await waitFor(() => expect(recorderPanel()).toHaveAttribute('data-state', 'recording'));
    releaseVoiceToggle();
    await waitFor(() => expect(recorderPanel()).toHaveAttribute('data-state', 'idle'));
    unmount();
  });

  it('relays the native fn press and release edges as a hold', async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    installMicrophone();
    const { unmount } = composer();
    await screen.findByRole('button', { name: /record a voice prompt/i });
    // The native relay only applies while the binding is fn, which is what a
    // macOS user picks when the shell exposes the key for them.
    shortcutStore.list = shortcutStore.list.map((s) =>
      s.id === 'voice_mode' ? { ...s, keys: ['Fn'] } : s,
    );
    await waitFor(() => expect(nativeListeners.has('voice://fn-down')).toBe(true));
    await waitFor(() => expect(nativeListeners.has('voice://fn-up')).toBe(true));
    nativeListeners.get('voice://fn-down')!();
    await waitFor(() => expect(recorderPanel()).toHaveAttribute('data-state', 'recording'));
    FakeAudioContext.emitAudio();
    // The release edge ends the hold, exactly like the keyboard keyup.
    nativeListeners.get('voice://fn-up')!();
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('transcribe_local_voice', expect.anything()),
    );
    unmount();
    expect(nativeListeners.size).toBe(0);
  });

  it('enables the voice feature when its shortcut is pressed', async () => {
    installMicrophone();
    apiFetch.mockImplementation(
      async (_url: string, options?: RequestInit) =>
        new Response(
          JSON.stringify({
            ok: true,
            data: { ...VOICE_SETTINGS, voiceModeEnabled: options?.method === 'PUT' },
          }),
        ),
    );
    const { unmount } = composer();
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    pressVoiceToggle();
    await waitFor(() => expect(recorderPanel()).toHaveAttribute('data-state', 'recording'));
    expect(apiFetch).toHaveBeenCalledWith(
      '/api/voice/settings',
      expect.objectContaining({ method: 'PUT' }),
    );
    unmount();
  });

  it('stops transcribing before the capture can start again', async () => {
    installMicrophone();
    const { unmount } = composer();
    await screen.findByRole('button', { name: /record a voice prompt/i });

    // A second press while the transcript is still in flight is dropped, so the
    // transcription that follows belongs to the capture that ended.
    pressVoiceToggle();
    await waitFor(() => expect(recorderPanel()).toHaveAttribute('data-state', 'recording'));
    FakeAudioContext.emitAudio();
    releaseVoiceToggle();
    // A new press that lands while the previous capture is still transcribing
    // must be dropped, so the follow-up transcription belongs to one capture.
    pressVoiceToggle();
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('transcribe_local_voice', expect.anything()),
    );
    await waitFor(() => expect(recorderPanel()).toHaveAttribute('data-state', 'idle'));
    expect(transcribeCalls()).toBe(1);
    unmount();
  });

  it('asks for the microphone in a consent sheet before recording', async () => {
    // An undecided platform: the composer must ask before touching the mic.
    const getUserMedia = installMicrophone('prompt');
    const { unmount } = composer();
    await screen.findByRole('button', { name: /record a voice prompt/i });

    pressVoiceToggle();
    const sheet = await screen.findByText('“Koryphaios” Would Like to Access the Microphone');
    expect(sheet).toBeTruthy();
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(recorderPanel()).toHaveAttribute('data-state', 'idle');

    // Declining keeps the microphone closed and explains how to proceed.
    await fireEvent.click(screen.getByRole('button', { name: "Don't Allow" }));
    await waitFor(() =>
      expect(screen.queryByText('“Koryphaios” Would Like to Access the Microphone')).toBeNull(),
    );
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(localStorage.getItem('koryphaios.microphone-consent')).toBeNull();

    // The next press asks again, and allowing starts the capture.
    pressVoiceToggle();
    await screen.findByText('“Koryphaios” Would Like to Access the Microphone');
    await fireEvent.click(screen.getByRole('button', { name: 'Allow' }));
    await waitFor(() => expect(getUserMedia).toHaveBeenCalled());
    await waitFor(() => expect(recorderPanel()).toHaveAttribute('data-state', 'recording'));
    expect(localStorage.getItem('koryphaios.microphone-consent')).toBe('granted');

    // Once allowed, later holds record immediately without re-asking.
    FakeAudioContext.emitAudio();
    releaseVoiceToggle();
    // Let the transcription finish: a press that lands while it is still
    // running is deliberately dropped instead of interrupting it.
    await waitFor(() => expect(recorderPanel()).toHaveAttribute('data-state', 'idle'));
    pressVoiceToggle();
    await waitFor(() => expect(recorderPanel()).toHaveAttribute('data-state', 'recording'));
    expect(screen.queryByText('“Koryphaios” Would Like to Access the Microphone')).toBeNull();
    unmount();
  });

  it('shows live transcription while the voice shortcut is held', async () => {
    installMicrophone();
    invoke.mockImplementation(async (command: string) => {
      if (command === 'local_voice_model_status') {
        return {
          installed: true,
          modelId: 'kory-local-voice',
          name: 'ggml-tiny.bin',
          format: 'Ggml',
        };
      }
      if (command === 'transcribe_local_voice') return { text: 'live words' };
      return undefined;
    });
    const { unmount } = composer();
    await screen.findByRole('button', { name: /record a voice prompt/i });

    pressVoiceToggle();
    await waitFor(() => expect(recorderPanel()).toHaveAttribute('data-state', 'recording'));
    // More than the live pass threshold, so the cadence has audio to send.
    FakeAudioContext.emitAudio(48_000);

    await waitFor(() => expect(voiceRecorder.state.partialText).toBe('live words'), {
      timeout: 4_000,
    });
    // The caption is a preview: the composer only receives the final text.
    expect(screen.getByRole('textbox')).toHaveValue('');
    releaseVoiceToggle();
    unmount();
  });
});
