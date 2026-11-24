import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { projectStore } from '$lib/stores/project.svelte';
import ProjectIdentitySettings from './ProjectIdentitySettings.svelte';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('$lib/api.svelte', () => ({
  apiFetch: mocks.apiFetch,
  parseJsonResponse: async (response: { json(): Promise<unknown> }) => response.json(),
}));
vi.mock('$lib/utils/api-url', () => ({ apiUrl: (path: string) => `http://backend.test${path}` }));
vi.mock('./CustomProviderIconEditor.svelte', async () => ({
  default: (await import('./__fixtures__/StubProjectIconEditor.svelte')).default,
}));

type StoredIdentity = {
  id: string;
  name: string;
  icon: Record<string, unknown>;
  assetUrl?: string;
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function requestProject(init?: RequestInit): string | undefined {
  const headers = init?.headers as Record<string, string> | undefined;
  return headers?.['X-Koryphaios-Project'];
}

function seedWorkspace(paths: string[], selected = paths[0]) {
  projectStore.reconcile({
    workspaceRoot: '/workspace',
    selectedProject: selected,
    projects: paths.map((path) => ({
      path,
      name: path.split('/').pop() ?? path,
      modifiedAt: 0,
    })),
    revision: '1',
    unavailableWorkspace: null,
    unavailableProject: null,
  });
}

function mockBackend(identities: Record<string, StoredIdentity>) {
  mocks.apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    const path = requestProject(init) ?? '';
    const stored = identities[path] ?? {
      id: `id-${path}`,
      name: path.split('/').pop() ?? 'Project',
      icon: { mode: 'automatic' },
    };
    const method = init?.method ?? 'GET';
    if (url.endsWith('/project-identity')) {
      if (method === 'GET') {
        return jsonResponse({
          ok: true,
          data: { ...stored, revision: 7 },
        });
      }
      if (method === 'PUT') {
        const patch = JSON.parse(String(init?.body));
        return jsonResponse({
          ok: true,
          data: {
            ...stored,
            name: patch.name ?? stored.name,
            icon: patch.icon ?? stored.icon,
            revision: 8,
          },
        });
      }
      if (method === 'DELETE') {
        return jsonResponse({
          ok: true,
          data: { ...stored, icon: { mode: 'automatic' }, revision: 8 },
        });
      }
    }
    if (url.endsWith('/project-icon') && method === 'POST') {
      return jsonResponse({
        ok: true,
        data: {
          id: stored.id,
          name: stored.name,
          icon: { mode: 'image', assetId: 'asset_new' },
          assetUrl: '/api/workspace/project-icon/asset_new',
          revision: 8,
        },
      });
    }
    return jsonResponse({ ok: false, error: 'not found' }, 404);
  });
}

function calls(method: string, urlEndsWith?: string) {
  return mocks.apiFetch.mock.calls.filter(([url, init]) => {
    if ((init?.method ?? 'GET') !== method) return false;
    return urlEndsWith ? String(url).endsWith(urlEndsWith) : true;
  });
}

