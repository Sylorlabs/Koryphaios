// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

import { voiceConductor } from '$lib/voice-conductor/conductor.svelte';
import { conductorSettings } from '$lib/voice-conductor/settings.svelte';
import { setPlatformForTesting } from '$lib/utils/platform';

let spokenText = 'toggle works';

/** Holds the conductor binding (Mod+Shift+Space; Mod is Ctrl on Linux). */
function pressConductor() {
  window.dispatchEvent(
    new KeyboardEvent('keydown', { key: ' ', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }),
  );
}

function releaseConductor() {
  window.dispatchEvent(
    new KeyboardEvent('keyup', { key: ' ', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }),
  );
}

async function dictate(text: string, press = pressVoiceToggle, release = releaseVoiceToggle) {
  spokenText = text;
  press();
  await waitFor(() => expect(voiceRecorder.state.phase).toBe('recording'));
  FakeAudioContext.emitAudio();
  release();
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith('transcribe_local_voice', expect.anything()),
  );
  await waitFor(() => expect(voiceRecorder.state.phase).toBe('idle'));
}

describe('voice conductor routing in the composer', () => {
  let handleUtterance: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    setPlatformForTesting('linux');
    localStorage.clear();
    conductorSettings.reload();
    shortcutStore.list = defaultShortcuts.map((shortcut) => ({ ...shortcut, keys: [...shortcut.keys] }));
    invoke.mockReset();
    apiFetch.mockReset();
    voiceRecorder.end();
    FakeAudioContext.processors = [];
    FakeAudioContext.analysers = [];
    apiFetch.mockImplementation(async (url: string) => {
      if (url.includes('/api/voice/settings')) {
        return new Response(JSON.stringify({ ok: true, data: VOICE_SETTINGS }));
      }
      return new Response('{}');
    });
    invoke.mockImplementation(async (command: string) => {
      if (command === 'local_voice_model_status') {
        return { installed: true, modelId: 'kory-local-voice', name: 'ggml-tiny.bin', format: 'Ggml' };
      }
      if (command === 'transcribe_local_voice') return { text: spokenText };
      return undefined;
    });
    handleUtterance = vi.spyOn(voiceConductor, 'handleUtterance').mockResolvedValue(undefined);
  });

  afterEach(() => {
    handleUtterance.mockRestore();
    setPlatformForTesting(null);
  });

  it('keeps plain dictation in the composer', async () => {
    installMicrophone();
    const { unmount } = composer();
    await screen.findByRole('button', { name: /record a voice prompt/i });
    await dictate('Refactor the parser');
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('Refactor the parser'));
    expect(handleUtterance).not.toHaveBeenCalled();
    unmount();
  });

  it('routes dictation that starts with the wake phrase to the conductor', async () => {
    installMicrophone();
    const { unmount } = composer();
    await screen.findByRole('button', { name: /record a voice prompt/i });
    await dictate('Hey Kory, stop worker two');
    await waitFor(() => expect(handleUtterance).toHaveBeenCalledWith('stop worker two'));
    expect(screen.getByRole('textbox')).toHaveValue('');
    unmount();
  });

  it('leaves wake-phrase dictation in the composer when the wake phrase is off', async () => {
    conductorSettings.update({ wakePhraseEnabled: false });
    installMicrophone();
    const { unmount } = composer();
    await screen.findByRole('button', { name: /record a voice prompt/i });
    await dictate('Kory, stop');
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('Kory, stop'));
    expect(handleUtterance).not.toHaveBeenCalled();
    unmount();
  });

  it('sends a conductor-shortcut capture to the conductor without a wake phrase', async () => {
    installMicrophone();
    const { unmount } = composer();
    await screen.findByRole('button', { name: /record a voice prompt/i });
    spokenText = 'what are the agents doing';
    pressConductor();
    await waitFor(() => expect(voiceRecorder.state.phase).toBe('recording'));
    // The listening indicator is distinct from dictation.
    expect(voiceRecorder.state.mode).toBe('conductor');
    FakeAudioContext.emitAudio();
    releaseConductor();
    await waitFor(() => expect(handleUtterance).toHaveBeenCalledWith('what are the agents doing'));
    expect(screen.getByRole('textbox')).toHaveValue('');
    unmount();
  });

  it('ignores the conductor shortcut when the conductor is off', async () => {
    conductorSettings.update({ enabled: false });
    const getUserMedia = installMicrophone();
    const { unmount } = composer();
    await screen.findByRole('button', { name: /record a voice prompt/i });
    pressConductor();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(voiceRecorder.state.phase).toBe('idle');
    unmount();
  });
});
