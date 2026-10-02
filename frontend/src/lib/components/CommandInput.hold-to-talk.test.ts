// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.hoisted(() => vi.fn());
const apiFetch = vi.hoisted(() => vi.fn());

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

// jsdom has no ResizeObserver, and the composer observes its own height.
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= NoopResizeObserver;

import CommandInput from './CommandInput.svelte';

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

type FakeNode = { connect: () => void; disconnect: () => void; onaudioprocess?: unknown };

class FakeAudioContext {
  static processors: FakeNode[] = [];
  sampleRate = 48_000;
  resume = vi.fn(async () => {});
  close = vi.fn(async () => {});
  destination = {};
  createMediaStreamSource() {
    return { connect: vi.fn(), disconnect: vi.fn() };
  }
  createScriptProcessor() {
    const processor: FakeNode = { connect: vi.fn(), disconnect: vi.fn(), onaudioprocess: null };
    FakeAudioContext.processors.push(processor);
    return processor;
  }
  createGain() {
    return { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
  }
  /** Push a block of audio, the way a real capture callback would. */
  static emitAudio(frames = 4096) {
    for (const processor of FakeAudioContext.processors) {
      const handler = processor.onaudioprocess as
        ((event: { inputBuffer: { getChannelData: () => Float32Array } }) => void) | null;
      handler?.({ inputBuffer: { getChannelData: () => new Float32Array(frames).fill(0.2) } });
    }
  }
}

function installMicrophone() {
  const getUserMedia = vi.fn(async () => ({
    getTracks: () => [{ stop: vi.fn() }],
  }));
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia },
  });
  (globalThis as { AudioContext?: unknown }).AudioContext = FakeAudioContext;
  return getUserMedia;
}

function composer() {
  return render(CommandInput, {
    onSend: vi.fn(),
    selectedModel: 'openai:test-model',
    disableModelPreviewRequests: true,
    draftKey: 'hold-to-talk-test',
  });
}

function press(key: string, type: 'keydown' | 'keyup') {
  window.dispatchEvent(new KeyboardEvent(type, { key, bubbles: true, cancelable: true }));
}

describe('voice mode is push to talk', () => {
  beforeEach(() => {
    localStorage.clear();
    invoke.mockReset();
    apiFetch.mockReset();
    FakeAudioContext.processors = [];
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
      if (command === 'transcribe_local_voice') return { text: 'hold to talk works' };
      return undefined;
    });
  });

  it('records while the key is held and transcribes when it is released', async () => {
    const getUserMedia = installMicrophone();
    const { unmount } = composer();
    const mic = await screen.findByRole('button', { name: /hold to record/i });
    expect(mic).toBeTruthy();

    press('Fn', 'keydown');
    await waitFor(() => expect(getUserMedia).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /release to transcribe/i })).toBeTruthy(),
    );
    // Holding longer must not start a second recording.
    press('Fn', 'keydown');
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(invoke).not.toHaveBeenCalledWith('transcribe_local_voice', expect.anything());

    FakeAudioContext.emitAudio();
    press('Fn', 'keyup');
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        'transcribe_local_voice',
        expect.objectContaining({ language: 'en' }),
      ),
    );
    unmount();
  });

  it('offers the shortcut in the microphone tooltip', async () => {
    installMicrophone();
    const { unmount } = composer();
    const mic = await screen.findByRole('button', { name: /hold to record/i });
    expect(mic.getAttribute('title')).toMatch(/fn/i);
    unmount();
  });

  it('does not hold a bare key open while the composer is being typed into', async () => {
    const getUserMedia = installMicrophone();
    const { container, unmount } = composer();
    await screen.findByRole('button', { name: /hold to record/i });
    const input = container.querySelector('textarea')!;
    input.focus();

    // A bare chord would otherwise swallow ordinary typing, so it must not act
    // while a text field has focus.
    press('Fn', 'keydown');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(getUserMedia).not.toHaveBeenCalled();
    unmount();
  });

  it('releases a hold when the window loses focus', async () => {
    installMicrophone();
    const { unmount } = composer();
    await screen.findByRole('button', { name: /hold to record/i });

    press('Fn', 'keydown');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /release to transcribe/i })).toBeTruthy(),
    );
    // A keyup that never arrives (the window was switched away) must not leave
    // the microphone running.
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

  it('records and stops from the microphone button itself', async () => {
    const getUserMedia = installMicrophone();
    const { unmount } = composer();
    const mic = await screen.findByRole('button', { name: /hold to record/i });

    mic.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    await waitFor(() => expect(getUserMedia).toHaveBeenCalled());
    FakeAudioContext.emitAudio();
    mic.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('transcribe_local_voice', expect.anything()),
    );
    unmount();
  });
});
