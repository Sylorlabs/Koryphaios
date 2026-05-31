/**
 * OpenAI-Compatible Provider Plugin
 *
 * Base implementation for OpenAI-compatible APIs. Handles the common
 * request/response patterns while allowing per-provider customization.
 */

import type {
  ProviderPlugin,
  ModelCapabilities,
  ProviderCapabilities,
  HealthStatus,
  DiscoveredModel,
} from './types';
import type { ProviderConfig, ProviderName, ModelDef } from '@koryphaios/shared';
import type { StreamRequest, ProviderEvent } from '../types';
import { providerLog } from '../../logger';

// ─── Configuration ──────────────────────────────────────────────────────────

export interface OpenAICompatibleConfig extends ProviderConfig {
  baseUrl: string;
  apiKey?: string;
  authToken?: string;

  /**
   * Provider-specific API transformations.
   * Override methods to handle provider quirks.
   */
  transforms?: APITransforms;

  /** Default headers to include */
  defaultHeaders?: Record<string, string>;

  /** Request timeout in ms */
  timeoutMs?: number;
}

export interface APITransforms {
  /** Transform request body before sending */
  transformRequest?(body: unknown): unknown;

  /** Transform response chunk before yielding */
  transformResponse?(chunk: unknown): ProviderEvent | null;

  /** Extract model list from discovery response */
  extractModels?(response: unknown): Array<{ id: string; name?: string }>;

  /** Build authentication headers */
  buildAuthHeaders(config: OpenAICompatibleConfig): Record<string, string>;

  /** Build the streaming endpoint URL */
  buildChatUrl(baseUrl: string): string;

  /** Build the model discovery URL */
  buildModelsUrl(baseUrl: string): string;
}

// ─── Default Transforms ─────────────────────────────────────────────────────

export const defaultTransforms: APITransforms = {
  buildAuthHeaders(config): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'Koryphaios/2.0',
    };

    if (config.apiKey) {
      headers['Authorization'] = `Bearer ${config.apiKey}`;
    } else if (config.authToken) {
      headers['Authorization'] = `Bearer ${config.authToken}`;
    }

    return headers;
  },

  buildChatUrl(baseUrl: string): string {
    return `${baseUrl.replace(/\/$/, '')}/chat/completions`;
  },

  buildModelsUrl(baseUrl: string): string {
    return `${baseUrl.replace(/\/$/, '')}/models`;
  },

  extractModels(response: unknown): Array<{ id: string; name?: string }> {
    if (typeof response !== 'object' || response === null) return [];
    const data = (response as { data?: unknown[] }).data;
    if (!Array.isArray(data)) return [];

    return data
      .filter((m): m is { id: string } => typeof m === 'object' && m !== null && 'id' in m)
      .map((m) => ({ id: m.id, name: m.id }));
  },
};

// ─── OpenAI Compatible Plugin Implementation ────────────────────────────────

export class OpenAICompatiblePlugin implements ProviderPlugin {
  readonly name: ProviderName;
  readonly capabilities: ProviderCapabilities;
  readonly config: OpenAICompatibleConfig;

  private transforms: APITransforms;
  private initialized = false;
  private abortController: AbortController | null = null;

  constructor(
    name: ProviderName,
    config: OpenAICompatibleConfig,
    capabilities?: Partial<ProviderCapabilities>,
  ) {
    this.name = name;
    this.config = {
      ...config,
      timeoutMs: config.timeoutMs ?? 60000,
    };
    this.transforms = { ...defaultTransforms, ...config.transforms };
    this.capabilities = {
      supportsDiscovery: true,
      supportsStreaming: true,
      authMethods: config.apiKey ? ['api_key'] : config.authToken ? ['jwt'] : [],
      ...capabilities,
    };
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Validate we have required auth
    if (!this.config.apiKey && !this.config.authToken) {
      throw new Error(`Plugin ${this.name}: No authentication configured`);
    }

    this.initialized = true;
    providerLog.info({ provider: this.name }, 'OpenAI-compatible plugin initialized');
  }

  isAvailable(): boolean {
    return this.initialized && (!!this.config.apiKey || !!this.config.authToken);
  }

