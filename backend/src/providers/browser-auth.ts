// Browser-based auth strategies for providers that connect via OAuth / device
// code / CLI-login detection (Copilot, Codex, KimiCode, Claude, Grok, Antigravity).
//
// Previously these lived as two central `switch (name)` blocks inside
// routes/v1/providers.ts (startBrowserAuth and completeBrowserAuth). Adding a
// browser-auth provider meant editing both switches plus the
// BrowserAuthProvider union. Now each provider is a self-contained
// BrowserAuthStrategy object registered in BROWSER_AUTH_STRATEGIES, and the
// route dispatches by map lookup. Adding a provider is one new strategy + one
// map entry.

import { serverLog } from '../logger';
import { getContext } from '../context';
import { PROJECT_ROOT } from '../runtime/paths';
import { syncProviderConfigsToConfig } from '../runtime/config';
import { startCopilotDeviceAuth } from './copilot';
import { getManagedCodexAppServer } from './codex-app-server';
import { CODEX_MANAGED_AUTH_MARKER } from './codex-auth';
import {
  clearKimiCodeAuthState,
  startKimiCodeDeviceAuth,
} from './kimicode-auth';
import {
  detectClaudeCodeLogin,
  createClaudeCLIAuthMarker,
  clearCachedToken,
  detectGrokCLILogin,
  createGrokCLIAuthMarker,
  detectAntigravityCLILogin,
  createAntigravityCLIAuthMarker,
} from './auth-utils';
import type { ProviderName } from '@koryphaios/shared';

export type BrowserAuthProvider =
  | 'copilot'
  | 'codex-auth'
  | 'kimicode'
  | 'claude'
  | 'grok'
  | 'antigravity';

const BROWSER_AUTH_PROVIDER_NAMES: ReadonlySet<BrowserAuthProvider> = new Set([
  'copilot',
  'codex-auth',
  'kimicode',
  'claude',
  'grok',
  'antigravity',
]);

export function isBrowserAuthProvider(name: string): name is BrowserAuthProvider {
  return BROWSER_AUTH_PROVIDER_NAMES.has(name as BrowserAuthProvider);
}

export interface AuthResult {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: string;
}

/**
 * A provider's browser-auth flow. `start` begins the flow (device code,
 * CLI-login probe); `complete` finalizes it after the user approves.
 */
export interface BrowserAuthStrategy {
  start(): Promise<AuthResult>;
  complete(): Promise<AuthResult>;
}

/** Sync the in-memory provider configs back to koryphaios.json (no-op in tests). */
function syncProviderConfigsSafely(): void {
  if (process.env.NODE_ENV === 'test') return;
  syncProviderConfigsToConfig(PROJECT_ROOT, getContext().providers.getConfigs());
}

// ─── Codex managed-auth helpers ─────────────────────────────────────────────

async function activateManagedCodexAuth(): Promise<AuthResult> {
  const { providers } = getContext();
  const account = await getManagedCodexAppServer().account(true);
  if (account.account?.type !== 'chatgpt') {
    return { ok: false, error: 'ChatGPT sign-in is not complete yet.' };
  }
  // This is an activation marker only, never an OAuth access or refresh token.
  const result = await providers.setCredentials('codex-auth', {
    authToken: CODEX_MANAGED_AUTH_MARKER,
  });
  if (!result.success) {
    return { ok: false, error: result.error ?? 'Failed to activate OpenAI Codex' };
  }
  await providers.get('codex-auth')?.refreshModels?.(true);
  syncProviderConfigsSafely();
  return {
    ok: true,
    data: {
      status: 'connected',
      provider: 'codex-auth',
      planType: account.account.planType ?? null,
    },
  };
}

