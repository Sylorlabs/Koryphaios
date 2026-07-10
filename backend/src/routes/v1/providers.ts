import { eq } from 'drizzle-orm';
import { Elysia, t } from 'elysia';
import { getContext } from '../../context';
import { PROJECT_ROOT } from '../../runtime/paths';
import { syncProviderConfigsToConfig, removeProviderFromConfig } from '../../runtime/config';
import { customProviderId } from '../../providers/custom';
import type { ProviderName } from '@koryphaios/shared';
import { serverLog } from '../../logger';
import { requireLocalRouteAuth } from '../../auth/local-route-auth';
import { db, userCredentials } from '../../db';
import { createUserCredentialsService, type UserCredential } from '../../services';
import { pollCopilotDeviceAuth, startCopilotDeviceAuth } from '../../providers/copilot';
import {
  pollCodexDeviceAuth,
  resetCodexDeviceAuthSessions,
  startCodexDeviceAuth,
} from '../../providers/codex';
import {
  clearCodexAuthState,
  createCodexCLIAuthMarker,
  detectCodexAuthToken,
  detectClaudeCodeLogin,
  createClaudeCLIAuthMarker,
  detectGeminiCLIToken,
  clearCachedToken,
  detectGrokCLILogin,
  createGrokCLIAuthMarker,
  detectAntigravityCLILogin,
  createAntigravityCLIAuthMarker,
} from '../../providers/auth-utils';
import { detectAgentClis } from '../../providers/cli-detection';
import { googleAuth } from '../../providers/google-auth';
import {
  clearKimiCodeAuthState,
  createKimiCodeAuthMarker,
  pollKimiCodeDeviceAuth,
  saveKimiCodeAuthState,
  startKimiCodeDeviceAuth,
} from '../../providers/kimicode-auth';

const LOCAL_USER_ID = 'local-user';
const credentialsService = createUserCredentialsService();

type StoredProviderAccount = {
  id: string;
  provider: string;
  label: string;
  createdAt: number;
  updatedAt: number;
  hasApiKey: boolean;
  hasAuthToken: boolean;
  hasBaseUrl: boolean;
};

type StoredAccountMetadata = {
  accountId?: string;
  label?: string;
};

const providerConfigBody = t.Object({
  apiKey: t.Optional(t.String()),
  authToken: t.Optional(t.String()),
  baseUrl: t.Optional(t.String()),
  selectedModels: t.Optional(t.Array(t.String())),
  hideModelSelector: t.Optional(t.Boolean()),
});

type BrowserAuthProvider =
  | 'copilot'
  | 'codex'
  | 'kimicode'
  | 'claude'
  | 'grok'
  | 'antigravity'
  | 'google';
// NOTE: 'google-subscription' (the Gemini CLI) is RETIRED — never re-add it.
// Gemini models are served by the plain 'google' (Gemini API) provider.

function isBrowserAuthProvider(name: string): name is BrowserAuthProvider {
  return (
    name === 'copilot' ||
    name === 'codex' ||
    name === 'kimicode' ||
    name === 'claude' ||
    name === 'grok' ||
    name === 'antigravity' ||
    name === 'google'
  );
}