  async fetchModels(): Promise<DiscoveredModel[]> {
    const url = this.transforms.buildModelsUrl!(this.config.baseUrl);
    const headers = this.transforms.buildAuthHeaders!(this.config);

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers,
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch models: ${response.status}`);
      }

      const data = await response.json();
      const models = this.transforms.extractModels!(data);

      return models.map((m) => ({
        id: m.id,
        name: m.name ?? m.id,
        provider: this.name,
        contextWindow: 0, // Will be populated by capability probing
        maxOutputTokens: 4096,
        costPerMInputTokens: 0,
        costPerMOutputTokens: 0,
        supportsStreaming: true,
        discoveredAt: Date.now(),
        capabilities: this.inferCapabilities(m.id),
        isDynamic: true,
        isGeneric: true,
      }));
    } catch (error) {
      providerLog.error(
        { provider: this.name, error: (error as Error).message },
        'Failed to fetch models',
      );
      return [];
    }
  }

  async getCapabilities(modelId: string): Promise<ModelCapabilities> {
    // Try to infer from known patterns
    return this.inferCapabilities(modelId);
  }

  async healthCheck(): Promise<HealthStatus> {
    const startTime = Date.now();

    try {
      // Try to fetch models as health check
      const url = this.transforms.buildModelsUrl!(this.config.baseUrl);
      const headers = this.transforms.buildAuthHeaders!(this.config);

      const response = await fetch(url, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(10000),
      });

      const latencyMs = Date.now() - startTime;

      if (response.ok) {
        return { status: 'healthy', latencyMs };
      }

      if (response.status === 401 || response.status === 403) {
        return {
          status: 'unavailable',
          reason: 'Authentication failed',
          retryAfter: 0, // Don't retry auth failures
        };
      }

      if (response.status === 429) {
        const retryAfter = response.headers.get('retry-after');
        return {
          status: 'degraded',
          latencyMs,
          issues: ['Rate limited'],
          retryAfter: retryAfter ? parseInt(retryAfter, 10) * 1000 : 60000,
        };
      }

      return {
        status: 'degraded',
        latencyMs,
        issues: [`HTTP ${response.status}`],
      };
    } catch (error) {
      return {
        status: 'unavailable',
        reason: (error as Error).message,
      };
    }
  }

  async *stream(request: StreamRequest): AsyncGenerator<ProviderEvent> {
    if (!this.initialized) {
      throw new Error('Plugin not initialized');
    }

    const url = this.transforms.buildChatUrl!(this.config.baseUrl);
    const headers = this.transforms.buildAuthHeaders!(this.config);

    const body = this.buildRequestBody(request);
    const transformedBody = this.transforms.transformRequest
      ? this.transforms.transformRequest(body)
      : body;

    this.abortController = new AbortController();

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          ...headers,
          Accept: 'text/event-stream',
        },
        body: JSON.stringify(transformedBody),
        signal: this.abortController.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        yield {
          type: 'error',
          error: `HTTP ${response.status}: ${errorText}`,
        };
        return;
      }

      if (!response.body) {
        yield { type: 'error', error: 'No response body' };
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            const event = this.parseSSELine(line);
            if (event) {
              const transformed = this.transforms.transformResponse
                ? this.transforms.transformResponse(event)
                : this.defaultTransformResponse(event);

              if (transformed) {
                yield transformed;
              }
            }
          }
        }
      } finally {
        reader.releaseLock();
      }

      yield { type: 'complete' };
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        yield { type: 'error', error: 'Request aborted' };
      } else {
        yield { type: 'error', error: (error as Error).message };
      }
    }
  }

  async dispose(): Promise<void> {
    if (this.abortController) {
      this.abortController.abort();
    }
    this.initialized = false;
  }

  // ─── Private Helpers ──────────────────────────────────────────────────────

  private buildRequestBody(request: StreamRequest): unknown {
    return {
      model: request.model,
      messages: request.messages.map((m) => ({
        role: m.role,
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      })),
      stream: true,
      max_tokens: request.maxTokens,
      temperature: request.temperature,
      ...(request.tools?.length && {
        tools: request.tools.map((t) => ({
          type: 'function',
          function: {
            name: t.name,
            description: t.description,
            parameters: t.inputSchema,
          },
        })),
      }),
    };
  }

  private parseSSELine(line: string): unknown | null {
    if (!line.startsWith('data: ')) return null;
    const data = line.slice(6);
    if (data === '[DONE]') return null;

    try {
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  private defaultTransformResponse(chunk: unknown): ProviderEvent | null {
    if (typeof chunk !== 'object' || chunk === null) return null;

    const c = chunk as {
      choices?: Array<{
        delta?: {
          content?: string;
          tool_calls?: unknown[];
        };
        finish_reason?: string;
      }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
      };
    };

    const delta = c.choices?.[0]?.delta;
    if (!delta) return null;

    if (delta.content) {
      return {
        type: 'content_delta',
        content: delta.content,
      };
    }

    if (c.usage) {
      return {
        type: 'usage_update',
        tokensIn: c.usage.prompt_tokens,
        tokensOut: c.usage.completion_tokens,
      };
    }

    const finishReason = c.choices?.[0]?.finish_reason;
    if (finishReason) {
      return {
        type: 'complete',
        finishReason: finishReason as 'end_turn' | 'tool_use' | 'max_tokens' | 'stop',
      };
    }

    return null;
  }

  private inferCapabilities(modelId: string): ModelCapabilities {
    // Infer capabilities from model ID patterns
    const id = modelId.toLowerCase();

    const contextWindow = id.includes('32k')
      ? 32768
      : id.includes('128k')
        ? 128000
        : id.includes('200k')
          ? 200000
          : id.includes('1m')
            ? 1000000
            : 8192;

    const supportsVision = id.includes('vision') || id.includes('gpt-4o');
    const supportsTools = !id.includes('instruct');
    const supportsReasoning = id.includes('o1') || id.includes('o3') || id.includes('reasoning');

    return {
      contextWindow,
      maxOutputTokens: id.includes('mini') ? 8192 : 4096,
      modalities: supportsVision ? ['text', 'image'] : ['text'],
      tools: {
        supported: supportsTools,
        streaming: true,
        parallel: true,
      },
      reasoning: supportsReasoning
        ? {
            supported: true,
            levels: ['low', 'medium', 'high'],
          }
        : undefined,
      vision: supportsVision
        ? {
            supported: true,
            maxImages: 10,
          }
        : undefined,
      structuredOutput: supportsTools,
      streaming: true,
    };
  }
}
