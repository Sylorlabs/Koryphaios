// AWS Bedrock provider — Claude models on Amazon Bedrock.
//
// Bedrock is NOT OpenAI-compatible: requests must be AWS SigV4-signed and sent to
// bedrock-runtime.{region}.amazonaws.com. The official `@anthropic-ai/bedrock-sdk`
// (AnthropicBedrock) supplies SigV4 signing for the Anthropic Messages surface. We reuse
// AnthropicProvider's message conversion and parsing. A signed catalog probe establishes
// catalog access only; it does not prove bedrock:InvokeModel permission, Marketplace/model
// entitlement, Anthropic use-case approval, quota, or successful runtime inference.

import Anthropic from '@anthropic-ai/sdk';
import { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk';
import { BedrockClient, ListFoundationModelsCommand } from '@aws-sdk/client-bedrock';
import type { ModelDef, ProviderConfig } from '@koryphaios/shared';
import { AnthropicProvider } from './anthropic';
import { hasAwsCredentialSource } from './aws-credential-scan';
import { createUsageInterceptingFetch } from '../credit-accountant';
import { providerLog } from '../logger';

function awsRegion(override?: string): string {
  return override || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
}

function envAwsCredentialSource(): boolean {
  return !!(
    (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) ||
    process.env.AWS_PROFILE
  );
}

type BedrockModelSummary = {
  modelId?: string;
  modelName?: string;
  providerName?: string;
  inputModalities?: string[];
  outputModalities?: string[];
  responseStreamingSupported?: boolean;
};

type BedrockCatalogLoader = (region: string, signal: AbortSignal) => Promise<BedrockModelSummary[]>;

const loadBedrockCatalog: BedrockCatalogLoader = async (region, signal) => {
  const client = new BedrockClient({ region });
  const response = await client.send(
    new ListFoundationModelsCommand({
      byProvider: 'Anthropic',
      byOutputModality: 'TEXT',
    }),
    { abortSignal: signal },
  );
  return response.modelSummaries ?? [];
};

/**
 * Map only the model family whose wire protocol this adapter implements.
 * Catalog membership does not establish per-account invocation entitlement.
 * Bedrock exposes many providers and modalities, but the runtime below is
 * Anthropic Messages, not a universal Bedrock adapter.
 */
export function mapBedrockAnthropicTextModels(summaries: BedrockModelSummary[]): ModelDef[] {
  const models: ModelDef[] = [];
  const seen = new Set<string>();
  for (const summary of summaries) {
    const id = summary.modelId?.trim();
    const supportsTextOutput = (summary.outputModalities ?? []).includes('TEXT');
    if (
      !id ||
      seen.has(id) ||
      summary.providerName?.toLowerCase() !== 'anthropic' ||
      !supportsTextOutput
    ) {
      continue;
    }
    seen.add(id);
    models.push({
      id,
      apiModelId: id,
      name: summary.modelName?.trim() || id,
      provider: 'bedrock',
      contextWindow: 0,
      maxOutputTokens: 0,
      contextVerified: false,
      isGeneric: true,
      supportsStreaming: summary.responseStreamingSupported === true,
      supportsAttachments: (summary.inputModalities ?? []).includes('IMAGE'),
      vision: (summary.inputModalities ?? []).includes('IMAGE'),
    });
  }
  return models;
}

export class BedrockProvider extends AnthropicProvider {
  private discoveredModels: ModelDef[] = [];
  private modelsAt = 0;
  private modelsRequest: Promise<void> | null = null;
  private modelDiscoveryError: string | undefined;

  constructor(
    config: ProviderConfig,
    private readonly catalogLoader: BedrockCatalogLoader = loadBedrockCatalog,
  ) {
    super(config, 'bedrock');
  }

  /**
   * A credential source is either on the system (env vars, AWS shared
   * credentials/config files) or stored explicitly by the user via Settings
   * (apiKey = access key ID, authToken = secret access key).
   */
  private hasCredentialMaterial(): boolean {
    return (
      envAwsCredentialSource() ||
      hasAwsCredentialSource() ||
      !!(this.config.apiKey && this.config.authToken)
    );
  }

  private region(): string {
    return awsRegion(this.config.awsRegion);
  }

  override isAvailable(): boolean {
    // Presence only means "detected" to ProviderRegistry. Even a successful
    // control-plane catalog call does not establish runtime inference access.
    return !this.config.disabled && this.hasCredentialMaterial();
  }

  /**
   * This adapter implements Anthropic's Messages surface only. Return only the
   * Anthropic text models reported by Bedrock for the configured region; never
   * imply that Titan, Nova, Cohere, image, or embedding models work here.
   */
  override listModels(): ModelDef[] {
    if (!this.isAvailable()) return [];
    if (Date.now() - this.modelsAt > 5 * 60_000) void this.refreshModels(true);
    return this.discoveredModels;
  }

  refreshModels(forceRefresh = false): Promise<void> {
    if (!forceRefresh || !this.isAvailable()) return Promise.resolve();
    if (this.modelsRequest) return this.modelsRequest;
    this.modelsRequest = this.discoverAnthropicModels().finally(() => {
      this.modelsRequest = null;
    });
    return this.modelsRequest;
  }

  getModelDiscoveryError(): string | undefined {
    return this.modelDiscoveryError;
  }

  async verifyAccess(): Promise<{ success: boolean; state?: 'detected'; error?: string }> {
    if (!this.hasCredentialMaterial()) {
      return {
        success: false,
        error:
          'No AWS credential source detected on this system. Enter an access key ID and secret access key, or configure the AWS CLI.',
      };
    }
    await this.discoverAnthropicModels();
    if (this.modelDiscoveryError) return { success: false, error: this.modelDiscoveryError };
    if (this.discoveredModels.length === 0) {
      return {
        success: false,
        error:
          'AWS credentials were accepted, but Bedrock reported no Anthropic text models in this region.',
      };
    }
    return { success: true, state: 'detected' };
  }

  private async discoverAnthropicModels(): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const summaries = await this.catalogLoader(this.region(), controller.signal);
      const models = mapBedrockAnthropicTextModels(summaries);
      this.discoveredModels = models;
      this.modelsAt = Date.now();
      this.modelDiscoveryError = undefined;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.modelDiscoveryError = `AWS Bedrock catalog access check failed in ${this.region()}: ${message}`;
      providerLog.debug(
        { provider: 'bedrock', region: this.region(), error: message },
        'Bedrock Anthropic catalog discovery failed',
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  protected override makeClient(): Anthropic {
    // AnthropicBedrock signs every request with AWS SigV4. Credentials come from the
    // standard AWS chain; explicit keys (env first, then user-entered settings values)
    // are set only when present so the chain can resolve a shared profile / instance
    // role otherwise.
    const accessKey = process.env.AWS_ACCESS_KEY_ID || this.config.apiKey;
    const secretKey = process.env.AWS_SECRET_ACCESS_KEY || this.config.authToken;
    const sessionToken = process.env.AWS_SESSION_TOKEN || this.config.awsSessionToken;
    const opts: Record<string, unknown> = {
      awsRegion: this.region(),
      fetch: createUsageInterceptingFetch(globalThis.fetch),
    };
    if (accessKey) opts.awsAccessKey = accessKey;
    if (secretKey) opts.awsSecretKey = secretKey;
    if (sessionToken) opts.awsSessionToken = sessionToken;
    // AnthropicBedrock shares the Anthropic Messages API surface — type-compatible for
    // our streamResponse usage.
    return new AnthropicBedrock(
      opts as ConstructorParameters<typeof AnthropicBedrock>[0],
    ) as unknown as Anthropic;
  }
}
