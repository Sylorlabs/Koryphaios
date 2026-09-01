import { eq } from 'drizzle-orm';
import { Elysia, t } from 'elysia';
import { getContext } from '../../context';
import { PROJECT_ROOT } from '../../runtime/paths';
import { syncProviderConfigsToConfig, removeProviderFromConfig } from '../../runtime/config';
import { removeProviderSecrets } from '../../security/secret-store';
import { customProviderId, probeCustomProvider } from '../../providers/custom';
import {
  CUSTOM_PROVIDER_ICON_MAX_BYTES,
  deleteCustomProviderIcon,
  readCustomProviderIcon,
  storeCustomProviderIcon,
} from '../../providers/custom-provider-icons';
import type { ProviderName } from '@koryphaios/shared';
import { serverLog } from '../../logger';
import { requireLocalRouteAuth } from '../../auth/local-route-auth';
import { ValidationError, InternalError } from '../../errors/types';
import { db, userCredentials } from '../../db';
import { createUserCredentialsService, type UserCredential } from '../../services';
import { pollCopilotDeviceAuth } from '../../providers/copilot';
import {
  isBrowserAuthProvider,
  startBrowserAuth,
  completeBrowserAuth,
  adoptManagedCodexSession,
  type BrowserAuthProvider,
} from '../../providers/browser-auth';
import { detectAgentClis } from '../../providers/cli-detection';
import { scanAwsCredentialSources } from '../../providers/aws-credential-scan';
import { cliResearchBoundary } from '../../providers/cli-research';
import { getManagedCodexAppServer } from '../../providers/codex-app-server';
import { discoverCliAccounts, getDiscoveredCliAccount } from '../../providers/cli-accounts';
import {
  clearKimiCodeAuthState,
  createKimiCodeAuthMarker,
  createKimiCodeCliMarker,
  isKimiCodeAuthMarker,
  pollKimiCodeDeviceAuth,
  saveKimiCodeAuthState,
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
  source?: 'saved' | 'cli-autodetect';
  email?: string | null;
  plan?: string | null;
  health?: 'ready' | 'expired' | 'unknown';
  profileDir?: string;
};

type StoredAccountMetadata = {
  accountId?: string;
  label?: string;
};

const providerConfigBody = t.Object({
  apiKey: t.Optional(t.String()),
  authToken: t.Optional(t.String()),
  baseUrl: t.Optional(t.String()),
  deployment: t.Optional(t.String()),
  awsRegion: t.Optional(t.String()),
  awsSessionToken: t.Optional(t.String()),
  selectedModels: t.Optional(t.Array(t.String())),
  hideModelSelector: t.Optional(t.Boolean()),
});

function readStoredMetadata(credential: UserCredential): StoredAccountMetadata {
  if (credential.metadata && typeof credential.metadata === 'object') {
    return credential.metadata as StoredAccountMetadata;
  }
  return {};
}

function syncProviderConfigsSafely(providers: ReturnType<typeof getContext>['providers']): boolean {
  if (process.env.NODE_ENV === 'test') return true;
  return syncProviderConfigsToConfig(PROJECT_ROOT, providers.getConfigs());
}

