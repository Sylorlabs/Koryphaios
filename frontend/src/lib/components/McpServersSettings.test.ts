import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/svelte';

const loadAll = vi.fn();
const loadFeatured = vi.fn();
const searchRegistry = vi.fn();
const addServer = vi.fn();
const startAuthorization = vi.fn();
const completeAuthorization = vi.fn();
const cancelAuthorization = vi.fn();
const disconnectAuthorization = vi.fn();

/** Server list the mocked getters read, mutated per test. */
const serverState: { servers: Array<Record<string, unknown>> } = { servers: [] };
/** The backend's "cannot authorize automatically" signal, mutated per test. */
const blockerState: { value: { server: string; code: string; message: string } | null } = {
  value: null,
};

vi.mock('$lib/stores/mcp-servers.svelte', () => {
  const state = {
    servers: [] as Array<Record<string, unknown>>,
    loading: false,
    error: undefined as string | undefined,
    registryResults: [] as unknown[],
    registrySearching: false,
    registryError: undefined as string | undefined,
    registryNextCursor: null as string | null,
    registryQuery: '',
    featuredServers: [] as unknown[],
    featuredLoading: false,
    featuredError: undefined as string | undefined,
  };
  return {
    mcpServersStore: {
      get servers() {
        return serverState.servers;
      },
      get loading() {
        return state.loading;
      },
      get error() {
        return state.error;
      },
      get registryResults() {
        return state.registryResults;
      },
      get registrySearching() {
        return state.registrySearching;
      },
      get registryError() {
        return state.registryError;
      },
      get registryNextCursor() {
        return state.registryNextCursor;
      },
      get registryQuery() {
        return state.registryQuery;
      },
      set registryQuery(value: string) {
        state.registryQuery = value;
      },
      get featuredServers() {
        return state.featuredServers;
      },
      get featuredLoading() {
        return state.featuredLoading;
      },
      get featuredError() {
        return state.featuredError;
      },
      loadAll,
      loadFeatured,
      searchRegistry,
      addServer,
      startAuthorization,
      completeAuthorization,
      cancelAuthorization,
      disconnectAuthorization,
      get authorizingName() {
        return null;
      },
      get authBlocker() {
        return blockerState.value;
      },
      clearAuthBlocker(serverName: string): void {
        if (blockerState.value?.server === serverName) blockerState.value = null;
      },
      clearRegistry: vi.fn(),
      updateServer: vi.fn(),
      removeServer: vi.fn(),
      testServer: vi.fn(),
      reloadServer: vi.fn(),
      getEnvKeys: vi.fn(async () => []),
    },
  };
});

const McpServersSettings = (await import('./McpServersSettings.svelte')).default;

beforeEach(() => {
  vi.clearAllMocks();
  serverState.servers = [];
  blockerState.value = null;
});

const oauthServer = (oauth: Record<string, unknown>) => ({
  name: 'notion',
  transport: 'sse',
  connected: false,
  toolCount: 0,
  protocolVersion: 'unknown',
  configured: true,
  oauth,
});

describe('McpServersSettings empty state', () => {
  it('centers the empty state below the header instead of pinning it to the top-left', async () => {
    const { container } = render(McpServersSettings);

    const heading = await screen.findByRole('heading', { name: /no servers configured/i });
    const emptyState = heading.closest('section');
    expect(emptyState).not.toBeNull();

    // Horizontal centring: the block itself centres its children and its text.
    const classes = emptyState!.className;
    expect(classes).toContain('items-center');
    expect(classes).toContain('text-center');

    // Anchored near the top of the scroll area, not floated into the middle of
    // a tall empty viewport: bounded top padding, no full-height flex growth.
    expect(classes).toContain('py-12');
    expect(classes).not.toContain('min-h-screen');
    expect(classes).not.toContain('flex-1');
    expect(classes).not.toContain('justify-center');

    // It is not a bare one-line paragraph any more.
    expect(container.textContent).not.toContain('No servers configured.');
  });

  it('explains what an MCP server is for and offers both ways to add one', async () => {
    render(McpServersSettings);

    await screen.findByRole('heading', { name: /no servers configured/i });
    expect(screen.getByText(/give agents access to external/i)).toBeTruthy();

    // Two entry points, matching the header actions.
    const browse = screen.getAllByRole('button', { name: /browse registry/i });
    expect(browse.length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByRole('button', { name: /add manually/i }).length).toBeGreaterThanOrEqual(
      2,
    );
  });

  it('keeps the empty state out of the way once a server is connected', async () => {
    // Drive the mocked getter rather than redefining the property: the store is a
    // module singleton, so an Object.defineProperty here would leak into every
    // later test in this file.
    serverState.servers = [
      {
        name: 'release_registry',
        transport: 'stdio',
        connected: true,
        toolCount: 1,
        configured: true,
      },
    ];

    render(McpServersSettings);

    expect(await screen.findByText('release_registry')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: /no servers configured/i })).toBeNull();
  });
});

