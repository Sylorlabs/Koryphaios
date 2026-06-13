import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
// Real model catalogs (these module paths are NOT mocked) so the stub Provider classes
// below expose the true catalogs — bun applies mock.module process-wide, so other test
// files (copilot-models, provider-conformance) would otherwise see empty model lists.
import { CopilotModels } from '../src/providers/models/copilot';
import { CodexModels } from '../src/providers/models/codex';

process.env.NODE_ENV = 'test';
process.env.SESSION_TOKEN_SECRET =
  process.env.SESSION_TOKEN_SECRET ?? 'test_only_not_for_production_aaaaaaaaaa';

const dbPath = `/tmp/koryphaios-provider-routes-${process.pid}.sqlite`;
process.env.DATABASE_URL = `sqlite://${dbPath}`;

const startCopilotDeviceAuthMock = mock(async () => ({
  deviceCode: 'device-code-123',
  userCode: 'ABCD-EFGH',
  verificationUri: 'https://github.com/login/device',
  verificationUriComplete: 'https://github.com/login/device?user_code=ABCD-EFGH',
  expiresIn: 900,
  interval: 5,
}));
const pollCopilotDeviceAuthMock = mock(async () => ({
  accessToken: 'gho_device_token',
}));
const startKimiCodeDeviceAuthMock = mock(async () => ({
  deviceCode: 'kimi-device-code-123',
  userCode: 'KIMI-5678',
  verificationUri: 'https://auth.kimi.com/device',
  verificationUriComplete: 'https://auth.kimi.com/device?user_code=KIMI-5678',
  expiresIn: 900,
  interval: 5,
}));
const pollKimiCodeDeviceAuthMock = mock(async () => ({
  accessToken: 'kimi-device-token',
  refreshToken: 'kimi-refresh-token',
  tokenType: 'Bearer',
  expiresIn: 3600,
  scope: 'openid profile',
}));
const startCodexDeviceAuthMock = mock(async () => ({
  deviceAuthId: 'codex-device-auth-id-123',
  userCode: 'WXYZ-1234',
  verificationUri: 'https://auth.openai.com/device',
  verificationUriComplete: 'https://auth.openai.com/device?user_code=WXYZ-1234',
  expiresIn: 900,
  interval: 5,
}));
const pollCodexDeviceAuthMock = mock(async () => ({
  accessToken: 'codex-device-token',
}));
const detectCodexAuthTokenMock = mock(() => null);
const resetCodexDeviceAuthSessionsMock = mock(() => {});
const clearCodexAuthStateMock = mock(() => {});
const clearKimiCodeAuthStateMock = mock(() => {});
const saveKimiCodeAuthStateMock = mock(() => {});
const createKimiCodeAuthMarkerMock = mock(() => 'oauth:kimicode:test-marker');

mock.module('../src/providers/copilot', () => ({
  CopilotProvider: class {
    readonly name = 'copilot';
    readonly config: Record<string, unknown>;
    constructor(config: Record<string, unknown>) {
      this.config = config;
    }
    isAvailable() {
      return !!this.config && !this.config.disabled;
    }
    listModels() {
      return CopilotModels;
    }
    async *streamResponse() {}
  },
  exchangeGitHubTokenForCopilotAsync: async () => 'gho_device_token',
  startCopilotDeviceAuth: startCopilotDeviceAuthMock,
  pollCopilotDeviceAuth: pollCopilotDeviceAuthMock,
}));

mock.module('../src/providers/kimicode-auth', () => ({
  startKimiCodeDeviceAuth: startKimiCodeDeviceAuthMock,
  pollKimiCodeDeviceAuth: pollKimiCodeDeviceAuthMock,
  clearKimiCodeAuthState: clearKimiCodeAuthStateMock,
  saveKimiCodeAuthState: saveKimiCodeAuthStateMock,
  createKimiCodeAuthMarker: createKimiCodeAuthMarkerMock,
  isKimiCodeAuthMarker: (value: string | null | undefined) =>
    typeof value === 'string' && value.startsWith('oauth:kimicode:'),
  loadKimiCodeAuthState: () => null,
  resolveKimiCodeAccessToken: async (value: string | null | undefined) => value ?? null,
}));

mock.module('../src/providers/codex', () => ({
  CodexProvider: class {
    readonly name = 'codex';
    readonly config: Record<string, unknown>;
    constructor(config: Record<string, unknown>) {
      this.config = config;
    }
    isAvailable() {
      return !!this.config && !this.config.disabled;
    }
    listModels() {
      return CodexModels;
    }
    async *streamResponse() {}
  },
  startCodexDeviceAuth: startCodexDeviceAuthMock,
  pollCodexDeviceAuth: pollCodexDeviceAuthMock,
  resetCodexDeviceAuthSessions: resetCodexDeviceAuthSessionsMock,
}));