async function startBrowserAuth(
  name: BrowserAuthProvider,
): Promise<{ ok: boolean; data?: Record<string, unknown>; error?: string }> {
  try {
    serverLog.info({ provider: name }, 'Starting browser auth flow');
    switch (name) {
      case 'copilot': {
        const result = await startCopilotDeviceAuth();
        serverLog.info(
          {
            provider: name,
            deviceCode: result.deviceCode,
            verificationUri: result.verificationUri,
          },
          'Browser auth flow started',
        );
        return {
          ok: true,
          data: {
            provider: name,
            ...result,
          },
        };
      }
      case 'codex': {
        resetCodexDeviceAuthSessions();
        clearCodexAuthState();
        const result = await startCodexDeviceAuth();
        serverLog.info(
          {
            provider: name,
            deviceAuthId: result.deviceAuthId,
            userCode: result.userCode,
            verificationUri: result.verificationUri,
          },
          'Browser auth flow started',
        );
        return {
          ok: true,
          data: {
            provider: name,
            ...result,
          },
        };
      }
      case 'kimicode': {
        clearKimiCodeAuthState();
        const result = await startKimiCodeDeviceAuth();
        serverLog.info(
          {
            provider: name,
            userCode: result.userCode,
            verificationUri: result.verificationUri,
          },
          'Browser auth flow started',
        );
        return {
          ok: true,
          data: {
            provider: name,
            ...result,
          },
        };
      }
      case 'claude': {
        // Claude Code subscription connects through the official `claude` CLI harness.
        // We never store the raw OAuth token — only an opt-in marker; the CLI owns auth.
        if (detectClaudeCodeLogin()) {
          const { providers } = getContext();
          const setResult = await providers.setCredentials('claude', {
            authToken: createClaudeCLIAuthMarker(),
          });
          if (!setResult.success) {
            return { ok: false, error: setResult.error ?? 'Failed to activate Claude auth' };
          }
          syncProviderConfigsSafely(providers);
          serverLog.info({ provider: name }, 'Claude Code connected via CLI subscription');
          return {
            ok: true,
            data: {
              status: 'connected',
              provider: 'claude',
              message: 'Claude Code connected via your Claude subscription (CLI harness)',
            },
          };
        }
        serverLog.info({ provider: name }, 'No Claude CLI login detected');
        return {
          ok: true,
          data: {
            provider: 'claude',
            message: 'Run "claude login" in your terminal, then click Auth again to connect.',
          },
        };
      }
      case 'grok': {
        // Grok Build subscription — the official `grok` CLI owns auth (no token entry in UI).
        if (detectGrokCLILogin()) {
          const { providers } = getContext();
          const setResult = await providers.setCredentials('grok', {
            authToken: createGrokCLIAuthMarker(),
          });
          if (!setResult.success) {
            return { ok: false, error: setResult.error ?? 'Failed to activate Grok Build auth' };
          }
          syncProviderConfigsSafely(providers);
          serverLog.info({ provider: name }, 'Grok Build connected via CLI subscription');
          return {
            ok: true,
            data: {
              status: 'connected',
              provider: 'grok',
              message: 'Grok Build connected via your local grok CLI (subscription or xAI key)',
            },
          };
        }
        serverLog.info({ provider: name }, 'No Grok Build CLI login detected');
        return {
          ok: true,
          data: {
            provider: 'grok',
            message: 'Install the grok CLI and run "grok login", then click Auth again to connect.',
          },
        };
      }
      case 'antigravity': {
        if (detectAntigravityCLILogin()) {
          const { providers } = getContext();
          const setResult = await providers.setCredentials('antigravity', {
            authToken: createAntigravityCLIAuthMarker(),
          });
          if (!setResult.success) {
            return { ok: false, error: setResult.error ?? 'Failed to activate Antigravity auth' };
          }
          syncProviderConfigsSafely(providers);
          serverLog.info({ provider: name }, 'Antigravity connected via CLI');
          return {
            ok: true,
            data: {
              status: 'connected',
              provider: 'antigravity',
              message: 'Antigravity connected via your local agy CLI',
            },
          };
        }
        serverLog.info({ provider: name }, 'No Antigravity CLI login detected');
        return {
          ok: true,
          data: {
            provider: 'antigravity',
            message: 'Install the agy CLI and run "agy login", then click Auth again to connect.',
          },
        };
      }
      case 'google': {
        // Check for existing gcloud / Gemini CLI credentials
        clearCachedToken('gemini');
        const existingToken = detectGeminiCLIToken();
        if (existingToken) {
          const { providers } = getContext();
          const setResult = await providers.setCredentials('google', {
            authToken: existingToken,
          });
          if (!setResult.success) {
            return { ok: false, error: setResult.error ?? 'Failed to activate Google auth' };
          }
          syncProviderConfigsSafely(providers);
          serverLog.info({ provider: name }, 'Google auto-connected via CLI credentials');
          return {
            ok: true,
            data: {
              status: 'connected',
              provider: 'google',
              message: 'Google connected via existing gcloud credentials',
            },
          };
        }
        // Start gcloud ADC login flow
        const authResult = await googleAuth.startGeminiCLIAuth();
        if (authResult.success && authResult.url) {
          serverLog.info(
            { provider: name, url: authResult.url },
            'Google gcloud auth flow started',
          );
          return {
            ok: true,
            data: {
              provider: 'google',
              url: authResult.url,
              message: 'Complete Google sign-in in the browser, then click "I Finished Sign-In".',
            },
          };
        }
        if (authResult.success) {
          clearCachedToken('gemini');
          const freshToken = detectGeminiCLIToken();
          if (freshToken) {
            const { providers } = getContext();
            await providers.setCredentials('google', { authToken: freshToken });
            syncProviderConfigsSafely(providers);
          }
          return {
            ok: true,
            data: {
              status: 'connected',
              provider: 'google',
              message: authResult.message,
            },
          };
        }
        return {
          ok: false,
          error:
            authResult.message ||
            'Google Cloud SDK (gcloud) is required. Install it or enter an API key instead.',
        };
      }
    }
  } catch (error: any) {
    serverLog.error(
      { provider: name, error: error?.message ?? String(error) },
      'Failed to start browser auth flow',
    );
    return { ok: false, error: error?.message ?? 'Failed to start auth flow' };
  }
}

