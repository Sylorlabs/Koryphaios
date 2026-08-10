// SAP AI Core / Generative AI Hub provider.
//
// Real protocol (NOT a plain OpenAI base URL):
//   1. Auth: OAuth2 client_credentials from the service key JSON (clientid/clientsecret/url)
//      → POST {url}/oauth/token (Basic auth) → access_token.
//   2. Inference: POST {AI_API_URL}/v2/inference/deployments/{deploymentId}/chat/completions
//      ?api-version=... with `Authorization: Bearer <token>` + `AI-Resource-Group` header and
//      an OpenAI-compatible body.
// Refs: SAP AI Core inference docs (community.sap.com), SAP Cloud SDK for AI.
//
// We reuse OpenAIProvider's streaming/parsing and override the client to encode SAP's
// deployment URL + headers + api-version, plus an async OAuth token step.

import OpenAI from 'openai';
import type { ProviderConfig } from '@koryphaios/shared';
import { OpenAIProvider } from './openai';
import { createUsageInterceptingFetch } from '../credit-accountant';
import { withTimeoutSignal } from './utils';
import { providerLog } from '../logger';

export const SAP_API_VERSION = process.env.AICORE_API_VERSION || '2024-02-01';

interface SapServiceKey {
  clientid?: string;
  clientsecret?: string;
  url?: string;
  serviceurls?: { AI_API_URL?: string };
}

export type SapResolvedCredential = {
  accessToken: string;
  apiUrl: string;
};

export function sapResourceGroup(config: ProviderConfig): string {
  return (
    process.env.AICORE_RESOURCE_GROUP ||
    (config.headers?.['AI-Resource-Group'] as string) ||
    'default'
  );
}

export function sapDeploymentId(config: ProviderConfig): string {
  return (
    config.deployment?.trim() ||
    process.env.AICORE_DEPLOYMENT_ID?.trim() ||
    (config.headers?.['AI-Deployment-Id'] as string | undefined)?.trim() ||
    ''
  );
}

function looksLikeServiceKey(credential?: string): boolean {
  return !!credential && credential.trim().startsWith('{');
}

/** Resolve SAP's service-key OAuth flow without treating the JSON itself as a bearer token. */
export async function resolveSapCredential(config: ProviderConfig): Promise<SapResolvedCredential> {
  const credential = (config.apiKey || config.authToken || '').trim();
  if (!credential) throw new Error('SAP AI Core requires a service key JSON or bearer token');

  if (!looksLikeServiceKey(credential)) {
    const apiUrl = config.baseUrl?.trim().replace(/\/+$/, '');
    if (!apiUrl) {
      throw new Error('SAP AI Core bearer-token setup requires the AI_API_URL endpoint');
    }
    return { accessToken: credential, apiUrl };
  }

  let key: SapServiceKey;
  try {
    key = JSON.parse(credential) as SapServiceKey;
  } catch (err: unknown) {
    providerLog.debug(
      { err: err instanceof Error ? err.message : String(err) },
      'SAP AI Core service key JSON parse failed',
    );
    throw new Error('Invalid SAP AI Core service key JSON');
  }
  if (!key.clientid || !key.clientsecret || !key.url) {
    throw new Error('SAP AI Core service key missing clientid, clientsecret, or url');
  }
  const apiUrl = (config.baseUrl || key.serviceurls?.AI_API_URL || '').trim().replace(/\/+$/, '');
  if (!apiUrl) {
    throw new Error('SAP AI Core service key missing serviceurls.AI_API_URL');
  }

  const tokenUrl = `${key.url.replace(/\/+$/, '')}/oauth/token`;
  const basic = Buffer.from(`${key.clientid}:${key.clientsecret}`).toString('base64');
  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
    signal: withTimeoutSignal(undefined, 30_000),
  });
  if (!response.ok) {
    const body = (await response.text()).slice(0, 200);
    throw new Error(`SAP AI Core OAuth failed: HTTP ${response.status}${body ? ` - ${body}` : ''}`);
  }
  const data = (await response.json()) as { access_token?: unknown };
  if (typeof data.access_token !== 'string' || !data.access_token) {
    throw new Error('SAP AI Core OAuth returned no access_token');
  }
  return { accessToken: data.access_token, apiUrl };
}

/**
 * Verify the authenticated tenant can see the explicitly configured running
 * deployment. This is a control-plane check; it does not generate content.
 */
