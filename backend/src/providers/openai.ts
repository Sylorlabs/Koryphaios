// OpenAI provider — supports GPT-4.1, O3, O4-mini, Codex.
// Also used as base for Groq, OpenRouter, xAI (OpenAI-compatible endpoints).

import OpenAI from "openai";
import type { ProviderConfig, ProviderName, ModelDef } from "@koryphaios/shared";
import { detectCodexToken } from "./auth-utils";

import {
  type Provider,
  type ProviderEvent,
  type StreamRequest,
  type ProviderContentBlock,
  getModelsForProvider,
  resolveModel,
  createGenericModel,
} from "./types";
import { withRetry } from "./utils";

export class OpenAIProvider implements Provider {
  private _client: OpenAI | null = null;

  constructor(
    readonly config: ProviderConfig,
    readonly name: ProviderName = "openai",
    private baseUrl?: string,
  ) {}

  protected get client(): OpenAI {
    if (!this._client) {
      const apiKey = this.config.apiKey || this.config.authToken;
      this._client = new OpenAI({
        apiKey: apiKey || "placeholder",
        baseURL: this.baseUrl ?? this.config.baseUrl,
        defaultHeaders: this.config.headers,
      });
    }
    return this._client;
  }

  isAvailable(): boolean {
    return !this.config.disabled && !!(this.config.apiKey || this.config.authToken);
  }

  private cachedModels: ModelDef[] | null = null;
  private lastFetch = 0;

  async listModels(): Promise<ModelDef[]> {
    const localModels = getModelsForProvider(this.name);

    if (!this.isAvailable()) {
      return localModels;
    }

    if (this.cachedModels && Date.now() - this.lastFetch < 5 * 60 * 1000) {
      return this.cachedModels;
    }

    try {
      const response = await withRetry(() => this.client.models.list());

      const remoteModels: ModelDef[] = [];
      for await (const model of response) {
        const id = model.id;
        const existing = localModels.find(m => m.apiModelId === id || m.id === id);
        if (existing) continue;

        // Filter for chat models
        const lowerId = id.toLowerCase();
        if (lowerId.includes("gpt") || lowerId.includes("o1") || lowerId.includes("o3") || lowerId.includes("o4")) {
          remoteModels.push(createGenericModel(id, this.name));
        }
      }

      this.cachedModels = [...localModels, ...remoteModels];
      this.lastFetch = Date.now();
      return this.cachedModels;
    } catch (err) {
      return localModels;
    }
  }

