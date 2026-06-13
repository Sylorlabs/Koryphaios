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
import type { ProviderConfig, ModelDef } from '@koryphaios/shared';
import { OpenAIProvider } from './openai';
import { createUsageInterceptingFetch } from '../credit-accountant';
import { getModelsForProvider } from './types';
import { withTimeoutSignal } from './utils';
import { providerLog } from '../logger';

const SAP_API_VERSION = process.env.AICORE_API_VERSION || '2024-02-01';

interface SapServiceKey {
  clientid?: string;
  clientsecret?: string;
  url?: string;
  serviceurls?: { AI_API_URL?: string };
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
    return !this.config.disabled && !!cred && (!!this.config.baseUrl || this.looksLikeServiceKey(cred));
  }

  override listModels(): ModelDef[] {
    return getModelsForProvider('sapai');
  }

  override async *streamResponse(
    request: import('./types').StreamRequest,
  ): AsyncGenerator<import('./types').ProviderEvent> {
    await this.ensureToken();
    yield* super.streamResponse(request);
  }

  private looksLikeServiceKey(cred?: string): boolean {
    return !!cred && cred.trim().startsWith('{');
  }

  private resourceGroup(): string {
    return (
      process.env.AICORE_RESOURCE_GROUP ||
      (this.config.headers?.['AI-Resource-Group'] as string) ||
      'default'
    );
  }

  private deploymentBase(): string {
    const apiUrl = (this.resolvedApiUrl || this.config.baseUrl || '').replace(/\/+$/, '');
    if (apiUrl.includes('/v2/inference/deployments/')) return apiUrl;
    const deployment =
      process.env.AICORE_DEPLOYMENT_ID ||
      (this.config.headers?.['AI-Deployment-Id'] as string) ||
      '';
    return deployment ? `${apiUrl}/v2/inference/deployments/${deployment}` : `${apiUrl}/v2/inference/deployments`;
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
    const cred = (this.config.apiKey || this.config.authToken || '').trim();
    if (!cred) throw new Error('SAP AI Core requires a service key (JSON) or bearer token');

    if (this.looksLikeServiceKey(cred)) {
      let key: SapServiceKey;
      try {
        key = JSON.parse(cred) as SapServiceKey;
      } catch {
        throw new Error('Invalid SAP AI Core service key JSON');
      }
      if (!key.clientid || !key.clientsecret || !key.url) {
        throw new Error('SAP AI Core service key missing clientid/clientsecret/url');
      }
      this.resolvedApiUrl = this.config.baseUrl || key.serviceurls?.AI_API_URL || null;
      const tokenUrl = `${key.url.replace(/\/+$/, '')}/oauth/token`;
      const basic = Buffer.from(`${key.clientid}:${key.clientsecret}`).toString('base64');
      const res = await fetch(tokenUrl, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basic}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'grant_type=client_credentials',
        signal: withTimeoutSignal(undefined, 30_000),
      });
      if (!res.ok) {
        const body = (await res.text()).slice(0, 200);
        throw new Error(`SAP AI Core OAuth failed: HTTP ${res.status}${body ? ` - ${body}` : ''}`);
      }
      const data = (await res.json()) as { access_token?: string };
      if (!data.access_token) throw new Error('SAP AI Core OAuth returned no access_token');
      this.bearer = data.access_token;
    } else {
      // Pre-obtained bearer token; baseUrl must be the AI_API_URL.
      this.bearer = cred;
      this.resolvedApiUrl = this.config.baseUrl ?? null;
    }
    this.sapClient = null; // rebuild client with the resolved token + api url
    providerLog.info({ provider: 'sapai' }, 'SAP AI Core access token resolved');
  }
}
