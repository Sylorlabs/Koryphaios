import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  toastSuccess: vi.fn(),
  toastInfo: vi.fn(),
  toastWarning: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('$lib/api.svelte', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('$lib/utils/api-url', () => ({ apiUrl: (path: string) => path }));
vi.mock('$lib/stores/toast.svelte', () => ({
  toastStore: {
    success: mocks.toastSuccess,
    info: mocks.toastInfo,
    warning: mocks.toastWarning,
    error: mocks.toastError,
  },
}));

import ImageSettings from './ImageSettings.svelte';

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function configuredProvidersResponse(): Response {
  return response({
    ok: true,
    data: [
      {
        id: 'openai',
        label: 'OpenAI',
        adapter: 'openai-images',
        configured: true,
        models: [{ id: 'gpt-image-1', label: 'GPT Image 1' }],
      },
    ],
  });
}

describe('ImageSettings active job recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('reloads a completed job from its durable history entry', async () => {
    sessionStorage.setItem(
      'koryphaios-active-image-job-v1',
      JSON.stringify({ jobId: 'recover-completed', expiresAt: Date.now() + 60_000 }),
    );
    mocks.apiFetch.mockImplementation((url: string) => {
      if (url === '/api/images/providers') return Promise.resolve(configuredProvidersResponse());
      if (url === '/api/images/history?limit=12') return Promise.resolve(response({ ok: true, data: [] }));
      if (url === '/api/images/jobs/recover-completed') {
        return Promise.resolve(
          response({ ok: true, data: { status: 'completed', historyId: 'history-1' } }),
        );
      }
      if (url === '/api/images/history/history-1') {
        return Promise.resolve(
          response({
            ok: true,
            data: {
              imageBase64: 'aGVsbG8=',
              mimeType: 'image/png',
              revisedPrompt: 'Recovered image',
              provider: 'openai',
              model: 'gpt-image-1',
              prompt: 'A recovered lighthouse',
            },
          }),
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    render(ImageSettings);

    await screen.findByAltText('Recovered image');
    await waitFor(() => {
      expect(sessionStorage.getItem('koryphaios-active-image-job-v1')).toBeNull();
    });
    expect(mocks.apiFetch).toHaveBeenCalledWith('/api/images/jobs/recover-completed');
    expect(mocks.apiFetch).toHaveBeenCalledWith('/api/images/history/history-1');
    expect(localStorage.length).toBe(0);
  });

  test('keeps a running job recoverable when the component unmounts', async () => {
    sessionStorage.setItem(
      'koryphaios-active-image-job-v1',
      JSON.stringify({ jobId: 'recover-running', expiresAt: Date.now() + 60_000 }),
    );
    mocks.apiFetch.mockImplementation((url: string) => {
      if (url === '/api/images/providers') return Promise.resolve(configuredProvidersResponse());
      if (url === '/api/images/history?limit=12') return Promise.resolve(response({ ok: true, data: [] }));
      if (url === '/api/images/jobs/recover-running') {
        return Promise.resolve(response({ ok: true, data: { status: 'running' } }));
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const view = render(ImageSettings);
    await waitFor(() => {
      expect(mocks.apiFetch).toHaveBeenCalledWith('/api/images/jobs/recover-running');
    });
    view.unmount();

    expect(sessionStorage.getItem('koryphaios-active-image-job-v1')).toContain('recover-running');
  });

  test('allows an explicitly cancelled recovered job to be removed', async () => {
    sessionStorage.setItem(
      'koryphaios-active-image-job-v1',
      JSON.stringify({ jobId: 'recover-cancel', expiresAt: Date.now() + 60_000 }),
    );
    mocks.apiFetch.mockImplementation((url: string) => {
      if (url === '/api/images/providers') return Promise.resolve(configuredProvidersResponse());
      if (url === '/api/images/history?limit=12') return Promise.resolve(response({ ok: true, data: [] }));
      if (url === '/api/images/jobs/recover-cancel') {
        return Promise.resolve(response({ ok: true, data: { status: 'running' } }));
      }
      if (url === '/api/images/jobs/recover-cancel/cancel') {
        return Promise.resolve(response({ ok: true, data: { cancelled: true } }));
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    render(ImageSettings);
    const cancel = await screen.findByRole('button', { name: 'Cancel generation' });
    await fireEvent.click(cancel);

    await waitFor(() => {
      expect(sessionStorage.getItem('koryphaios-active-image-job-v1')).toBeNull();
    });
    expect(mocks.apiFetch).toHaveBeenCalledWith(
      '/api/images/jobs/recover-cancel/cancel',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
