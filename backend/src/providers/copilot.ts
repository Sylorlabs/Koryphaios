// Copilot provider — uses GitHub Copilot's chat completions API.
// Auth flow uses only Koryphaios-managed or explicitly supplied tokens.

import type { ModelDef, ProviderConfig } from '@koryphaios/shared';
import { OpenAIProvider } from './openai';
import OpenAI from 'openai';
import { CopilotModels } from './models/copilot';
import { createUsageInterceptingFetch } from '../credit-accountant';
import { providerLog } from '../logger';

const COPILOT_CHAT_URL = 'https://api.githubcopilot.com';

// These headers are REQUIRED by GitHub's Copilot API — without them you get HTTP 400.
// Values must match a known IDE integration; "vscode-chat" is the standard one used by OpenCode, Cursor, etc.
const COPILOT_HEADERS = {
  'Editor-Version': 'vscode/1.100.0',
  'Editor-Plugin-Version': 'copilot-chat/0.27.0',
  'Copilot-Integration-Id': 'vscode-chat',
  'User-Agent': 'Koryphaios/1.0',
} as const;

/**
 * GitHub Copilot Provider
 *
 * Model catalog is defined in ./models/copilot.ts and re-exported here.
 * This ensures a single source of truth for all Copilot models.
 *
 * Model IDs in the catalog use the format "copilot.{apiModelId}" (e.g., "copilot.gpt-4.1")
 * but the Copilot API expects unprefixed IDs (e.g., "gpt-4.1").
 * The apiModelId field contains the unprefixed version for API calls.
 */
export class CopilotProvider extends OpenAIProvider {
  private bearerToken: string | null = null;
  private githubToken: string | null = null;

  constructor(config: ProviderConfig) {
    const ghToken = config.authToken ?? null;

    super(
      {
        ...config,
        apiKey: 'placeholder-will-be-fetched-async',
        authToken: ghToken ?? undefined,
        headers: { ...config.headers, ...COPILOT_HEADERS },
      },
      'copilot',
      COPILOT_CHAT_URL,
    );

    this.githubToken = ghToken;
  }

  protected override getModelCatalogFallback(): ModelDef[] {
    return CopilotModels;
  }

  protected override async prepareForModelDiscovery(): Promise<void> {
    await this.ensureBearerToken();
  }

  override isAvailable(): boolean {
    return !this.config.disabled && !!this.config.authToken;
  }

  private _copilotClient: OpenAI | null = null;

  protected override get client(): OpenAI {
    if (!this._copilotClient) {
      this._copilotClient = new OpenAI({
        apiKey: this.bearerToken || 'placeholder-awaiting-async-init',
        baseURL: COPILOT_CHAT_URL,
        defaultHeaders: { ...this.config.headers }, // Headers are already merged in constructor
        // Route through the usage-intercepting fetch like every other OpenAI-family
        // client so Copilot usage is tracked (and so requests are interceptable).
        fetch: createUsageInterceptingFetch(globalThis.fetch),
      });
    }
    return this._copilotClient;
  }

  override async *streamResponse(
    request: import('./types').StreamRequest,
  ): AsyncGenerator<import('./types').ProviderEvent> {
    await this.ensureBearerToken();
    yield* super.streamResponse(request);
  }

  private async ensureBearerToken() {
    if (this.bearerToken) return;

    if (!this.githubToken) {
      throw new Error('GitHub Copilot token not found. Please authenticate.');
    }

    const bearer = await exchangeGitHubTokenForCopilotAsync(this.githubToken);
    if (bearer) {
      this.bearerToken = bearer;
      // Force recreation of client with new token
      this._copilotClient = null;
    } else {
      throw new Error('Failed to exchange GitHub token for Copilot bearer token.');
    }
  }
}

// Async token exchange (single implementation — no sync Bun.spawnSync)
export async function exchangeGitHubTokenForCopilotAsync(
  githubToken: string,
): Promise<string | null> {
  try {
    const resp = await fetch('https://api.github.com/copilot_internal/v2/token', {
      method: 'GET',
      headers: {
        Authorization: `Token ${githubToken}`,
        'User-Agent': 'Koryphaios/1.0',
        Accept: 'application/json',
      },
    });
    if (!resp.ok) {
      const body = await resp.text();
      providerLog.error(
        { status: resp.status, body: body.slice(0, 200) },
        'Copilot token exchange failed',
      );
      return null;
    }
    const data = (await resp.json()) as { token?: string; expires_at?: number };
    return data.token ?? null;
  } catch (err) {
    providerLog.error({ err }, 'Copilot token exchange error');
    return null;
  }
}

export interface CopilotDeviceAuthStart {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
  interval: number;
}

export interface CopilotDeviceAuthPoll {
  accessToken?: string;
  tokenType?: string;
  scope?: string;
  error?: string;
  errorDescription?: string;
}

const DEFAULT_GITHUB_OAUTH_CLIENT_ID = 'Iv1.b507a08c87ecfe98'; // GitHub CLI client id

export async function startCopilotDeviceAuth(): Promise<CopilotDeviceAuthStart> {
  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID ?? DEFAULT_GITHUB_OAUTH_CLIENT_ID;
  const params = new URLSearchParams();
  params.append('client_id', clientId);
  params.append('scope', 'read:user');

  const response = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });
  if (!response.ok) {
    throw new Error(`Failed to start device auth: HTTP ${response.status}`);
  }

  const data = (await response.json()) as {
    device_code: string;
    user_code: string;
    verification_uri: string;
    verification_uri_complete?: string;
    expires_in: number;
    interval?: number;
  };

  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    verificationUriComplete: data.verification_uri_complete,
    expiresIn: data.expires_in,
    interval: data.interval ?? 5,
  };
}

export async function pollCopilotDeviceAuth(deviceCode: string): Promise<CopilotDeviceAuthPoll> {
  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID ?? DEFAULT_GITHUB_OAUTH_CLIENT_ID;
  const params = new URLSearchParams();
  params.append('client_id', clientId);
  params.append('device_code', deviceCode);
  params.append('grant_type', 'urn:ietf:params:oauth:grant-type:device_code');

  const response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });
  if (!response.ok) {
    throw new Error(`Failed to poll device auth: HTTP ${response.status}`);
  }

  const data = (await response.json()) as {
    access_token?: string;
    token_type?: string;
    scope?: string;
    error?: string;
    error_description?: string;
  };

  return {
    accessToken: data.access_token,
    tokenType: data.token_type,
    scope: data.scope,
    error: data.error,
    errorDescription: data.error_description,
  };
}