describe('ProjectIdentitySettings', () => {
  beforeEach(() => {
    mocks.apiFetch.mockReset();
    projectStore.clearWorkspace();
  });
  afterEach(() => cleanup());

  it('lists every workspace project in the project picker', async () => {
    mockBackend({});
    seedWorkspace(['/workspace/alpha', '/workspace/beta', '/workspace/gamma']);
    render(ProjectIdentitySettings);
    await screen.findByDisplayValue('alpha');

    await fireEvent.click(screen.getByRole('combobox', { name: 'Project' }));
    const listbox = await screen.findByRole('listbox', { name: 'Project' });
    for (const label of ['alpha', 'beta', 'gamma']) {
      expect(within(listbox).getByText(label)).toBeInTheDocument();
    }
  });

  it('edits another workspace project without switching the active project', async () => {
    mockBackend({});
    seedWorkspace(['/workspace/alpha', '/workspace/beta'], '/workspace/alpha');
    render(ProjectIdentitySettings);
    await waitFor(() =>
      expect(mocks.apiFetch).toHaveBeenCalledWith(
        'http://backend.test/api/workspace/project-identity',
        expect.objectContaining({
          headers: expect.objectContaining({ 'X-Koryphaios-Project': '/workspace/alpha' }),
        }),
      ),
    );
    await screen.findByDisplayValue('alpha');

    await fireEvent.click(screen.getByRole('combobox', { name: 'Project' }));
    await fireEvent.click(await screen.findByRole('option', { name: /beta/iu }));
    await screen.findByDisplayValue('beta');

    await waitFor(() =>
      expect(mocks.apiFetch).toHaveBeenCalledWith(
        'http://backend.test/api/workspace/project-identity',
        expect.objectContaining({
          headers: expect.objectContaining({ 'X-Koryphaios-Project': '/workspace/beta' }),
        }),
      ),
    );
    expect(projectStore.currentPath).toBe('/workspace/alpha');
  });

  it('ignores a stale identity response after the selection moves on', async () => {
    const paths = ['/workspace/alpha', '/workspace/beta', '/workspace/gamma'];
    const pending: Array<{ path: string; resolve: (response: Response) => void }> = [];
    mocks.apiFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).endsWith('/project-identity') && (init?.method ?? 'GET') === 'GET') {
        return new Promise<Response>((resolvePromise) => {
          pending.push({ path: requestProject(init) ?? '', resolve: resolvePromise });
        });
      }
      return Promise.resolve(jsonResponse({ ok: false, error: 'not found' }, 404));
    });
    seedWorkspace(paths, '/workspace/alpha');
    render(ProjectIdentitySettings);
    await waitFor(() => expect(pending).toHaveLength(1));
    pending[0].resolve(
      jsonResponse({
        ok: true,
        data: { id: 'a', name: 'Alpha', icon: { mode: 'automatic' }, revision: 1 },
      }),
    );
    await screen.findByDisplayValue('Alpha');

    const snapshot = (selectedProject: string) => ({
      workspaceRoot: '/workspace',
      selectedProject,
      projects: paths.map((path) => ({
        path,
        name: path.split('/').pop() ?? path,
        modifiedAt: 0,
      })),
      revision: '2',
      unavailableWorkspace: null,
      unavailableProject: null,
    });
    projectStore.reconcile(snapshot('/workspace/beta'));
    await waitFor(() => expect(pending).toHaveLength(2));
    projectStore.reconcile(snapshot('/workspace/gamma'));
    await waitFor(() => expect(pending).toHaveLength(3));

    const forPath = (path: string) => pending.find((entry) => entry.path === path)!;
    forPath('/workspace/gamma').resolve(
      jsonResponse({
        ok: true,
        data: { id: 'g', name: 'Gamma', icon: { mode: 'automatic' }, revision: 1 },
      }),
    );
    await screen.findByDisplayValue('Gamma');

    // The earlier project's slower response must not overwrite the form.
    forPath('/workspace/beta').resolve(
      jsonResponse({
        ok: true,
        data: { id: 'b', name: 'Beta', icon: { mode: 'automatic' }, revision: 1 },
      }),
    );
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    expect(screen.queryByDisplayValue('Beta')).toBeNull();
    expect(screen.getByDisplayValue('Gamma')).toBeInTheDocument();
  });

  it('keeps letters and image state separate across style switches', async () => {
    mockBackend({
      '/workspace/alpha': { id: 'a', name: 'Alpha', icon: { mode: 'monogram', value: 'AL' } },
    });
    seedWorkspace(['/workspace/alpha']);
    render(ProjectIdentitySettings);

    const letters = await screen.findByRole('textbox', { name: 'Letters & emoji' });
    await waitFor(() => expect(letters).toHaveValue('AL'));
    await fireEvent.click(screen.getByRole('button', { name: 'Image' }));
    expect(screen.queryByRole('textbox', { name: 'Letters & emoji' })).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'Custom' }));
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Letters & emoji' })).toHaveValue('AL'),
    );
  });

  it('never puts a stored asset id into the letters field', async () => {
    mockBackend({
      '/workspace/alpha': {
        id: 'a',
        name: 'Alpha',
        icon: { mode: 'image', assetId: 'opaque_asset_1' },
        assetUrl: '/api/workspace/project-icon/opaque_asset_1',
      },
    });
    seedWorkspace(['/workspace/alpha']);
    render(ProjectIdentitySettings);

    await screen.findByTestId('stub-icon-editor');
    await fireEvent.click(screen.getByRole('button', { name: 'Custom' }));
    const letters = await screen.findByRole<HTMLInputElement>('textbox', {
      name: 'Letters & emoji',
    });
    await waitFor(() => expect(letters.value.length).toBeGreaterThan(0));
    expect(letters.value).not.toBe('opaque_asset_1');
  });

  it('stages crop output locally and uploads exactly once on save', async () => {
    mockBackend({
      '/workspace/alpha': {
        id: 'a',
        name: 'Alpha',
        icon: { mode: 'image', assetId: 'asset_old' },
        assetUrl: '/api/workspace/project-icon/asset_old',
      },
    });
    seedWorkspace(['/workspace/alpha']);
    render(ProjectIdentitySettings);

    const crop = await screen.findByTestId('stub-crop-change');
    await fireEvent.click(crop);
    await fireEvent.click(crop);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled());
    expect(calls('POST', '/project-icon')).toHaveLength(0);

    await fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(calls('POST', '/project-icon')).toHaveLength(1));
    expect(calls('POST', '/project-icon')[0][1]?.body).toBeInstanceOf(FormData);
    // The name was untouched, so no second write should follow the upload.
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    expect(calls('PUT', '/project-identity')).toHaveLength(0);
  });

  it('never renders the word Automatic or the old mode pill', async () => {
    mockBackend({});
    seedWorkspace(['/workspace/alpha']);
    const { container } = render(ProjectIdentitySettings);
    await waitFor(() => expect(mocks.apiFetch).toHaveBeenCalled());
    expect(container.textContent).not.toContain('Automatic');
    expect(container.textContent).not.toMatch(/Live preview/iu);
  });

  it('renders a color swatch for every color option', async () => {
    mockBackend({});
    seedWorkspace(['/workspace/alpha']);
    render(ProjectIdentitySettings);
    await screen.findByDisplayValue('alpha');

    await fireEvent.click(screen.getByRole('combobox', { name: 'Color' }));
    const listbox = await screen.findByRole('listbox', { name: 'Color' });
    // "Project color", seven theme tokens, and "Custom" each get a swatch.
    expect(listbox.querySelectorAll('[data-testid="color-swatch"]')).toHaveLength(9);
  });

  it('disables Save until something changes', async () => {
    mockBackend({});
    seedWorkspace(['/workspace/alpha']);
    render(ProjectIdentitySettings);

    const saveButton = await screen.findByRole('button', { name: 'Save changes' });
    await screen.findByDisplayValue('alpha');
    expect(saveButton).toBeDisabled();

    await fireEvent.input(screen.getByRole('textbox', { name: 'Display name' }), {
      target: { value: 'Alpha renamed' },
    });
    expect(saveButton).toBeEnabled();
  });

  it('saves a square shape through the identity PUT', async () => {
    mockBackend({});
    seedWorkspace(['/workspace/alpha']);
    render(ProjectIdentitySettings);
    await screen.findByDisplayValue('alpha');

    await fireEvent.click(screen.getByRole('button', { name: 'Square' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(calls('PUT', '/project-identity')).toHaveLength(1));
    const patch = JSON.parse(String(calls('PUT', '/project-identity')[0][1]?.body));
    expect(patch.icon.shape).toBe('square');
  });

  it('shows a square crop frame in image mode and POSTs the square shape', async () => {
    mockBackend({
      '/workspace/alpha': {
        id: 'a',
        name: 'Alpha',
        icon: { mode: 'image', assetId: 'asset_old' },
        assetUrl: '/api/workspace/project-icon/asset_old',
      },
    });
    seedWorkspace(['/workspace/alpha']);
    const { container } = render(ProjectIdentitySettings);
    await screen.findByTestId('stub-crop-change');

    await fireEvent.click(screen.getByRole('button', { name: 'Square' }));
    await waitFor(() =>
      expect(
        container
          .querySelector('[data-testid="stub-icon-editor"]')
          ?.getAttribute('data-frame-shape'),
      ).toBe('square'),
    );

    await fireEvent.click(screen.getByTestId('stub-crop-change'));
    // stageImageDraft reads the blob into a data URL asynchronously.
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 30));
    await fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(calls('POST', '/project-icon')).toHaveLength(1));
    const form = calls('POST', '/project-icon')[0][1]?.body as FormData;
    expect(form.get('shape')).toBe('square');
  });

  it('disables None for color-only tiles and resets a transparent shape', async () => {
    mockBackend({});
    seedWorkspace(['/workspace/alpha']);
    render(ProjectIdentitySettings);
    await screen.findByDisplayValue('alpha');

    await fireEvent.click(screen.getByRole('button', { name: 'None' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'None' })).toHaveAttribute('aria-pressed', 'true'),
    );

    await fireEvent.click(screen.getByRole('button', { name: 'Color only' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Rounded' })).toHaveAttribute(
        'aria-pressed',
        'true',
      ),
    );
    expect(screen.getByRole('button', { name: 'None' })).toBeDisabled();
    // The one-line notice explains the automatic switch.
    expect(screen.getByRole('status').textContent).toContain('switched to Rounded');
  });

  it('renders distinct content-tile previews including an image placeholder', async () => {
    mockBackend({});
    seedWorkspace(['/workspace/alpha']);
    render(ProjectIdentitySettings);
    await screen.findByDisplayValue('alpha');

    const imageTile = screen.getByRole('button', { name: 'Image' });
    // No uploaded image yet → the neutral placeholder glyph, not a letter.
    expect(imageTile.querySelector('img')).toBeNull();
    expect(imageTile.querySelector('svg')).not.toBeNull();

    const initials = screen.getByRole('button', { name: 'Initials' });
    const colorOnly = screen.getByRole('button', { name: 'Color only' });
    // Initials previews the project monogram; Color only previews a solid swatch.
    expect(initials.textContent).toContain('A');
    expect(colorOnly.textContent).not.toContain('A');
    expect(colorOnly.querySelector('[aria-hidden="true"]')).not.toBeNull();
  });

  it('saves None through the identity PUT', async () => {
    mockBackend({});
    seedWorkspace(['/workspace/alpha']);
    render(ProjectIdentitySettings);
    await screen.findByDisplayValue('alpha');

    await fireEvent.click(screen.getByRole('button', { name: 'None' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(calls('PUT', '/project-identity')).toHaveLength(1));
    const patch = JSON.parse(String(calls('PUT', '/project-identity')[0][1]?.body));
    expect(patch.icon.shape).toBe('transparent');
  });
});
