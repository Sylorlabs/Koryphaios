// AWS Bedrock provider — Claude models on Amazon Bedrock.
//
// Bedrock is NOT OpenAI-compatible: requests must be AWS SigV4-signed and sent to
// bedrock-runtime.{region}.amazonaws.com. The official `@anthropic-ai/bedrock-sdk`
// (AnthropicBedrock) produces exactly that wire shape (SigV4 + the Anthropic Messages
// API), so the protocol is correct by construction. We reuse AnthropicProvider's entire
// message-conversion + stream-parsing logic and only swap the underlying client.

import Anthropic from '@anthropic-ai/sdk';
import { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk';
import type { ModelDef, ProviderConfig } from '@koryphaios/shared';
import { AnthropicProvider } from './anthropic';
import { createUsageInterceptingFetch } from '../credit-accountant';
import { getModelsForProvider } from './types';

function awsRegion(): string {
  return process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
}

function hasAwsCredentials(): boolean {
  return !!(
    (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) ||
    process.env.AWS_PROFILE
  );
}

export class BedrockProvider extends AnthropicProvider {
  constructor(config: ProviderConfig) {
    super(config, 'bedrock');
  }

  override isAvailable(): boolean {
    // Bedrock authenticates via the AWS credential chain, not an apiKey/authToken.
    return !this.config.disabled && hasAwsCredentials();
  }

  /** Bedrock foundation model ids are region/account scoped — no Anthropic /models API. */
  override listModels(): ModelDef[] {
    return getModelsForProvider('bedrock');
  }

  protected override makeClient(): Anthropic {
    // AnthropicBedrock signs every request with AWS SigV4. Credentials come from the
    // standard AWS chain; set explicit keys only when present so the chain can resolve
    // a shared profile / instance role otherwise.
    const opts: Record<string, unknown> = {
      awsRegion: awsRegion(),
      fetch: createUsageInterceptingFetch(globalThis.fetch),
    };
    if (process.env.AWS_ACCESS_KEY_ID) opts.awsAccessKey = process.env.AWS_ACCESS_KEY_ID;
    if (process.env.AWS_SECRET_ACCESS_KEY) opts.awsSecretKey = process.env.AWS_SECRET_ACCESS_KEY;
    if (process.env.AWS_SESSION_TOKEN) opts.awsSessionToken = process.env.AWS_SESSION_TOKEN;
    // AnthropicBedrock shares the Anthropic Messages API surface — type-compatible for
    // our streamResponse usage.
    return new AnthropicBedrock(opts as ConstructorParameters<typeof AnthropicBedrock>[0]) as unknown as Anthropic;
  }
}