async function completeBrowserAuth(
  name: BrowserAuthProvider,
): Promise<{ ok: boolean; data?: Record<string, unknown>; error?: string }> {
  const { providers } = getContext();

  try {
    serverLog.info({ provider: name }, 'Completing browser auth flow');
    switch (name) {
      case 'codex': {
        const localCodexToken = detectCodexAuthToken();
        if (!localCodexToken) {
          serverLog.warn(
            { provider: name },
            'Codex browser auth completion requested before credentials existed',
          );
          return { ok: false, error: 'Codex sign-in is not complete yet' };
        }
        const codexMarker = createCodexCLIAuthMarker();
        const result = await providers.setCredentials('codex', {
          authToken: codexMarker,
        });
        if (!result.success) {
          return { ok: false, error: result.error ?? 'Failed to activate Codex auth' };
        }
        syncProviderConfigsSafely(providers);
        serverLog.info({ provider: name }, 'Browser auth flow completed');
        return { ok: true, data: { status: 'connected', provider: 'codex' } };
      }
      case 'claude': {
        clearCachedToken('claude-login');
        if (!detectClaudeCodeLogin()) {
          return {
            ok: false,
            error: 'Claude Code is not logged in. Run "claude login" in your terminal first.',
          };
        }
        const claudeResult = await providers.setCredentials('claude', {
          authToken: createClaudeCLIAuthMarker(),
        });
        if (!claudeResult.success) {
          return { ok: false, error: claudeResult.error ?? 'Failed to activate Claude auth' };
        }
        syncProviderConfigsSafely(providers);
        serverLog.info({ provider: name }, 'Claude Code auth completed');
        return { ok: true, data: { status: 'connected', provider: 'claude' } };
      }
      case 'grok': {
        if (!detectGrokCLILogin()) {
          return {
            ok: false,
            error: 'Grok Build CLI is not logged in. Install grok and run "grok login" first.',
          };
        }
        const grokResult = await providers.setCredentials('grok', {
          authToken: createGrokCLIAuthMarker(),
        });
        if (!grokResult.success) {
          return { ok: false, error: grokResult.error ?? 'Failed to activate Grok Build auth' };
        }
        syncProviderConfigsSafely(providers);
        serverLog.info({ provider: name }, 'Grok Build auth completed');
        return { ok: true, data: { status: 'connected', provider: 'grok' } };
      }
      case 'antigravity': {
        if (!detectAntigravityCLILogin()) {
          return {
            ok: false,
            error: 'Antigravity CLI is not logged in. Install agy and run "agy login" first.',
          };
        }
        const agyResult = await providers.setCredentials('antigravity', {
          authToken: createAntigravityCLIAuthMarker(),
        });
        if (!agyResult.success) {
          return { ok: false, error: agyResult.error ?? 'Failed to activate Antigravity auth' };
        }
        syncProviderConfigsSafely(providers);
        serverLog.info({ provider: name }, 'Antigravity auth completed');
        return { ok: true, data: { status: 'connected', provider: 'antigravity' } };
      }
      case 'google': {
        clearCachedToken('gemini');
        const token = detectGeminiCLIToken();
        if (!token) {
          return {
            ok: false,
            error: 'Google sign-in not complete yet. Finish authentication in the browser.',
          };
        }
        const googleResult = await providers.setCredentials('google', { authToken: token });
        if (!googleResult.success) {
          return { ok: false, error: googleResult.error ?? 'Failed to activate Google auth' };
        }
        syncProviderConfigsSafely(providers);
        serverLog.info({ provider: name }, 'Google auth completed');
        return { ok: true, data: { status: 'connected', provider: 'google' } };
      }
      case 'copilot':
      case 'kimicode':
        return { ok: false, error: `${name} auth completes automatically after browser approval` };
    }
  } catch (error: any) {
    serverLog.error(
      { provider: name, error: error?.message ?? String(error) },
      'Failed to complete browser auth flow',
    );
    return { ok: false, error: error?.message ?? 'Failed to complete auth flow' };
  }
}

