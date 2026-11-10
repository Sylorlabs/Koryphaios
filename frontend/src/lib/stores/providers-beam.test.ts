import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { apiFetch, toastStore } = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  toastStore: { success: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

vi.mock('$lib/api.svelte', () => ({
  apiFetch,
  parseJsonResponse: async <T>(response: Response): Promise<T> => response.json() as Promise<T>,
}));
vi.mock('./toast.svelte', () => ({ toastStore }));
vi.mock('@tauri-apps/plugin-shell', () => ({ open: vi.fn() }));

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Backend-owned metadata: exercise the generic settings contract without
// registering a provider or duplicating its endpoint configuration in the UI.
function beamStatus(verified = false) {
  return {
    name: 'beam',
    label: 'Beam (Reflection AI)',
    authMode: 'api_key',
    supportsApiKey: true,
    supportsAuthToken: false,
    requiresBaseUrl: true,
    baseUrlPlaceholder: 'https://api.reflection.ai/openai/v1',
    endpointUrl: 'https://api.reflection.ai/openai/v1',
    credentialUrl: 'https://platform.reflection.ai/api-keys',
    iconPath: '/provider-icons/reflection.svg',
    enabled: verified,
    authenticated: verified,
    credentialDetected: verified,
    connectionState: verified ? 'verified' : 'not_configured',
    models: [],
    allAvailableModels: [],
  };
}

describe('Beam generic API-key settings flow', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    apiFetch.mockReset();
    sessionStorage.clear();
    localStorage.clear();
  });

  afterEach(async () => {
    const { providersStore } = await import('./providers.svelte');
    providersStore.destroy();
  });

  it('uses the canonical Reflection AI fallback label and API-key controls before status arrives', async () => {
    apiFetch.mockResolvedValue(json({ ok: true, data: [{ name: 'beam', authMode: 'api_key' }] }));
    const { providersStore } = await import('./providers.svelte');
    await providersStore.loadAvailableProviders();

    expect(providersStore.providerList).toContainEqual(expect.objectContaining({
      key: 'beam', label: 'Reflection AI', needsUrl: false,
    }));
    expect(providersStore.getProviderDisplayLabel('beam')).toBe('Reflection AI');
    expect(providersStore.getProviderCaps('beam')).toMatchObject({
      authMode: 'api_key', supportsApiKey: true, supportsAuthToken: false,
      requiresBaseUrl: false, requiresDeployment: false,
    });
    expect(providersStore.usesBrowserAuth('beam')).toBe(false);
    expect(providersStore.usesLocalCliConnection('beam')).toBe(false);
  });

  it('loads the backend label, official key-page link, and icon for settings', async () => {
    apiFetch.mockImplementation(() => Promise.resolve(json({ ok: true, data: [beamStatus()] })));
    const { providersStore } = await import('./providers.svelte');
    await providersStore.loadProvidersFromApi();

    expect(providersStore.getProviderStatus('beam')).toMatchObject({
      label: 'Beam (Reflection AI)',
      credentialUrl: 'https://platform.reflection.ai/api-keys',
      iconPath: '/provider-icons/reflection.svg',
    });
    expect(providersStore.getProviderCaps('beam')).toMatchObject({
      supportsApiKey: true, supportsAuthToken: false, requiresBaseUrl: true,
      baseUrlPlaceholder: 'https://api.reflection.ai/openai/v1',
    });
  });

  it('rejects an empty API key before sending a request', async () => {
    const { providersStore } = await import('./providers.svelte');
    providersStore.keyInputs = { beam: '   ' };
    expect(await providersStore.connectProvider('beam')).toEqual({ ok: false });
    expect(apiFetch).not.toHaveBeenCalled();
    expect(toastStore.error).toHaveBeenCalledWith('Enter API key');
  });

  it('submits the trimmed key through generic connect and clears it after verification', async () => {
    apiFetch.mockImplementation((_url: string, init?: RequestInit) => Promise.resolve(
      json(init?.method === 'PUT' ? { ok: true } : { ok: true, data: [beamStatus(true)] }),
    ));
    const { providersStore } = await import('./providers.svelte');
    providersStore.keyInputs = { beam: '  test-reflection-key  ' };

    expect(await providersStore.connectProvider('beam')).toMatchObject({
      ok: true, status: { name: 'beam', connectionState: 'verified' },
    });
    expect(apiFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/providers/beam'),
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ apiKey: 'test-reflection-key' }) }),
      undefined,
    );
    expect(providersStore.keyInputs.beam).toBe('');
    expect(toastStore.success).toHaveBeenCalledWith('Beam (Reflection AI) credential verified');
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it('shows a failed connection without discarding the entered key', async () => {
    apiFetch.mockResolvedValue(json({ ok: false, error: 'Invalid Reflection API key' }, 401));
    const { providersStore } = await import('./providers.svelte');
    providersStore.keyInputs = { beam: 'test-invalid-key' };

    expect(await providersStore.connectProvider('beam')).toEqual({ ok: false });
    expect(providersStore.connectErrors.beam).toBe('Invalid Reflection API key');
    expect(providersStore.keyInputs.beam).toBe('test-invalid-key');
    expect(providersStore.saving).toBeNull();
    expect(providersStore.verifying).toBeNull();
    expect(toastStore.error).toHaveBeenCalledWith('Invalid Reflection API key');
  });

  it('submits an endpoint override alongside the key using the existing URL input', async () => {
    apiFetch.mockImplementation((_url: string, init?: RequestInit) => Promise.resolve(
      json(init?.method === 'PUT' ? { ok: true } : { ok: true, data: [beamStatus(true)] }),
    ));
    const { providersStore } = await import('./providers.svelte');
    await providersStore.loadProvidersFromApi();
    providersStore.keyInputs = { beam: 'test-reflection-key' };
    providersStore.urlInputs = { beam: ' https://reflection-proxy.example/openai/v1 ' };

    expect((await providersStore.connectProvider('beam')).ok).toBe(true);
    expect(apiFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/providers/beam'),
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({
          apiKey: 'test-reflection-key', baseUrl: 'https://reflection-proxy.example/openai/v1',
        }),
      }),
      undefined,
    );
    expect(providersStore.urlInputs.beam).toBe('');
  });
});