/** Adopt an already-persisted app-server ChatGPT session during status refreshes. */
export async function adoptManagedCodexSession(): Promise<void> {
  const { providers } = getContext();
  const status = providers.getStatus().find((provider) => provider.name === 'codex-auth');
  if (!status || status.authenticated) return;
  try {
    const account = await getManagedCodexAppServer().account(false);
    if (account.account?.type !== 'chatgpt') return;
    const activation = await activateManagedCodexAuth();
    if (activation.ok) {
      serverLog.info({ provider: 'codex-auth' }, 'Adopted existing OpenAI Codex ChatGPT session');
    }
  } catch (error: unknown) {
    // Status polling must remain available when Codex is absent or its profile is not signed in.
    serverLog.debug(
      { provider: 'codex-auth', error: error instanceof Error ? error.message : String(error) },
      'Could not adopt managed OpenAI Codex session during status refresh',
    );
  }
}

// ─── CLI-login strategy factory ─────────────────────────────────────────────
// Claude, Grok, and Antigravity share one shape: detect a logged-in CLI, then
// store an opt-in marker (the CLI owns the real token). Parameterized by the
// provider name, the CLI-login detector, the marker factory, and the
// "not logged in" guidance shown to the user.

function cliLoginStrategy(opts: {
  provider: ProviderName;
  detect: () => boolean;
  marker: () => string;
  startConnectedMessage: string;
  startNotLoggedInMessage: string;
  completeNotLoggedInError: string;
  completeLogLabel: string;
}): BrowserAuthStrategy {
  const {
    provider,
    detect,
    marker,
    startConnectedMessage,
    startNotLoggedInMessage,
    completeNotLoggedInError,
    completeLogLabel,
  } = opts;

  return {
    async start(): Promise<AuthResult> {
      if (detect()) {
        const { providers } = getContext();
        const setResult = await providers.setCredentials(provider, { authToken: marker() });
        if (!setResult.success) {
          return { ok: false, error: setResult.error ?? `Failed to activate ${provider} auth` };
        }
        syncProviderConfigsSafely();
        serverLog.info({ provider }, `${completeLogLabel} connected via CLI subscription`);
        return {
          ok: true,
          data: { status: 'connected', provider, message: startConnectedMessage },
        };
      }
      serverLog.info({ provider }, `No ${completeLogLabel} CLI login detected`);
      return { ok: true, data: { provider, message: startNotLoggedInMessage } };
    },

    async complete(): Promise<AuthResult> {
      if (provider === 'claude') clearCachedToken('claude-login');
      if (!detect()) {
        return { ok: false, error: completeNotLoggedInError };
      }
      const { providers } = getContext();
      const result = await providers.setCredentials(provider, { authToken: marker() });
      if (!result.success) {
        return { ok: false, error: result.error ?? `Failed to activate ${provider} auth` };
      }
      syncProviderConfigsSafely();
      serverLog.info({ provider }, `${completeLogLabel} auth completed`);
      return { ok: true, data: { status: 'connected', provider } };
    },
  };
}

// ─── Strategy registry ──────────────────────────────────────────────────────