mock.module('../src/providers/auth-utils', () => ({
  detectCodexAuthToken: detectCodexAuthTokenMock,
  clearCodexAuthState: clearCodexAuthStateMock,
  isCodexCLIAuthMarker: (value: string | null | undefined) => typeof value === 'string' && value.startsWith('cli:codex:'),
  createCodexCLIAuthMarker: () => `cli:codex:${Date.now()}`,
  detectClaudeCodeLogin: () => true,
  createClaudeCLIAuthMarker: () => `cli:claude:${Date.now()}`,
  detectGeminiCLIToken: () => null,
  clearCachedToken: () => {},
}));

const { initDb } = await import('../src/db');
const { providerRoutes } = await import('../src/routes/v1/providers');
const { setContext } = await import('../src/context');
const { localAuth } = await import('../src/auth/local-auth');
const { buildLocalBearerToken } = await import('../src/auth/local-route-auth');

type ProviderStatus = {
  name: string;
  enabled: boolean;
  authenticated: boolean;
  models: string[];
  allAvailableModels: string[];
  selectedModels: string[];
  hideModelSelector: boolean;
  authMode: string;
  supportsApiKey: boolean;
  supportsAuthToken: boolean;
  requiresBaseUrl: boolean;
  circuitOpen: boolean;
};

let providerStatus: ProviderStatus[];
let lastSetCredentials: { name: string; body: Record<string, unknown> } | null;

function authHeader(): Record<string, string> {
  return {
    Authorization: buildLocalBearerToken(localAuth.createSession(['*'])),
  };
}

async function request(
  path: string,
  init: RequestInit = {},
): Promise<{ response: Response; body: any }> {
  const response = await providerRoutes.handle(
    new Request(`http://localhost${path}`, {
      ...init,
      headers: {
        ...authHeader(),
        ...(init.headers ?? {}),
      },
    }),
  );
  const text = await response.text();
  return {
    response,
    body: text.trim() ? JSON.parse(text) : null,
  };
}

beforeAll(async () => {
  await initDb(dbPath);

  providerStatus = [
    {
      name: 'openai',
      enabled: false,
      authenticated: false,
      models: [],
      allAvailableModels: ['gpt-4.1', 'gpt-4.1-mini'],
      selectedModels: [],
      hideModelSelector: false,
      authMode: 'api_key',
      supportsApiKey: true,
      supportsAuthToken: false,
      requiresBaseUrl: false,
      circuitOpen: false,
    },
  ];
  lastSetCredentials = null;

  const providers = {
    getStatus: () => providerStatus,
    getAvailableProviderTypes: () => [{ name: 'openai', authMode: 'api_key' }],
    async setCredentials(name: string, body: Record<string, unknown>) {
      lastSetCredentials = { name, body };
      providerStatus = providerStatus.map((status) =>
        status.name === name
          ? {
              ...status,
              authenticated: true,
              enabled: true,
              selectedModels: Array.isArray(body.selectedModels)
                ? (body.selectedModels as string[])
                : status.selectedModels,
              hideModelSelector:
                typeof body.hideModelSelector === 'boolean'
                  ? body.hideModelSelector
                  : status.hideModelSelector,
            }
          : status,
      );
      return { success: true };
    },
    getConfigs: () => ({}),
    removeApiKey(name: string) {
      providerStatus = providerStatus.map((status) =>
        status.name === name ? { ...status, authenticated: false, enabled: false } : status,
      );
    },
  };

  setContext({
    config: {} as any,
    providers: providers as any,
    tools: {} as any,
    mcpManager: undefined as any,
    sessions: {} as any,
    messages: {} as any,
    tasks: {} as any,
    kory: {} as any,
    wsManager: {} as any,
  });
});

afterAll(() => {
  if (existsSync(dbPath)) rmSync(dbPath, { force: true });
  // Undo the process-wide module mocks so other test files (copilot-models,
  // provider-conformance) see the REAL codex/copilot/auth-utils modules.
  mock.restore();
});

