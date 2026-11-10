// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hasTrustedImageModel, rememberTrustedImageModel } from '$lib/utils/image-input-fallback';

const { catalog } = vi.hoisted(() => ({
  catalog: {
    name: 'antigravity',
    id: 'gemini-3-1-pro',
    label: 'Gemini 3.1 Pro',
    vision: true,
    supportsAttachments: false,
    freebuckCost: undefined as number | undefined,
  },
}));

vi.mock('$lib/api.svelte', () => ({ apiFetch: vi.fn(async () => new Response('{}')) }));
vi.mock('$lib/utils/api-url', () => ({ apiUrl: (path: string) => path }));
vi.mock('./icons/ProviderIcon.svelte', async () => ({
  default: (await import('lucide-svelte/icons/circle')).default,
}));
vi.mock('$lib/stores/websocket.svelte', () => ({
  wsStore: {
    get providers() {
      return [
        {
          name: catalog.name,
          enabled: true,
          authenticated: true,
          models: [catalog.id],
          allAvailableModels: [
            {
              id: catalog.id,
              name: catalog.label,
              vision: catalog.vision,
              supportsAttachments: catalog.supportsAttachments,
              freebuckCost: catalog.freebuckCost,
            },
          ],
        },
      ];
    },
    feed: [
      {
        type: 'user_message',
        metadata: { attachments: [{ type: 'image', data: 'aW1hZ2U=', name: 'screenshot.png' }] },
      },
    ],
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

import CommandInput from './CommandInput.svelte';
import { apiFetch } from '$lib/api.svelte';

const model = 'antigravity:gemini-3-1-pro';
function composer(selectedModel = model) {
  const onSend = vi.fn((..._args: unknown[]) => true);
  const result = render(CommandInput, {
    onSend,
    selectedModel,
    disableModelPreviewRequests: true,
    draftKey: 'image-input-test',
  });
  return { ...result, onSend, input: result.container.querySelector('textarea')! };
}
async function send(input: HTMLTextAreaElement) {
  await fireEvent.input(input, { target: { value: 'Inspect the screenshot' } });
  await fireEvent.keyDown(input, { key: 'Enter' });
}

async function attachMedia(file: File) {
  // fireEvent only flushes Svelte updates, not the queued native FileReader.
  // Await the real read and its render before querying the attachment controls.
  const readAsDataURL = FileReader.prototype.readAsDataURL;
  let finishRead!: () => void;
  const readFinished = new Promise<void>((resolve) => {
    finishRead = resolve;
  });
  const read = vi.spyOn(FileReader.prototype, 'readAsDataURL').mockImplementation(
    function (this: FileReader, blob) {
      this.addEventListener('loadend', finishRead, { once: true });
      readAsDataURL.call(this, blob);
    },
  );
  try {
    await act(async () => {
      await fireEvent.change(screen.getByLabelText('Attach images, audio, or video'), {
        target: { files: [file] },
      });
      await readFinished;
    });
  } finally {
    read.mockRestore();
  }
}

describe('composer image capability correction', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
    vi.mocked(apiFetch).mockResolvedValue(new Response('{}'));
    localStorage.clear();
    Object.assign(catalog, {
      name: 'antigravity',
      id: 'gemini-3-1-pro',
      label: 'Gemini 3.1 Pro',
      vision: true,
      supportsAttachments: false,
    });
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
  });

  it('sends historical images with explicit allow after the user corrects the capability', async () => {
    const { input, onSend } = composer();
    await send(input);
    await waitFor(() => expect(screen.getByRole('alertdialog')).toBeTruthy());
    expect(screen.getByText(/supports vision, but image delivery/i)).toBeTruthy();
    expect(onSend).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole('button', { name: /this model supports images/i }));
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend.mock.calls[0]).toEqual([
      'Inspect the screenshot',
      model,
      'medium',
      undefined,
      false,
      'allow',
    ]);
    expect(hasTrustedImageModel(localStorage, model)).toBe(false);
  });

  it('remembers the correction and includes images after the composer is remounted', async () => {
    const first = composer();
    await send(first.input);
    await waitFor(() => expect(screen.getByRole('alertdialog')).toBeTruthy());
    await fireEvent.click(screen.getByRole('switch', { name: /remember my choice/i }));
    await fireEvent.click(screen.getByRole('button', { name: /this model supports images/i }));
    await waitFor(() => expect(first.onSend).toHaveBeenCalledTimes(1));
    expect(hasTrustedImageModel(localStorage, model)).toBe(true);
    first.unmount();

    const second = composer();
    await send(second.input);
    await waitFor(() => expect(second.onSend).toHaveBeenCalledTimes(1));
    expect(second.onSend.mock.calls[0][5]).toBe('allow');
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it.each([
    ['openai', 'new-vision'],
    ['anthropic', 'new-vision'],
    ['google', 'new-vision'],
    ['freebuff', 'freebuff/cli-default'],
    ['codex', 'codex-account:primary:vision'],
    ['custom:local-endpoint', 'vision:latest'],
    ['remote-host-google', 'vision:latest'],
  ])(
    'supports the correction for %s and preserves its exact selection identity',
    async (provider, id) => {
      Object.assign(catalog, { name: provider, id, label: 'Vision fixture', vision: false });
      const selection = `${provider}:${id}`;
      const { input, onSend } = composer(selection);
      await send(input);
      await waitFor(() => expect(screen.getByRole('alertdialog')).toBeTruthy());
      await fireEvent.click(screen.getByRole('switch', { name: /remember my choice/i }));
      await fireEvent.click(screen.getByRole('button', { name: /this model supports images/i }));
      await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
      expect(onSend.mock.calls[0][1]).toBe(selection);
      expect(onSend.mock.calls[0][5]).toBe('allow');
      expect(hasTrustedImageModel(localStorage, selection)).toBe(true);
      expect(hasTrustedImageModel(localStorage, `another-provider:${id}`)).toBe(false);
    },
  );

  it('keeps confirmed-image behavior when the catalog later reports image support', async () => {
    catalog.supportsAttachments = true;
    rememberTrustedImageModel(localStorage, model);
    const { input, onSend } = composer();
    await send(input);
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend.mock.calls[0][5]).toBe('allow');
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('keeps the provider model-rate info visible for Freebuff models', async () => {
    Object.assign(catalog, {
      name: 'freebuff',
      id: 'freebuff/catalog-m-fixture',
      label: 'MiMo 2.6 Flash',
      vision: false,
      supportsAttachments: false,
      freebuckCost: 7,
    });
    composer('freebuff:freebuff/catalog-m-fixture');

    await fireEvent.click(screen.getByRole('button', { name: /MiMo 2\.6 Flash/ }));

    // Only one priced model is known, so it is the 1x baseline: a bare "Nx"
    // figure, never an hours estimate.
    expect(screen.getByText('1x')).toBeTruthy();
    expect(screen.queryByText(/h left$/)).toBeNull();
    expect(screen.queryByText(/hours/)).toBeNull();
  });

  it('does not invent an hours estimate without a live account snapshot', async () => {
    Object.assign(catalog, {
      name: 'freebuff',
      id: 'freebuff/catalog-m-unpriced',
      label: 'Unpriced Freebuff model',
      vision: false,
      supportsAttachments: false,
      freebuckCost: undefined,
    });
    composer('freebuff:freebuff/catalog-m-unpriced');

    await fireEvent.click(screen.getByRole('button', { name: /Unpriced Freebuff model/ }));

    expect(screen.queryByText(/h left$/)).toBeNull();
  });

  it('keeps a provider-reported zero rate visible', async () => {
    Object.assign(catalog, {
      name: 'freebuff',
      id: 'freebuff/catalog-m-free',
      label: 'Free Freebuff model',
      vision: false,
      supportsAttachments: false,
      freebuckCost: 0,
    });
    composer('freebuff:freebuff/catalog-m-free');

    await fireEvent.click(screen.getByRole('button', { name: /Free Freebuff model/ }));

    expect(screen.getByText('0x')).toBeTruthy();
    expect(screen.queryByText(/h left$/)).toBeNull();
  });

  it('does not show the Freebuff multiplier for another provider even if its catalog row has a Freebuck field', async () => {
    Object.assign(catalog, {
      name: 'openai',
      id: 'gpt-test',
      label: 'OpenAI fixture',
      vision: false,
      supportsAttachments: false,
      freebuckCost: 25,
    });
    composer('openai:gpt-test');

    await fireEvent.click(screen.getByRole('button', { name: /OpenAI fixture/ }));

    expect(screen.queryByText('5x')).toBeNull();
    expect(screen.queryByText('1x')).toBeNull();
    expect(screen.queryByText('0x')).toBeNull();
  });

  it('attaches actual video bytes through the media file picker', async () => {
    rememberTrustedImageModel(localStorage, model);
    const { input, onSend } = composer();
    const file = new File(['clip'], 'clip.mp4', { type: 'video/mp4' });
    await attachMedia(file);
    expect(screen.getByText('clip.mp4')).toBeTruthy();
    await send(input);
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend.mock.calls[0][3]).toEqual([
      { type: 'file', name: 'clip.mp4', mimeType: 'video/mp4', data: 'Y2xpcA==' },
    ]);
  });

  it('replaces an uploaded audio file with an editable transcript using Voice settings', async () => {
    vi.mocked(apiFetch).mockImplementation(async (path) => {
      if (String(path).includes('/api/voice/settings'))
        return Response.json({
          data: { input: { provider: 'openai', modelId: 'whisper-1', language: 'en' } },
        });
      if (String(path).includes('/api/voice/transcribe'))
        return Response.json({ data: { text: 'Transcribed audio file' } });
      return Response.json({});
    });
    const { input } = composer();
    const file = new File(['speech'], 'speech.mp3', { type: 'audio/mpeg' });
    await attachMedia(file);
    expect(screen.getByRole('button', { name: 'Use transcript' })).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: 'Use transcript' }));
    await waitFor(() => expect(input.value).toContain('Transcribed audio file'));
    expect(screen.queryByText('speech.mp3')).toBeNull();
    expect(apiFetch).toHaveBeenCalledWith(
      '/api/voice/transcribe',
      expect.objectContaining({
        body: JSON.stringify({ audioBase64: 'c3BlZWNo', mimeType: 'audio/mpeg', language: 'en' }),
      }),
    );
  });
});