const BROWSER_AUTH_STRATEGIES: Record<BrowserAuthProvider, BrowserAuthStrategy> = {
  copilot: {
    async start(): Promise<AuthResult> {
      const result = await startCopilotDeviceAuth();
      serverLog.info(
        { provider: 'copilot', deviceCode: result.deviceCode, verificationUri: result.verificationUri },
        'Browser auth flow started',
      );
      return { ok: true, data: { provider: 'copilot', ...result } };
    },
    async complete(): Promise<AuthResult> {
      return { ok: false, error: 'copilot auth completes automatically after browser approval' };
    },
  },

  'codex-auth': {
    async start(): Promise<AuthResult> {
      const appServer = getManagedCodexAppServer();
      const result = await appServer.startChatgptDeviceCodeLogin();
      void appServer
        .waitForLoginCompletion(result.loginId)
        .then(async (completion) => {
          if (!completion.success) {
            serverLog.warn({ provider: 'codex-auth', error: completion.error }, 'OpenAI Codex sign-in was not approved');
            return;
          }
          const activation = await activateManagedCodexAuth();
          if (!activation.ok) {
            serverLog.error({ provider: 'codex-auth', error: activation.error }, 'OpenAI Codex sign-in completed but activation failed');
            return;
          }
          serverLog.info({ provider: 'codex-auth' }, 'OpenAI Codex signed in and activated automatically');
        })
        .catch((error) => {
          serverLog.warn(
            { provider: 'codex-auth', error: error instanceof Error ? error.message : String(error) },
            'OpenAI Codex sign-in did not complete',
          );
        });
      return {
        ok: true,
        data: {
          provider: 'codex-auth',
          // Device auth is intentionally UI-owned: it avoids the hosted
          // success page attempting to open Codex's private `codex://` URI.
          deviceCode: result.loginId,
          userCode: result.userCode,
          verificationUri: result.verificationUrl,
          message: 'Open the verification page, enter this code, then confirm the sign-in here.',
        },
      };
    },
    async complete(): Promise<AuthResult> {
      return activateManagedCodexAuth();
    },
  },

  kimicode: {
    async start(): Promise<AuthResult> {
      clearKimiCodeAuthState();
      const result = await startKimiCodeDeviceAuth();
      serverLog.info(
        { provider: 'kimicode', userCode: result.userCode, verificationUri: result.verificationUri },
        'Browser auth flow started',
      );
      return { ok: true, data: { provider: 'kimicode', ...result } };
    },
    async complete(): Promise<AuthResult> {
      return { ok: false, error: 'kimicode auth completes automatically after browser approval' };
    },
  },

  claude: cliLoginStrategy({
    provider: 'claude',
    detect: detectClaudeCodeLogin,
    marker: createClaudeCLIAuthMarker,
    startConnectedMessage: 'Claude Code connected via your Claude subscription (CLI harness)',
    startNotLoggedInMessage: 'Run "claude login" in your terminal, then click Auth again to connect.',
    completeNotLoggedInError: 'Claude Code is not logged in. Run "claude login" in your terminal first.',
    completeLogLabel: 'Claude Code',
  }),

  grok: cliLoginStrategy({
    provider: 'grok',
    detect: detectGrokCLILogin,
    marker: createGrokCLIAuthMarker,
    startConnectedMessage: 'Grok Build connected via your local grok CLI (subscription or xAI key)',
    startNotLoggedInMessage: 'Install the grok CLI and run "grok login", then click Auth again to connect.',
    completeNotLoggedInError: 'Grok Build CLI is not logged in. Install grok and run "grok login" first.',
    completeLogLabel: 'Grok Build',
  }),

  antigravity: cliLoginStrategy({
    provider: 'antigravity',
    detect: detectAntigravityCLILogin,
    marker: createAntigravityCLIAuthMarker,
    startConnectedMessage: 'Antigravity connected via your local agy CLI',
    startNotLoggedInMessage: 'Install the agy CLI and run "agy login", then click Auth again to connect.',
    completeNotLoggedInError: 'Antigravity CLI is not logged in. Install agy and run "agy login" first.',
    completeLogLabel: 'Antigravity',
  }),
};

// ─── Public dispatchers ─────────────────────────────────────────────────────

export async function startBrowserAuth(name: BrowserAuthProvider): Promise<AuthResult> {
  try {
    return await BROWSER_AUTH_STRATEGIES[name].start();
  } catch (error: unknown) {
    serverLog.error(
      { provider: name, error: error instanceof Error ? error.message : String(error) },
      'Failed to start browser auth flow',
    );
    return { ok: false, error: error instanceof Error ? error.message : 'Failed to start auth flow' };
  }
}

export async function completeBrowserAuth(name: BrowserAuthProvider): Promise<AuthResult> {
  try {
    return await BROWSER_AUTH_STRATEGIES[name].complete();
  } catch (error: unknown) {
    serverLog.error(
      { provider: name, error: error instanceof Error ? error.message : String(error) },
      'Failed to complete browser auth flow',
    );
    return { ok: false, error: error instanceof Error ? error.message : 'Failed to complete auth flow' };
  }
}
