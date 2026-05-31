import OpenAI from 'openai';
import type { ModelDef, ProviderConfig } from '@koryphaios/shared';
import { createUsageInterceptingFetch } from '../credit-accountant';
import { getModelsForProvider } from './types';
import { OpenAIProvider } from './openai';
import {
  isKimiCodeAuthMarker,
  loadKimiCodeAuthState,
  resolveKimiCodeAccessToken,
} from './kimicode-auth';

const KIMICODE_BASE_URL = 'https://api.kimi.com/coding/v1';

export class KimiCodeProvider extends OpenAIProvider {
  private currentAccessToken: string | null = null;
  private kimiClient: OpenAI | null = null;

  constructor(config: ProviderConfig) {
    super(config, 'kimicode', config.baseUrl ?? KIMICODE_BASE_URL);
  }

  override isAvailable(): boolean {
    if (this.config.disabled) return false;
    const authToken = this.config.authToken?.trim();
    if (!authToken) return false;
    if (isKimiCodeAuthMarker(authToken)) {
      return !!loadKimiCodeAuthState()?.accessToken;
    }
    return true;
  }

  override listModels(): ModelDef[] {
    return getModelsForProvider('kimicode');
  }

  protected override get client(): OpenAI {
    if (!this.kimiClient) {
      this.kimiClient = new OpenAI({
        apiKey: this.currentAccessToken || 'placeholder-awaiting-kimi-auth',
        baseURL: this.config.baseUrl ?? KIMICODE_BASE_URL,
        defaultHeaders: this.config.headers,
        fetch: createUsageInterceptingFetch(globalThis.fetch),
      });
    }
    return this.kimiClient;
  }

  override async *streamResponse(
    request: import('./types').StreamRequest,
  ): AsyncGenerator<import('./types').ProviderEvent> {
    await this.ensureAccessToken();
    yield* super.streamResponse(request);
  }

  private async ensureAccessToken(): Promise<void> {
    const accessToken = await resolveKimiCodeAccessToken(this.config.authToken);
    if (!accessToken) {
      throw new Error('Kimi Code auth token not found. Sign in with Kimi Code again.');
    }
    if (accessToken !== this.currentAccessToken) {
      this.currentAccessToken = accessToken;
      this.kimiClient = null;
    }
  }
}