describe('provider routes', () => {
  test('GET /api/providers returns provider status payload', async () => {
    const { response, body } = await request('/api/providers');

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data).toEqual(providerStatus);
  });

  test('PUT /api/providers/:name accepts model selection fields', async () => {
    const { response, body } = await request('/api/providers/openai', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apiKey: 'sk-live',
        selectedModels: ['gpt-4.1-mini'],
        hideModelSelector: true,
      }),
    });

    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(lastSetCredentials).toEqual({
      name: 'openai',
      body: {
        apiKey: 'sk-live',
        selectedModels: ['gpt-4.1-mini'],
        hideModelSelector: true,
      },
    });
  });

  test('saved provider accounts can be created, listed, activated, and deleted', async () => {
    const create = await request('/api/providers/openai/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        label: 'Backup OpenAI',
        apiKey: 'sk-backup',
        baseUrl: 'https://api.openai.com/v1',
      }),
    });

    expect(create.response.status).toBe(200);
    expect(create.body.ok).toBe(true);
    expect(create.body.data.account.label).toBe('Backup OpenAI');
    expect(create.body.data.account.hasApiKey).toBe(true);
    expect(create.body.data.account.hasBaseUrl).toBe(true);

    const accountId = create.body.data.account.id as string;

    const list = await request('/api/providers/openai/accounts');
    expect(list.response.status).toBe(200);
    expect(list.body.ok).toBe(true);
    expect(list.body.data.some((account: any) => account.id === accountId)).toBe(true);

    const activate = await request(`/api/providers/openai/accounts/${accountId}/activate`, {
      method: 'POST',
    });
    expect(activate.response.status).toBe(200);
    expect(activate.body.ok).toBe(true);
    expect(lastSetCredentials).toEqual({
      name: 'openai',
      body: {
        apiKey: 'sk-backup',
        baseUrl: 'https://api.openai.com/v1',
      },
    });

    const remove = await request(`/api/providers/openai/accounts/${accountId}`, {
      method: 'DELETE',
    });
    expect(remove.response.status).toBe(200);
    expect(remove.body).toEqual({ ok: true });

    const finalList = await request('/api/providers/openai/accounts');
    expect(finalList.body.data.some((account: any) => account.id === accountId)).toBe(false);
  });

  test('browser auth is only exposed for providers Koryphaios manages directly', async () => {
    const start = await request('/api/providers/anthropic/auth/start', {
      method: 'POST',
    });

    expect(start.response.status).toBe(404);
    expect(start.body.ok).toBe(false);

    // openai is an API-key provider (not a browser/OAuth-managed one) → no auth flow.
    // (google IS browser-auth managed, so it would not 404 here.)
    const complete = await request('/api/providers/openai/auth/complete', {
      method: 'POST',
    });

    expect(complete.response.status).toBe(404);
    expect(complete.body.ok).toBe(false);
  });

  test('Codex browser auth uses the device flow and activates on poll', async () => {
    const codexStart = await request('/api/providers/codex/auth/start', {
      method: 'POST',
    });
    expect(codexStart.response.status).toBe(200);
    expect(codexStart.body.ok).toBe(true);
    expect(codexStart.body.data.deviceAuthId).toBe('codex-device-auth-id-123');
    expect(codexStart.body.data.userCode).toBe('WXYZ-1234');
    expect(codexStart.body.data.verificationUri).toBe('https://auth.openai.com/device');

    const codexPoll = await request('/api/providers/codex/auth/poll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceAuthId: 'codex-device-auth-id-123',
        userCode: 'WXYZ-1234',
      }),
    });
    expect(codexPoll.response.status).toBe(200);
    expect(codexPoll.body.ok).toBe(true);
    expect(codexPoll.body.data.status).toBe('connected');
    expect(lastSetCredentials).toEqual({
      name: 'codex',
      body: {
        authToken: expect.stringMatching(/^cli:codex:\d+$/),
      },
    });
  });

  test('Copilot browser auth returns device flow details and activates on poll', async () => {
    const start = await request('/api/providers/copilot/auth/start', {
      method: 'POST',
    });

    expect(start.response.status).toBe(200);
    expect(start.body.ok).toBe(true);
    expect(start.body.data.userCode).toBe('ABCD-EFGH');
    expect(start.body.data.verificationUriComplete).toContain('github.com/login/device');

    const poll = await request('/api/providers/copilot/auth/poll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceCode: 'device-code-123' }),
    });

    expect(poll.response.status).toBe(200);
    expect(poll.body.ok).toBe(true);
    expect(poll.body.data.status).toBe('connected');
    expect(lastSetCredentials).toEqual({
      name: 'copilot',
      body: {
        authToken: 'gho_device_token',
      },
    });
  });

  test('Kimi Code browser auth uses the official device flow and activates on poll', async () => {
    const start = await request('/api/providers/kimicode/auth/start', {
      method: 'POST',
    });

    expect(start.response.status).toBe(200);
    expect(start.body.ok).toBe(true);
    expect(start.body.data.deviceCode).toBe('kimi-device-code-123');
    expect(start.body.data.userCode).toBe('KIMI-5678');
    expect(start.body.data.verificationUriComplete).toContain('auth.kimi.com');

    const poll = await request('/api/providers/kimicode/auth/poll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceCode: 'kimi-device-code-123' }),
    });

    expect(poll.response.status).toBe(200);
    expect(poll.body.ok).toBe(true);
    expect(poll.body.data.status).toBe('connected');
    expect(saveKimiCodeAuthStateMock).toHaveBeenCalled();
    expect(lastSetCredentials).toEqual({
      name: 'kimicode',
      body: {
        authToken: 'oauth:kimicode:test-marker',
      },
    });
  });
});