function providerSecretStoreRoot(): string {
  // Packaged desktop launches set this to the per-user data directory. Read it
  // at request time so route tests can prove disk deletion in an isolated
  // directory without ever touching a developer's real credential store.
  return process.env.KORYPHAIOS_DATA_DIR?.trim() || PROJECT_ROOT;
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
  const stored = groupStoredAccounts(provider, credentials).map((account) => ({
    ...account,
    source: 'saved' as const,
  }));
  const storedIds = new Set(stored.map((account) => account.id));
  const detected = discoverCliAccounts()
    .filter((account) => account.provider === provider && !storedIds.has(account.id))
    .map((account) => ({
      id: account.id,
      provider: account.provider,
      label: account.label,
      createdAt: 0,
      updatedAt: account.expiresAt ?? 0,
      hasApiKey: false,
      hasAuthToken: true,
      hasBaseUrl: false,
      source: account.source,
      email: account.email,
      plan: account.plan,
      health: account.health,
      profileDir: account.profileDir,
    }));
  return [...detected, ...stored];
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
    await adoptManagedCodexSession();
    const forceRefreshModels = new URL(request.url).searchParams.get('refreshModels') === '1';
    await providers.autoConnectCliProviders(forceRefreshModels);
    if (forceRefreshModels) {
      await providers.refreshModelCatalogs();
    }
    return {
      ok: true,
      data: providers.getStatus(),
    };
  })
  .get('/status', async ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const { providers } = getContext();
    await adoptManagedCodexSession();
    const forceRefreshModels = new URL(request.url).searchParams.get('refreshModels') === '1';
    await providers.autoConnectCliProviders(forceRefreshModels);
    if (forceRefreshModels) {
      await providers.refreshModelCatalogs();
    }
    return {
      ok: true,
      data: providers.getStatus(),
    };
  })
  .get('/cli-accounts', ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const accounts = discoverCliAccounts();
    const { providers } = getContext();
    const configs = providers.getConfigs();
    const providerCounts = new Map<string, number>();
    for (const account of accounts) {
      providerCounts.set(account.provider, (providerCounts.get(account.provider) ?? 0) + 1);
    }
    return {
      ok: true,
      data: accounts,
      selectionRequired: [...providerCounts.entries()]
        .filter(([provider, count]) => {
          if (count < 2) return false;
          // A saved fallback order is the user's durable CLI-account choice.
          // Ignore stale IDs so a newly discovered set is surfaced once.
          const discoveredIds = new Set(
            accounts
              .filter((account) => account.provider === provider)
              .map((account) => account.id),
          );
          return !(configs[provider]?.fallbackOrder ?? []).some((id) => discoveredIds.has(id));
        })
        .map(([provider]) => provider),
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
      data: detectAgentClis().map((cli) => ({
        ...cli,
        nativeResearch: cli.provider
          ? cliResearchBoundary(cli.provider)
          : cliResearchBoundary(cli.id),
      })),
    };
  })
  // AWS credential source scan for Bedrock. Reports WHERE credentials live on
  // the system (env vars, ~/.aws/credentials, ~/.aws/config) — never the secret
  // material itself — so the UI can offer "Connect" or "Ignore".
  .get('/bedrock/credentials/scan', async ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    return {
      ok: true,
      data: scanAwsCredentialSources(),
    };
  })
  .post('/test-connected', async ({ request, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const { providers } = getContext();
    const connected = providers
      .getStatus()
      .filter(
        (provider) =>
          provider.enabled &&
          provider.credentialDetected &&
          provider.connectionState !== 'unavailable',
      );
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
        throw new ValidationError('A display name is required');
      }
      if (!baseUrl) {
        throw new ValidationError('A base URL is required (e.g. https://api.example.com/v1)');
      }
      const { providers } = getContext();
      const id = customProviderId(label);
      if (providers.getConfigs()[id]?.custom) {
        set.status = 409;
        return {
          ok: false,
          error: `A custom provider named "${label}" already exists. Open its card to update it.`,
        };
      }
      const kind = body.kind ?? 'openai';
      const manualModels = [...new Set(body.models?.map((m) => m.trim()).filter(Boolean) ?? [])];
      const probe = await probeCustomProvider({
        kind,
        baseUrl,
        apiKey: body.apiKey?.trim() || undefined,
        authToken: body.authToken?.trim() || undefined,
        headers: body.headers,
      });
      const saveUnverified = body.allowUnverified === true;
      if (!probe.success) {
        if (!saveUnverified || !probe.canSaveUnverified) {
          set.status = 422;
          return {
            ok: false,
            error: probe.error ?? 'Koryphaios could not verify this endpoint.',
            canSaveUnverified: probe.canSaveUnverified,
            requiresManualModels: probe.canSaveUnverified && manualModels.length === 0,
            normalizedBaseUrl: probe.normalizedBaseUrl,
          };
        }
        if (manualModels.length === 0) {
          set.status = 422;
          return {
            ok: false,
            error: 'Add at least one model ID before saving an endpoint without discovery.',
            canSaveUnverified: true,
            requiresManualModels: true,
            normalizedBaseUrl: probe.normalizedBaseUrl,
          };
        }
      }
      const models = [...new Set([...manualModels, ...(probe.success ? probe.models : [])])];
      const result = providers.registerCustomProvider({
        id,
        label,
        kind,
        baseUrl: probe.normalizedBaseUrl ?? baseUrl,
        apiKey: body.apiKey?.trim() || undefined,
        authToken: body.authToken?.trim() || undefined,
        headers: body.headers,
        models,
        catalogDetected: probe.success,
      });
      if (!result.success) {
        throw new ValidationError(result.error ?? 'Failed to add custom provider');
      }
      syncProviderConfigsSafely(providers);
      serverLog.info(
        { provider: id, kind, catalogDetected: probe.success },
        'Custom provider added',
      );
      return {
        ok: true,
        data: {
          id,
          label,
          kind,
          catalogDetected: probe.success,
          normalizedBaseUrl: probe.normalizedBaseUrl ?? baseUrl,
          models,
        },
      };
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
        allowUnverified: t.Optional(t.Boolean()),
      }),
    },
  )
  .put('/custom/:id/icon', async ({ request, params: { id }, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const { providers } = getContext();
    const config = providers.getConfigs()[id];
    if (!config?.custom) {
      set.status = 404;
      return { ok: false, error: 'Custom provider not found' };
    }

    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      throw new ValidationError('Upload a PNG icon using multipart form data');
    }
    const icon = form.get('icon');
    const shape = form.get('shape');
    if (!(icon instanceof File)) throw new ValidationError('Choose an icon image to upload');
    if (icon.size < 1 || icon.size > CUSTOM_PROVIDER_ICON_MAX_BYTES) {
      throw new ValidationError(
        `Custom provider icon must be between 1 and ${CUSTOM_PROVIDER_ICON_MAX_BYTES} bytes`,
      );
    }

    try {
      const previousIcon = config.customIcon;
      const metadata = await storeCustomProviderIcon({
        providerId: id,
        bytes: new Uint8Array(await icon.arrayBuffer()),
        contentType: icon.type,
        shape,
      });
      const updated = providers.setCustomProviderIcon(id as ProviderName, metadata);
      if (!updated.success) {
        await deleteCustomProviderIcon(id, metadata.assetId);
        throw new ValidationError(updated.error ?? 'Custom provider not found');
      }
      if (!syncProviderConfigsSafely(providers)) {
        providers.setCustomProviderIcon(id as ProviderName, previousIcon);
        await deleteCustomProviderIcon(id, metadata.assetId).catch(() => undefined);
        throw new InternalError('The custom provider icon could not be persisted');
      }
      if (previousIcon && previousIcon.assetId !== metadata.assetId) {
        await deleteCustomProviderIcon(id, previousIcon.assetId).catch((error: unknown) => {
          serverLog.warn(
            { provider: id, error },
            'Replaced custom provider icon but could not clean up the previous asset',
          );
        });
      }
      return { ok: true, data: metadata };
    } catch (error: unknown) {
      if (error instanceof ValidationError) throw error;
      if (error instanceof InternalError) throw error;
      if (error instanceof Error && error.name === 'CustomProviderIconValidationError') {
        throw new ValidationError(error.message);
      }
      throw new InternalError('The custom provider icon could not be stored');
    }
  })
  .get('/custom/:id/icon', async ({ request, params: { id }, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const config = getContext().providers.getConfigs()[id];
    if (!config?.customIcon) {
      return new Response(null, { status: 404 });
    }
    const icon = await readCustomProviderIcon(id, config.customIcon.assetId);
    if (!icon) return new Response(null, { status: 404 });
    if (request.headers.get('if-none-match') === icon.etag) {
      return new Response(null, { status: 304, headers: { ETag: icon.etag } });
    }
    const body = new Uint8Array(icon.bytes.byteLength);
    body.set(icon.bytes);
    return new Response(body.buffer, {
      headers: {
        'Content-Type': icon.contentType,
        'Content-Length': String(icon.bytes.byteLength),
        'Cache-Control': 'private, max-age=31536000, immutable',
        ETag: icon.etag,
        'X-Content-Type-Options': 'nosniff',
      },
    });
  })
  .delete('/custom/:id/icon', async ({ request, params: { id }, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const { providers } = getContext();
    const config = providers.getConfigs()[id];
    if (!config?.custom) {
      set.status = 404;
      return { ok: false, error: 'Custom provider not found' };
    }
    if (config.customIcon) {
      const previousIcon = config.customIcon;
      providers.setCustomProviderIcon(id as ProviderName, undefined);
      if (!syncProviderConfigsSafely(providers)) {
        providers.setCustomProviderIcon(id as ProviderName, previousIcon);
        throw new InternalError('The custom provider icon could not be removed from settings');
      }
      await deleteCustomProviderIcon(id, previousIcon.assetId).catch((error: unknown) => {
        serverLog.warn(
          { provider: id, error },
          'Removed custom provider icon from settings but could not clean up its asset',
        );
      });
    }
    return { ok: true };
  })
  .delete('/custom/:id', async ({ request, params: { id }, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const { providers } = getContext();
    const config = providers.getConfigs()[id];
    if (!config?.custom) {
      set.status = 404;
      return { ok: false, error: 'Custom provider not found' };
    }
    const customIcon = config.customIcon;
    if (customIcon) await deleteCustomProviderIcon(id, customIcon.assetId);
    providers.removeCustomProvider(id as ProviderName);
    removeProviderSecrets(providerSecretStoreRoot(), id);
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

      const poll = await pollCopilotDeviceAuth(body.deviceCode);
      if (poll.accessToken) {
        const { providers } = getContext();
        const result = await providers.setCredentials('copilot', { authToken: poll.accessToken });
        if (!result.success) {
          throw new ValidationError(result.error ?? 'Failed to activate Copilot auth');
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
    },
    {
      body: t.Object({
        deviceCode: t.String(),
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
          throw new ValidationError(result.error ?? 'Failed to activate Kimi Code auth');
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
      fallbackEnabled: providerConfig?.fallbackEnabled ?? false,
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
        throw new ValidationError('Provide at least one account credential');
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
            throw new ValidationError(result.error ?? 'Failed to activate saved account');
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
      } catch (error: unknown) {
        for (const id of createdIds) {
          await credentialsService.delete(LOCAL_USER_ID, id);
        }
        throw new InternalError(error instanceof Error ? error.message : 'Failed to save account');
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

    const discovered = getDiscoveredCliAccount(params.accountId);
    if (discovered && discovered.provider === params.name) {
      // Kimi Code stores its OAuth session as a file under the profile dir.
      // Selecting a profile is safe: we store only a CLI marker that points
      // at the profile dir, and the token is read lazily at request time.
      // (Codex's CLI harness has no equivalent profile-selection mechanism,
      // so its discovered accounts remain non-activatable.)
      if (params.name === 'kimicode') {
        const values = { authToken: createKimiCodeCliMarker(discovered.profileDir) };
        const { providers } = getContext();
        const result = await providers.setCredentials(params.name as ProviderName, values);
        if (!result.success) {
          set.status = 400;
          return {
            ok: false,
            error: result.error ?? 'Failed to activate detected Kimi Code account',
          };
        }
        syncProviderConfigsSafely(providers);
        return { ok: true, data: { account: discovered, activated: true } };
      }
      // Other CLI harness providers (codex, claude, grok, …) run their CLI
      // directly and that CLI chooses its active local account. Koryphaios
      // deliberately does not copy profile tokens.
      set.status = 400;
      return {
        ok: false,
        error: `${params.name} exposes this CLI identity, but its harness does not provide a safe profile-selection mechanism yet.`,
      };
    }

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
    if (getDiscoveredCliAccount(params.accountId)) {
      set.status = 400;
      return {
        ok: false,
        error: 'Detected CLI accounts are managed by their CLI profile directory.',
      };
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
      if (typeof body.enabled === 'boolean') config.fallbackEnabled = body.enabled;
      configs[name] = config;
      syncProviderConfigsToConfig(PROJECT_ROOT, configs);

      return { ok: true };
    },
    {
      body: t.Object({
        order: t.Array(t.String()),
        enabled: t.Optional(t.Boolean()),
      }),
    },
  )
  .get('/:name/quota', async ({ request, params: { name }, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    if (name !== 'antigravity') {
      set.status = 404;
      return { ok: false, error: 'Quota API is only available for the antigravity provider' };
    }
    const { providers } = getContext();
    const provider = providers.get(name as ProviderName) as
      | {
          getQuota?: () => Map<string, unknown> | null;
          getQuotaGroups?: () => Array<{
            name: string;
            description: string;
            buckets: Array<{
              id: string;
              name: string;
              window: string;
              remainingFraction: number;
              resetTime: string;
            }>;
          }> | null;
        }
      | undefined;
    const groups = provider?.getQuotaGroups?.();
    if (!groups) {
      return { ok: true, data: { groups: [], available: false } };
    }
    return { ok: true, data: { groups, available: true } };
  })
  .delete('/:name', async ({ request, params: { name }, set }) => {
    if (!requireLocalRouteAuth(request, set)) return { ok: false, error: 'Unauthorized' };
    const { providers } = getContext();
    const existingConfig = providers.getConfigs()[name];

    // Remove Koryphaios-owned direct credentials even when there is no
    // koryphaios.json or active registry entry. Do this before provider-owned
    // logout cleanup so a failed external logout cannot strand the local copy.
    removeProviderSecrets(providerSecretStoreRoot(), name);
    if (name === 'codex-auth') {
      // The managed app-server, not Koryphaios, persists ChatGPT OAuth tokens.
      await getManagedCodexAppServer().logout();
    }
    // For Kimi Code, only clear the MANAGED session's credentials (the device
    // flow at KORY_KIMI_HOME). CLI-profile markers just unset the config
    // authToken — the user's `kimi login` credentials stay on disk so the
    // provider can be re-activated without another login.
    if (name === 'kimicode') {
      const authToken = existingConfig?.authToken?.trim();
      if (!authToken || isKimiCodeAuthMarker(authToken)) {
        clearKimiCodeAuthState();
      }
    }
    providers.removeApiKey(name as ProviderName);
    syncProviderConfigsSafely(providers);
    return { ok: true };
  });