function readStoredMetadata(credential: UserCredential): StoredAccountMetadata {
  if (credential.metadata && typeof credential.metadata === 'object') {
    return credential.metadata as StoredAccountMetadata;
  }
  return {};
}

function syncProviderConfigsSafely(providers: ReturnType<typeof getContext>['providers']): void {
  if (process.env.NODE_ENV === 'test') return;
  syncProviderConfigsToConfig(PROJECT_ROOT, providers.getConfigs());
}

function groupStoredAccounts(
  provider: string,
  credentials: UserCredential[],
): Array<StoredProviderAccount> {
  const grouped = new Map<
    string,
    {
      label: string;
      createdAt: number;
      updatedAt: number;
      hasApiKey: boolean;
      hasAuthToken: boolean;
      hasBaseUrl: boolean;
    }
  >();

  for (const credential of credentials) {
    const metadata = readStoredMetadata(credential);
    const accountId = metadata.accountId ?? credential.id;
    const existing = grouped.get(accountId) ?? {
      label: metadata.label?.trim() || `${provider} account`,
      createdAt: credential.createdAt,
      updatedAt: credential.lastUsedAt ?? credential.createdAt,
      hasApiKey: false,
      hasAuthToken: false,
      hasBaseUrl: false,
    };

    existing.createdAt = Math.min(existing.createdAt, credential.createdAt);
    existing.updatedAt = Math.max(
      existing.updatedAt,
      credential.lastUsedAt ?? credential.createdAt,
    );
    existing.hasApiKey = existing.hasApiKey || credential.type === 'apiKey';
    existing.hasAuthToken = existing.hasAuthToken || credential.type === 'authToken';
    existing.hasBaseUrl = existing.hasBaseUrl || credential.type === 'baseUrl';

    grouped.set(accountId, existing);
  }

  return [...grouped.entries()]
    .map(([id, account]) => ({
      id,
      provider,
      ...account,
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

async function listStoredAccounts(provider: string): Promise<Array<StoredProviderAccount>> {
  const credentials = await credentialsService.list(LOCAL_USER_ID, {
    provider,
    isActive: true,
  });
  return groupStoredAccounts(provider, credentials);
}

async function getStoredAccountBundle(
  provider: string,
  accountId: string,
): Promise<{
  account: StoredProviderAccount;
  values: { apiKey?: string; authToken?: string; baseUrl?: string };
} | null> {
  const credentials = await credentialsService.list(LOCAL_USER_ID, {
    provider,
    isActive: true,
  });
  const matching = credentials.filter((credential) => {
    const metadata = readStoredMetadata(credential);
    return (metadata.accountId ?? credential.id) === accountId;
  });

  if (matching.length === 0) return null;

  const values: { apiKey?: string; authToken?: string; baseUrl?: string } = {};
  for (const credential of matching) {
    const plaintext = await credentialsService.get(
      LOCAL_USER_ID,
      credential.id,
      'activate_provider_account',
    );
    if (!plaintext) continue;
    values[credential.type] = plaintext;
  }

  const [account] = groupStoredAccounts(provider, matching);
  return account ? { account, values } : null;
}

export const providerRoutes = new Elysia({ prefix: '/api/providers' })
  .get('/', async ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const { providers } = getContext();
    return {
      ok: true,
      data: providers.getStatus(),
    };
  })
  .get('/status', async ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const { providers } = getContext();
    return {
      ok: true,
      data: providers.getStatus(),
    };
  })
  .get('/available', async ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const { providers } = getContext();
    return {
      ok: true,
      data: providers.getAvailableProviderTypes(),
    };
  })
  // Agent-CLI auto-detection: which coding CLIs (Claude Code, Codex, Gemini, Grok, Cursor)
  // are installed + logged in on this machine, and which Koryphaios auto-enabled.
  .get('/detect', async ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    return {
      ok: true,
      data: detectAgentClis(),
    };
  })
  .post('/test-connected', async ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const { providers } = getContext();
    const connected = providers.getStatus().filter((provider) => provider.authenticated);
    const results = await Promise.all(
      connected.map(async (provider) => ({
        provider: provider.name,
        ...(await providers.testConnection(provider.name)),
      })),
    );
    return {
      ok: results.every((result) => result.ok),
      tested: results.length,
      results,
    };
  })
  // ─── Custom (bring-your-own) providers ──────────────────────────────────
  // Add an OpenAI-compatible (or Anthropic/Gemini-compatible) endpoint with a base URL,
  // optional API key, optional explicit model list, and optional custom headers.
  .post(
    '/custom',
    async ({ request, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      const label = body.label?.trim();
      const baseUrl = body.baseUrl?.trim();
      if (!label) {
        set.status = 400;
        return { ok: false, error: 'A display name is required' };
      }
      if (!baseUrl) {
        set.status = 400;
        return { ok: false, error: 'A base URL is required (e.g. https://api.example.com/v1)' };
      }
      const { providers } = getContext();
      const id = customProviderId(label);
      const result = providers.registerCustomProvider({
        id,
        label,
        kind: body.kind ?? 'openai',
        baseUrl,
        apiKey: body.apiKey?.trim() || undefined,
        authToken: body.authToken?.trim() || undefined,
        headers: body.headers,
        models: body.models?.map((m) => m.trim()).filter(Boolean),
      });
      if (!result.success) {
        set.status = 400;
        return { ok: false, error: result.error ?? 'Failed to add custom provider' };
      }
      syncProviderConfigsSafely(providers);
      serverLog.info({ provider: id, kind: body.kind ?? 'openai' }, 'Custom provider added');
      return { ok: true, data: { id, label, kind: body.kind ?? 'openai' } };
    },
    {
      body: t.Object({
        label: t.String(),
        kind: t.Optional(
          t.Union([t.Literal('openai'), t.Literal('anthropic'), t.Literal('gemini')]),
        ),
        baseUrl: t.String(),
        apiKey: t.Optional(t.String()),
        authToken: t.Optional(t.String()),
        models: t.Optional(t.Array(t.String())),
        headers: t.Optional(t.Record(t.String(), t.String())),
      }),
    },
  )
  .delete('/custom/:id', async ({ request, params: { id }, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const { providers } = getContext();
    providers.removeCustomProvider(id as ProviderName);
    if (process.env.NODE_ENV !== 'test') removeProviderFromConfig(PROJECT_ROOT, id);
    return { ok: true };
  })
  .post('/:name/auth/start', async ({ request, params: { name }, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    if (!isBrowserAuthProvider(name)) {
      set.status = 404;
      return { ok: false, error: 'Browser auth is not available for this provider' };
    }

    const result = await startBrowserAuth(name);
    if (!result.ok) {
      serverLog.warn({ provider: name, error: result.error }, 'Browser auth start request failed');
      set.status = 400;
      return { ok: false, error: result.error ?? 'Failed to start auth flow' };
    }

    return result;
  })
  .post('/:name/auth/complete', async ({ request, params: { name }, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    if (!isBrowserAuthProvider(name)) {
      set.status = 404;
      return { ok: false, error: 'Browser auth is not available for this provider' };
    }

    const result = await completeBrowserAuth(name);
    if (!result.ok) {
      serverLog.warn(
        { provider: name, error: result.error },
        'Browser auth completion request failed',
      );
      set.status = 400;
      return { ok: false, error: result.error ?? 'Failed to complete auth flow' };
    }

    return result;
  })
  .post(
    '/copilot/auth/poll',
    async ({ request, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };

      try {
        const poll = await pollCopilotDeviceAuth(body.deviceCode);
        if (poll.accessToken) {
          const { providers } = getContext();
          const result = await providers.setCredentials('copilot', { authToken: poll.accessToken });
          if (!result.success) {
            set.status = 400;
            return { ok: false, error: result.error ?? 'Failed to activate Copilot auth' };
          }
          syncProviderConfigsSafely(providers);
          return {
            ok: true,
            data: {
              status: 'connected',
              provider: 'copilot',
            },
          };
        }

        return {
          ok: true,
          data: {
            status: poll.error === 'authorization_pending' ? 'pending' : 'polling',
            provider: 'copilot',
            ...poll,
          },
        };
      } catch (error: any) {
        set.status = 400;
        return { ok: false, error: error?.message ?? 'Failed to poll Copilot auth' };
      }
    },
    {
      body: t.Object({
        deviceCode: t.String(),
      }),
    },
  )
  .post(
    '/codex/auth/poll',
    async ({ request, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };

      try {
        const poll = await pollCodexDeviceAuth(body.deviceAuthId, body.userCode);
        if (poll.accessToken) {
          const savedAccountId = body.saveAccount ? crypto.randomUUID() : undefined;
          const savedAccountLabel =
            body.label?.trim() || `Codex account ${new Date().toLocaleString()}`;
          serverLog.info(
            {
              provider: 'codex',
              deviceAuthId: body.deviceAuthId,
              saveAccount: body.saveAccount === true,
              label: body.label?.trim() || undefined,
            },
            'Codex auth poll completed with credentials',
          );
          const { providers } = getContext();
          // Store CLI auth marker so CodexProvider reads from auth.json on demand,
          // avoiding a synchronous HTTP verification that may fail or time out.
          const codexMarker = createCodexCLIAuthMarker();
          const result = await providers.setCredentials('codex', { authToken: codexMarker });
          if (!result.success) {
            set.status = 400;
            return { ok: false, error: result.error ?? 'Failed to activate Codex auth' };
          }
          if (body.saveAccount) {
            await credentialsService.createCredential({
              userId: LOCAL_USER_ID,
              provider: 'codex',
              value: poll.accessToken,
              type: 'authToken',
              metadata: {
                accountId: savedAccountId,
                label: savedAccountLabel,
              },
            });
          }
          syncProviderConfigsSafely(providers);
          return {
            ok: true,
            data: {
              status: 'connected',
              provider: 'codex',
              savedAccount: savedAccountId
                ? {
                    id: savedAccountId,
                    provider: 'codex',
                    label: savedAccountLabel,
                  }
                : undefined,
            },
          };
        }

        if (poll.error && poll.error !== 'authorization_pending') {
          serverLog.warn(
            {
              provider: 'codex',
              deviceAuthId: body.deviceAuthId,
              userCode: body.userCode,
              pollError: poll.error,
              errorDescription: poll.errorDescription,
            },
            'Codex auth poll returned a non-pending status',
          );
        }

        return {
          ok: true,
          data: {
            status: poll.error === 'authorization_pending' ? 'pending' : 'polling',
            provider: 'codex',
            ...poll,
          },
        };
      } catch (error: any) {
        serverLog.error(
          {
            provider: 'codex',
            deviceAuthId: body.deviceAuthId,
            userCode: body.userCode,
            error: error?.message ?? String(error),
          },
          'Codex auth poll request threw an error',
        );
        set.status = 400;
        return { ok: false, error: error?.message ?? 'Failed to poll Codex auth' };
      }
    },
    {
      body: t.Object({
        deviceAuthId: t.String(),
        userCode: t.String(),
        saveAccount: t.Optional(t.Boolean()),
        label: t.Optional(t.String()),
      }),
    },
  )
  .put(
    '/:name',
    async ({ request, params: { name }, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      const { providers } = getContext();
      const result = await providers.setCredentials(name as ProviderName, body);
      if (result.success) {
        syncProviderConfigsSafely(providers);
        return { ok: true };
      }
      return { ok: false, error: result.error };
    },
    { body: providerConfigBody },
  )
  .post(
    '/kimicode/auth/poll',
    async ({ request, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };

      try {
        const poll = await pollKimiCodeDeviceAuth(body.deviceCode);
        if (poll.accessToken && poll.refreshToken) {
          const marker = createKimiCodeAuthMarker();
          saveKimiCodeAuthState({
            accessToken: poll.accessToken,
            refreshToken: poll.refreshToken,
            expiresAt: Date.now() + Math.max(1, poll.expiresIn ?? 3600) * 1000,
            scope: poll.scope,
            tokenType: poll.tokenType,
            expiresIn: poll.expiresIn,
          });

          const { providers } = getContext();
          const result = await providers.setCredentials('kimicode', { authToken: marker });
          if (!result.success) {
            clearKimiCodeAuthState();
            set.status = 400;
            return { ok: false, error: result.error ?? 'Failed to activate Kimi Code auth' };
          }
          syncProviderConfigsSafely(providers);
          return {
            ok: true,
            data: {
              status: 'connected',
              provider: 'kimicode',
            },
          };
        }

        return {
          ok: true,
          data: {
            status: poll.error === 'authorization_pending' ? 'pending' : 'polling',
            provider: 'kimicode',
            ...poll,
          },
        };
      } catch (error: any) {
        set.status = 400;
        return { ok: false, error: error?.message ?? 'Failed to poll Kimi Code auth' };
      }
    },
    {
      body: t.Object({
        deviceCode: t.String(),
      }),
    },
  )
  .post(
    '/:name',
    async ({ request, params: { name }, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      const { providers } = getContext();
      const result = await providers.setCredentials(name as ProviderName, body);
      if (result.success) {
        syncProviderConfigsSafely(providers);
        return { ok: true };
      }
      return { ok: false, error: result.error };
    },
    { body: providerConfigBody },
  )
  .post(
    '/:name/rotate',
    async ({ request, params: { name }, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
      const { providers } = getContext();
      const result = await providers.setCredentials(name as ProviderName, body);
      if (result.success) {
        syncProviderConfigsSafely(providers);
        return { ok: true };
      }
      return { ok: false, error: result.error };
    },
    { body: providerConfigBody },
  )
  .get('/:name/accounts', async ({ request, params: { name }, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const { providers } = getContext();
    const providerConfig = providers.getConfigs()[name];
    return {
      ok: true,
      data: await listStoredAccounts(name),
      fallbackOrder: providerConfig?.fallbackOrder ?? [],
    };
  })
  .post(
    '/:name/accounts',
    async ({ request, params: { name }, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };

      const values = {
        apiKey: body.apiKey?.trim() || undefined,
        authToken: body.authToken?.trim() || undefined,
        baseUrl: body.baseUrl?.trim() || undefined,
      };

      if (!values.apiKey && !values.authToken && !values.baseUrl) {
        set.status = 400;
        return { ok: false, error: 'Provide at least one account credential' };
      }

      const accountId = crypto.randomUUID();
      const label = body.label?.trim() || `${name} account`;
      const createdIds: string[] = [];

      try {
        for (const [type, value] of Object.entries(values) as Array<
          ['apiKey' | 'authToken' | 'baseUrl', string | undefined]
        >) {
          if (!value) continue;
          const created = await credentialsService.createCredential({
            userId: LOCAL_USER_ID,
            provider: name,
            value,
            type,
            metadata: { accountId, label },
          });
          createdIds.push(created.id);
        }

        if (body.activate) {
          const { providers } = getContext();
          const result = await providers.setCredentials(name as ProviderName, values);
          if (!result.success) {
            set.status = 400;
            return { ok: false, error: result.error ?? 'Failed to activate saved account' };
          }
          syncProviderConfigsSafely(providers);
        }

        const account = (await listStoredAccounts(name)).find((entry) => entry.id === accountId);
        return {
          ok: true,
          data: {
            account,
            activated: body.activate === true,
          },
        };
      } catch (error: any) {
        for (const id of createdIds) {
          await credentialsService.delete(LOCAL_USER_ID, id);
        }
        set.status = 500;
        return { ok: false, error: error?.message ?? 'Failed to save account' };
      }
    },
    {
      body: t.Object({
        label: t.Optional(t.String()),
        apiKey: t.Optional(t.String()),
        authToken: t.Optional(t.String()),
        baseUrl: t.Optional(t.String()),
        activate: t.Optional(t.Boolean()),
      }),
    },
  )
  .post('/:name/accounts/:accountId/activate', async ({ request, params, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };

    const bundle = await getStoredAccountBundle(params.name, params.accountId);
    if (!bundle) {
      set.status = 404;
      return { ok: false, error: 'Saved account not found' };
    }

    const { providers } = getContext();
    const result = await providers.setCredentials(params.name as ProviderName, bundle.values);
    if (!result.success) {
      set.status = 400;
      return { ok: false, error: result.error ?? 'Failed to activate saved account' };
    }

    syncProviderConfigsSafely(providers);
    return {
      ok: true,
      data: {
        account: bundle.account,
        activated: true,
      },
    };
  })
  .delete('/:name/accounts/:accountId', async ({ request, params, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };

    const credentials = await credentialsService.list(LOCAL_USER_ID, {
      provider: params.name,
      isActive: true,
    });
    const matching = credentials.filter((credential) => {
      const metadata = readStoredMetadata(credential);
      return (metadata.accountId ?? credential.id) === params.accountId;
    });

    if (matching.length === 0) {
      set.status = 404;
      return { ok: false, error: 'Saved account not found' };
    }

    for (const credential of matching) {
      await credentialsService.delete(LOCAL_USER_ID, credential.id);
    }

    return { ok: true };
  })
  .patch(
    '/:name/accounts/:accountId',
    async ({ request, params, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };

      const label = body.label?.trim();
      if (!label) {
        set.status = 400;
        return { ok: false, error: 'Label is required' };
      }

      const credentials = await credentialsService.list(LOCAL_USER_ID, {
        provider: params.name,
        isActive: true,
      });
      const matching = credentials.filter((credential) => {
        const metadata = readStoredMetadata(credential);
        return (metadata.accountId ?? credential.id) === params.accountId;
      });

      if (matching.length === 0) {
        set.status = 404;
        return { ok: false, error: 'Saved account not found' };
      }

      for (const credential of matching) {
        const metadata = readStoredMetadata(credential);
        await db
          .update(userCredentials)
          .set({
            metadata: JSON.stringify({
              ...metadata,
              accountId: metadata.accountId ?? params.accountId,
              label,
            }),
          })
          .where(eq(userCredentials.id, credential.id));
      }

      const account = (await listStoredAccounts(params.name)).find(
        (entry) => entry.id === params.accountId,
      );

      return {
        ok: true,
        data: {
          account,
        },
      };
    },
    {
      body: t.Object({
        label: t.String(),
      }),
    },
  )
  .put(
    '/:name/fallback-order',
    async ({ request, params: { name }, body, set }) => {
      if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };

      const accounts = await listStoredAccounts(name);
      const validIds = new Set(accounts.map((a) => a.id));
      const invalidIds = body.order.filter((id) => !validIds.has(id));
      if (invalidIds.length > 0) {
        set.status = 400;
        return { ok: false, error: `Unknown account IDs: ${invalidIds.join(', ')}` };
      }

      const { providers } = getContext();
      const configs = providers.getConfigs();
      const config = configs[name];
      if (!config) {
        set.status = 404;
        return { ok: false, error: 'Provider not found' };
      }
      config.fallbackOrder = body.order;
      configs[name] = config;
      syncProviderConfigsToConfig(PROJECT_ROOT, configs);

      return { ok: true };
    },
    {
      body: t.Object({
        order: t.Array(t.String()),
      }),
    },
  )
  .delete('/:name', async ({ request, params: { name }, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const { providers } = getContext();
    providers.removeApiKey(name as ProviderName);
    if (name === 'codex') {
      resetCodexDeviceAuthSessions();
      clearCodexAuthState();
    }
    if (name === 'kimicode') {
      clearKimiCodeAuthState();
    }
    syncProviderConfigsSafely(providers);
    return { ok: true };
  });