export async function verifySapAiConnection(
  config: ProviderConfig,
): Promise<{ success: boolean; error?: string }> {
  const deploymentId = sapDeploymentId(config);
  if (!deploymentId) {
    return {
      success: false,
      error:
        'SAP AI Core requires an explicit deployment ID (AICORE_DEPLOYMENT_ID or AI-Deployment-Id).',
    };
  }
  try {
    const resolved = await resolveSapCredential(config);
    const response = await fetch(
      `${resolved.apiUrl}/v2/lm/deployments/${encodeURIComponent(deploymentId)}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${resolved.accessToken}`,
          'AI-Resource-Group': sapResourceGroup(config),
          Accept: 'application/json',
          'User-Agent': 'Koryphaios/1.0',
        },
        signal: withTimeoutSignal(undefined, 10_000),
      },
    );
    if (!response.ok) {
      const body = (await response.text()).slice(0, 240);
      return {
        success: false,
        error: `SAP AI Core deployment verification failed (HTTP ${response.status})${body ? `: ${body}` : ''}`,
      };
    }
    const payload = (await response.json()) as {
      id?: unknown;
      status?: unknown;
      deploymentUrl?: unknown;
    };
    if (payload.id !== deploymentId) {
      return { success: false, error: 'SAP AI Core returned a different deployment id' };
    }
    if (payload.status !== 'RUNNING') {
      return {
        success: false,
        error: `SAP AI Core deployment is not RUNNING (status: ${String(payload.status ?? 'unknown')})`,
      };
    }
    if (typeof payload.deploymentUrl !== 'string' || !payload.deploymentUrl.trim()) {
      return { success: false, error: 'SAP AI Core deployment returned no deploymentUrl' };
    }
    return { success: true };
  } catch (error: unknown) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export class SapAiProvider extends OpenAIProvider {
  private bearer: string | null = null;
  private sapClient: OpenAI | null = null;
  private resolvedApiUrl: string | null = null;

  constructor(config: ProviderConfig) {
    super(config, 'sapai', config.baseUrl);
  }

  override isAvailable(): boolean {
    const cred = this.config.apiKey || this.config.authToken;
    // Either a service key (JSON, carries AI_API_URL) or a token + explicit baseUrl.
    return (
      !this.config.disabled &&
      !!cred &&
      !!sapDeploymentId(this.config) &&
      (!!this.config.baseUrl || looksLikeServiceKey(cred))
    );
  }

  override listModels(): import('@koryphaios/shared').ModelDef[] {
    const deployment = sapDeploymentId(this.config);
    if (!this.isAvailable() || !deployment) return [];
    return [
      {
        id: deployment,
        apiModelId: deployment,
        name: `SAP AI Core deployment: ${deployment}`,
        provider: 'sapai',
        contextWindow: 0,
        maxOutputTokens: 0,
        contextVerified: false,
        isGeneric: true,
        supportsStreaming: true,
      },
    ];
  }

  override refreshModels(): Promise<void> {
    return Promise.resolve();
  }

  getModelDiscoveryError(): string | undefined {
    return sapDeploymentId(this.config)
      ? 'SAP deployment identity is user-configured; model family and limits remain unknown until runtime metadata is returned.'
      : 'SAP AI Core requires an explicit running deployment ID.';
  }

  protected override async prepareForModelDiscovery(): Promise<void> {
    await this.ensureToken();
  }

  override async *streamResponse(
    request: import('./types').StreamRequest,
  ): AsyncGenerator<import('./types').ProviderEvent> {
    await this.ensureToken();
    yield* super.streamResponse(request);
  }

  private resourceGroup(): string {
    return sapResourceGroup(this.config);
  }

  private deploymentBase(): string {
    const apiUrl = (this.resolvedApiUrl || this.config.baseUrl || '').replace(/\/+$/, '');
    if (apiUrl.includes('/v2/inference/deployments/')) return apiUrl;
    const deployment = sapDeploymentId(this.config);
    return deployment
      ? `${apiUrl}/v2/inference/deployments/${deployment}`
      : `${apiUrl}/v2/inference/deployments`;
  }

  protected override get client(): OpenAI {
    if (!this.sapClient) {
      this.sapClient = new OpenAI({
        apiKey: this.bearer || 'placeholder-awaiting-sap-oauth',
        baseURL: this.deploymentBase(),
        defaultHeaders: { 'AI-Resource-Group': this.resourceGroup() },
        // SAP's OpenAI proxy requires the api-version query param.
        defaultQuery: { 'api-version': SAP_API_VERSION },
        fetch: createUsageInterceptingFetch(globalThis.fetch),
      });
    }
    return this.sapClient;
  }

  private async ensureToken(): Promise<void> {
    if (this.bearer) return;
    const resolved = await resolveSapCredential(this.config);
    this.bearer = resolved.accessToken;
    this.resolvedApiUrl = resolved.apiUrl;
    this.sapClient = null; // rebuild client with the resolved token + api url
    providerLog.info({ provider: 'sapai' }, 'SAP AI Core access token resolved');
  }
}