  async *streamResponse(request: StreamRequest): AsyncGenerator<ProviderEvent> {
    const messages = this.convertMessages(request);
    const tools = request.tools?.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }));

    // Check if the specific model supports reasoning
    const modelDef = resolveModel(request.model);
    const canReason = modelDef?.canReason ?? false;
    const reasoningEffort = request.reasoningLevel?.toLowerCase();
    const supportedEfforts = ["none", "minimal", "low", "medium", "high", "xhigh"];

    const params: OpenAI.ChatCompletionCreateParamsStreaming = {
      model: modelDef?.apiModelId ?? request.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      ...(request.maxTokens && { max_completion_tokens: request.maxTokens }),
      ...(request.temperature !== undefined && { temperature: request.temperature }),
      ...(tools?.length && { tools }),
      // Only send reasoning_effort if model + selected level supports it.
      ...(canReason && reasoningEffort && supportedEfforts.includes(reasoningEffort) && {
        reasoning_effort: reasoningEffort as any
      }),
    };

    try {
      const stream = await withRetry(() =>
        this.client.chat.completions.create(params, {
          signal: request.signal,
        })
      );

      const toolCallBuffers = new Map<number, { id: string; name: string; args: string }>();

      for await (const chunk of stream) {
        const choice = chunk.choices?.[0];
        if (!choice) {
          if (chunk.usage) {
            yield {
              type: "usage_update",
              tokensIn: chunk.usage.prompt_tokens,
              tokensOut: chunk.usage.completion_tokens,
              tokensCache: (chunk.usage as any).prompt_tokens_details?.cached_tokens,
            };
          }
          continue;
        }

        const delta = choice.delta;

        // Content streaming
        if (delta?.content) {
          yield { type: "content_delta", content: delta.content };
        }

        // Reasoning content (O-series models)
        if ((delta as any)?.reasoning_content) {
          yield { type: "thinking_delta", thinking: (delta as any).reasoning_content };
        }

        // Tool call streaming
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index;
            if (!toolCallBuffers.has(idx)) {
              toolCallBuffers.set(idx, { id: tc.id ?? "", name: tc.function?.name ?? "", args: "" });
              yield {
                type: "tool_use_start",
                toolCallId: tc.id,
                toolName: tc.function?.name,
              };
            }

            const buf = toolCallBuffers.get(idx)!;
            if (tc.id) buf.id = tc.id;
            if (tc.function?.name) buf.name = tc.function.name;
            if (tc.function?.arguments) {
              buf.args += tc.function.arguments;
              yield {
                type: "tool_use_delta",
                toolCallId: buf.id,
                toolName: buf.name,
                toolInput: tc.function.arguments,
              };
            }
          }
        }

        // Completion
        if (choice.finish_reason) {
          // Emit all tool call completions
          for (const [, buf] of toolCallBuffers) {
            yield {
              type: "tool_use_stop",
              toolCallId: buf.id,
              toolName: buf.name,
              toolInput: buf.args,
            };
          }
          toolCallBuffers.clear();

          yield {
            type: "complete",
            finishReason: choice.finish_reason === "tool_calls" ? "tool_use" : "end_turn",
          };
        }
      }
    } catch (err: any) {
      if (err.name === "AbortError") return;
      yield { type: "error", error: err.message ?? String(err) };
    }
  }

  protected convertMessages(request: StreamRequest): OpenAI.ChatCompletionMessageParam[] {
    const result: OpenAI.ChatCompletionMessageParam[] = [];

    if (request.systemPrompt) {
      result.push({ role: "system", content: request.systemPrompt });
    }

    for (const msg of request.messages) {
      if (msg.role === "system") continue;

      if (typeof msg.content === "string") {
        result.push({ role: msg.role as any, content: msg.content });
        continue;
      }

      const blocks = msg.content as ProviderContentBlock[];
      if (msg.role === "assistant") {
        const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
        const toolCalls = blocks
          .filter((b) => b.type === "tool_use")
          .map((b) => ({
            id: b.toolCallId ?? "",
            type: "function" as const,
            function: { name: b.toolName ?? "", arguments: JSON.stringify(b.toolInput ?? {}) },
          }));

        result.push({
          role: "assistant",
          content: text || null,
          ...(toolCalls.length && { tool_calls: toolCalls }),
        });
      } else if (msg.role === "user") {
        // Check for tool results
        const toolResults = blocks.filter((b) => b.type === "tool_result");
        if (toolResults.length) {
          for (const tr of toolResults) {
            result.push({
              role: "tool",
              tool_call_id: tr.toolCallId ?? "",
              content: tr.toolOutput ?? "",
            });
          }
        } else {
          const content: OpenAI.ChatCompletionContentPart[] = blocks.map((b) => {
            if (b.type === "image") {
              return {
                type: "image_url",
                image_url: { url: `data:${b.imageMimeType};base64,${b.imageData}` },
              };
            }
            return { type: "text", text: b.text ?? "" };
          });
          result.push({ role: "user", content });
        }
      }
    }

    return result;
  }
}

// ─── OpenAI-Compatible Provider Factories ───────────────────────────────────

export class GroqProvider extends OpenAIProvider {
  constructor(config: ProviderConfig) {
    super(config, "groq", "https://api.groq.com/openai/v1");
  }
}

export class OpenRouterProvider extends OpenAIProvider {
  constructor(config: ProviderConfig) {
    super(config, "openrouter", "https://openrouter.ai/api/v1");
  }
}

export class XAIProvider extends OpenAIProvider {
  constructor(config: ProviderConfig) {
    super(config, "xai", "https://api.x.ai/v1");
  }
}

export class AzureProvider extends OpenAIProvider {
  constructor(config: ProviderConfig) {
    super(config, "azure", config.baseUrl);
  }
}