describe('McpServersSettings auth requirements', () => {
  const oauth = (extra: Record<string, unknown> = {}) => ({
    authorized: false,
    expired: false,
    refreshable: false,
    needsAuthorization: true,
    ...extra,
  });

  it('explains a first-time sign-in and offers Authorize', async () => {
    serverState.servers = [
      {
        name: 'notion',
        transport: 'sse',
        connected: false,
        toolCount: 0,
        configured: true,
        oauth: oauth(),
        auth: {
          kind: 'oauth',
          label: 'Sign in with Notion',
          detail: 'Koryphaios opens Notion in your browser so you can approve access.',
        },
      },
    ];
    render(McpServersSettings);

    expect(await screen.findByText('Sign-in required')).toBeTruthy();
    // The user is told exactly what will happen before it happens.
    expect(screen.getByText(/opens Notion in your browser/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /authorize/i })).toBeTruthy();
  });

  it('hides the panel entirely once authorized and offers Disconnect', async () => {
    serverState.servers = [
      {
        name: 'notion',
        transport: 'sse',
        connected: true,
        toolCount: 4,
        configured: true,
        oauth: oauth({ authorized: true, needsAuthorization: false, scope: 'default' }),
        auth: { kind: 'oauth', label: 'Sign in with Notion', detail: 'not needed' },
      },
    ];
    render(McpServersSettings);

    expect(await screen.findByRole('button', { name: /disconnect/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^authorize$/i })).toBeNull();
    expect(screen.queryByText('Sign-in required')).toBeNull();
    expect(screen.getByText(/authorized/)).toBeTruthy();
  });

  it('asks for a header credential instead of a browser sign-in', async () => {
    serverState.servers = [
      {
        name: 'github',
        transport: 'sse',
        connected: false,
        toolCount: 0,
        configured: true,
        oauth: oauth(),
        auth: {
          kind: 'headers',
          label: 'Needs a credential',
          detail: 'Paste your GitHub credential into the Authorization header.',
        },
      },
    ];
    render(McpServersSettings);

    expect(await screen.findByText('Credential required')).toBeTruthy();
    expect(screen.getByText(/Paste your GitHub credential/i)).toBeTruthy();
    // A token server must not send the user to a browser that will not help.
    expect(screen.queryByRole('button', { name: /^authorize$/i })).toBeNull();
    expect(screen.getByRole('button', { name: /add credential/i })).toBeTruthy();
  });

  it('flags a hand-added remote server that has no credential at all', async () => {
    serverState.servers = [
      {
        name: 'mystery',
        transport: 'sse',
        connected: false,
        toolCount: 0,
        configured: true,
        oauth: oauth(),
        auth: {
          kind: 'unknown',
          label: 'Sign-in required',
          detail: 'This remote server was added without any credential.',
        },
      },
    ];
    render(McpServersSettings);

    expect(await screen.findByText('Sign-in required')).toBeTruthy();
    expect(screen.getByText(/added without any credential/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /configure headers/i })).toBeTruthy();
  });

  it('offers the app-credential form for a server that needs its own app', async () => {
    serverState.servers = [
      {
        name: 'slack',
        transport: 'sse',
        connected: false,
        toolCount: 0,
        configured: true,
        oauth: oauth(),
        auth: {
          kind: 'manual',
          label: 'Needs your own Slack app',
          detail:
            'Slack does not let apps register automatically. Create your own app, then enter its client ID and client secret.',
        },
      },
    ];
    render(McpServersSettings);

    // Before discovery has run, the panel is classified but no credential form.
    expect(await screen.findByText('Needs your own app')).toBeTruthy();
    expect(screen.getByRole('button', { name: /enter app credentials/i })).toBeTruthy();

    const { fireEvent } = await import('@testing-library/svelte');
    await fireEvent.click(screen.getByRole('button', { name: /enter app credentials/i }));

    // The form asks for both fields and explains where the values go.
    expect(await screen.findByLabelText('Client ID')).toBeTruthy();
    expect(screen.getByLabelText('Client secret (optional)')).toBeTruthy();
    expect(screen.getByText(/never in your project config/i)).toBeTruthy();
  });

  it('refuses to start a manual flow without a client ID', async () => {
    serverState.servers = [
      {
        name: 'slack',
        transport: 'sse',
        connected: false,
        toolCount: 0,
        configured: true,
        oauth: oauth(),
        auth: { kind: 'manual', label: 'Bring your own app', detail: 'needs your own app' },
      },
    ];
    render(McpServersSettings);

    const { fireEvent } = await import('@testing-library/svelte');
    await fireEvent.click(await screen.findByRole('button', { name: /enter app credentials/i }));
    await fireEvent.click(screen.getByRole('button', { name: /^authorize$/i }));

    expect(await screen.findByText(/Enter the client ID/i)).toBeTruthy();
    expect(startAuthorization).not.toHaveBeenCalled();
  });

  it('sends the entered app credentials when starting a manual flow', async () => {
    startAuthorization.mockResolvedValue('https://slack.com/oauth/v2_user/authorize');
    completeAuthorization.mockResolvedValue(false);

    serverState.servers = [
      {
        name: 'slack',
        transport: 'sse',
        connected: false,
        toolCount: 0,
        configured: true,
        oauth: oauth(),
        auth: { kind: 'manual', label: 'Bring your own app', detail: 'needs your own app' },
      },
    ];
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    render(McpServersSettings);

    const { fireEvent } = await import('@testing-library/svelte');
    await fireEvent.click(await screen.findByRole('button', { name: /enter app credentials/i }));
    // Svelte's bind:value needs the native setter plus an input event.
    const setValue = async (input: HTMLInputElement, value: string) => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      )!.set!;
      setter.call(input, value);
      await fireEvent.input(input);
    };
    await setValue(screen.getByLabelText('Client ID') as HTMLInputElement, '123.abc');
    await setValue(screen.getByLabelText('Client secret (optional)') as HTMLInputElement, 'shh');
    await fireEvent.click(screen.getByRole('button', { name: /^authorize$/i }));

    await vi.waitFor(() => {
      expect(startAuthorization).toHaveBeenCalledWith('slack', {
        clientId: '123.abc',
        clientSecret: 'shh',
      });
    });
    expect(openSpy).toHaveBeenCalled();
    openSpy.mockRestore();
  });

  it('never offers OAuth for a local stdio server', async () => {
    serverState.servers = [
      {
        name: 'local',
        transport: 'stdio',
        connected: true,
        toolCount: 3,
        configured: true,
        oauth: oauth(),
        auth: { kind: 'env', label: 'Needs a key', detail: 'Enter BRAVE_API_KEY.' },
      },
    ];
    render(McpServersSettings);

    expect(await screen.findByText('local')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^authorize$/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /disconnect/i })).toBeNull();
    expect(screen.queryByText('Needs a key')).toBeNull();
  });

  it('opens the provider URL in a new tab when Authorize is clicked', async () => {
    serverState.servers = [
      {
        name: 'notion',
        transport: 'sse',
        connected: false,
        toolCount: 0,
        configured: true,
        oauth: oauth(),
        auth: { kind: 'oauth', label: 'Sign in with Notion', detail: 'opens Notion' },
      },
    ];
    startAuthorization.mockResolvedValue('https://mcp.notion.com/authorize?x=1');
    completeAuthorization.mockResolvedValue(false);

    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    const { fireEvent } = await import('@testing-library/svelte');
    render(McpServersSettings);

    await fireEvent.click(await screen.findByRole('button', { name: /authorize/i }));

    expect(startAuthorization).toHaveBeenCalledWith('notion', undefined);
    expect(openSpy).toHaveBeenCalledWith(
      'https://mcp.notion.com/authorize?x=1',
      '_blank',
      'noopener,noreferrer',
    );
    openSpy.mockRestore();
  });

  it('disconnects through the backend when Disconnect is clicked', async () => {
    serverState.servers = [
      {
        name: 'notion',
        transport: 'sse',
        connected: true,
        toolCount: 2,
        configured: true,
        oauth: oauth({ authorized: true, needsAuthorization: false, refreshable: true }),
        auth: { kind: 'oauth', label: 'Sign in with Notion', detail: 'not needed' },
      },
    ];
    disconnectAuthorization.mockResolvedValue(true);
    const { fireEvent } = await import('@testing-library/svelte');
    render(McpServersSettings);

    await fireEvent.click(await screen.findByRole('button', { name: /disconnect/i }));
    expect(disconnectAuthorization).toHaveBeenCalledWith('notion');
  });
});
