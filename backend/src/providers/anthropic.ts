// Anthropic Claude provider — supports Claude 3.5/3.7/4 Sonnet, Opus, Haiku.
// Uses extended thinking for reasoning models. Never restricts output quality.
// Supports both API key and Claude Code OAuth token (Pro/Max subscription).

import Anthropic from "@anthropic-ai/sdk";
import type { ProviderConfig, ModelDef } from "@koryphaios/shared";
import {
  type Provider,
  type ProviderEvent,
  type StreamRequest,
  type ProviderContentBlock,
  getModelsForProvider,
  createGenericModel,
} from "./types";
import { withRetry, withTimeoutSignal } from "./utils";
import { detectClaudeCodeToken } from "./auth-utils";
import { createUsageInterceptingFetch } from "../credit-accountant";
import { providerLog } from "../logger";

export class AnthropicProvider implements Provider {
  readonly name: "anthropic";
  private _client: Anthropic | null = null;

  constructor(readonly config: ProviderConfig) {
    this.name = "anthropic";
  }

  /** Resolved auth: config first, then CLI/env detection so UI "connected" and resolution stay in sync. */
  private get effectiveAuthToken(): string | undefined {
    return this.config.authToken ?? detectClaudeCodeToken() ?? undefined;
  }

  protected get client(): Anthropic {
    if (!this._client) {
      this._client = new Anthropic({
        apiKey: this.config.apiKey,
        authToken: this.effectiveAuthToken,
        ...(this.config.baseUrl && { baseURL: this.config.baseUrl }),
        fetch: createUsageInterceptingFetch(globalThis.fetch),
      });
    }
    return this._client;
  }

  isAvailable(): boolean {
    return !this.config.disabled && !!(this.config.apiKey || this.config.authToken || detectClaudeCodeToken());
  }

  private cachedModels: ModelDef[] | null = null;
  private lastFetch = 0;

  listModels(): ModelDef[] {
    const localModels = getModelsForProvider(this.name);

    if (!this.isAvailable()) {
      return localModels;
    }

    if (this.cachedModels && Date.now() - this.lastFetch < 5 * 60 * 1000) {
      return this.cachedModels;
    }

    // Trigger background refresh
    this.refreshModelsInBackground(localModels);
    return this.cachedModels ?? localModels;
  }

  private refreshModelsInBackground(localModels: ModelDef[]) {
    withRetry(() => this.client.models.list())
      .then((response) => {
        const remoteModels: ModelDef[] = [];
        for (const model of response.data) {
          const id = model.id;
          const existing = localModels.find(m => m.apiModelId === id || m.id === id);
          if (existing) continue;
          remoteModels.push(createGenericModel(id, this.name));
        }
        this.cachedModels = [...localModels, ...remoteModels];
        this.lastFetch = Date.now();
      })
      .catch(() => {
        if (!this.cachedModels) this.cachedModels = localModels;
      });
  }

  async *streamResponse(request: StreamRequest): AsyncGenerator<ProviderEvent> {
    const messages = this.convertMessages(request.messages);
    const tools = request.tools?.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
    }));

    const params: Anthropic.MessageCreateParamsStreaming = {
      model: request.model,
      max_tokens: request.maxTokens ?? 16_384,
      system: request.systemPrompt,
      messages,
      stream: true,
      ...(tools?.length && { tools }),
    };

    // Extended thinking: Claude 3.7 Sonnet supports thinking with budget_tokens
    const isClaude37 = /claude-3-7-sonnet/i.test(request.model || "");

    if (request.reasoningLevel !== undefined && request.reasoningLevel !== "") {
      const level = String(request.reasoningLevel).toLowerCase().trim();
      const outputTokens = request.maxTokens ?? 16_384;

      if (isClaude37) {
        // Claude 3.7 Sonnet: extended thinking with budget_tokens
        let thinkingBudget = 8192;
        if (level === "off" || level === "none" || level === "0") {
          thinkingBudget = 0;
        } else if (level === "on" || level === "low") {
          thinkingBudget = 4096;
        } else if (level === "medium") {
          thinkingBudget = 8192;
        } else if (level === "high" || level === "max" || level === "xhigh") {
          thinkingBudget = 16384;
        } else if (!isNaN(Number(level))) {
          thinkingBudget = Number(level);
        }
        if (thinkingBudget > 0) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK types lag behind API; thinking not yet typed
          (params as unknown as Record<string, unknown>).thinking = { type: "enabled", budget_tokens: thinkingBudget };
          params.max_tokens = thinkingBudget + outputTokens;
        }
      }
      // Other Anthropic models don't support reasoning controls
    }

    try {
      // Apply 60-second hard timeout to prevent indefinite hangs
      const timeoutSignal = withTimeoutSignal(request.signal, 60_000);
      const stream = await withRetry(() => this.client.messages.stream(params, {
        signal: timeoutSignal,
      }), { providerName: this.name, modelName: request.model });

      let currentToolCallId = "";
      let currentToolName = "";
      let toolInputBuffer = "";

      for await (const event of stream) {
        switch (event.type) {
          case "content_block_start": {
            const block = event.content_block;
            if (block.type === "tool_use") {
              currentToolCallId = block.id;
              currentToolName = block.name;
              toolInputBuffer = "";
              yield {
                type: "tool_use_start",
                toolCallId: block.id,
                toolName: block.name,
              };
            } else if (block.type === "thinking") {
              yield { type: "thinking_delta", thinking: block.thinking };
            }
            break;
          }

          case "content_block_delta": {
            const delta = event.delta;
            if (delta.type === "text_delta") {
              yield { type: "content_delta", content: delta.text };
            } else if (delta.type === "thinking_delta") {
              yield { type: "thinking_delta", thinking: delta.thinking };
            } else if (delta.type === "input_json_delta") {
              toolInputBuffer += delta.partial_json;
              yield {
                type: "tool_use_delta",
                toolCallId: currentToolCallId,
                toolName: currentToolName,
                toolInput: delta.partial_json,
              };
            }
            break;
          }

          case "content_block_stop": {
            if (currentToolCallId) {
              yield {
                type: "tool_use_stop",
                toolCallId: currentToolCallId,
                toolName: currentToolName,
                toolInput: toolInputBuffer,
              };
              currentToolCallId = "";
              currentToolName = "";
              toolInputBuffer = "";
            }
            break;
          }

          case "message_delta": {
            // SDK types event.usage for message_delta
            const usage = (event as unknown as Record<string, unknown>).usage as { output_tokens?: number } | undefined;
            yield {
              type: "usage_update",
              tokensOut: usage?.output_tokens,
            };
            yield {
              type: "complete",
              finishReason: event.delta.stop_reason === "tool_use" ? "tool_use" : "end_turn",
            };
            break;
          }

          case "message_start": {
            const usage = event.message.usage;
            yield {
              type: "usage_update",
              tokensIn: usage.input_tokens,
              tokensOut: usage.output_tokens,
              // Anthropic reports cache reads in usage.cache_read_input_tokens
              tokensCache: (usage as unknown as Record<string, unknown>).cache_read_input_tokens as number | undefined,
            };
            break;
          }
        }
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") return;
      
      // Log full error details for debugging
      const anthropicErr = err as { status?: number; error?: { code?: string; type?: string }; code?: string };
      const errorDetail = {
        message: err instanceof Error ? err.message : String(err),
        name: err instanceof Error ? err.name : undefined,
        status: anthropicErr?.status,
        code: anthropicErr?.error?.code || anthropicErr?.code,
        type: anthropicErr?.error?.type,
      };
      providerLog.error({ errorDetail, model: request.model }, "Anthropic provider stream error");
      
      yield { type: "error", error: errorDetail.message };
    }
  }

  private convertMessages(messages: StreamRequest["messages"]): Anthropic.MessageParam[] {
    return messages
      .filter((m) => m.role !== "system")
      .map((m) => {
        if (typeof m.content === "string") {
          if (m.role === "tool") {
            return {
              role: "user",
              content: [{ type: "tool_result", tool_use_id: m.tool_call_id ?? "", content: m.content, is_error: false }],
            } as Anthropic.MessageParam;
          }
          if (m.role === "assistant" && m.tool_calls?.length) {
            const blocks: Anthropic.ContentBlockParam[] = [];
            if (m.content) blocks.push({ type: "text", text: m.content });
            for (const tc of m.tool_calls) {
              blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input ?? {} });
            }
            return { role: "assistant", content: blocks } as Anthropic.MessageParam;
          }
          return { role: m.role as "user" | "assistant", content: m.content };
        }

        const blocks = m.content as ProviderContentBlock[];
        const anthropicContent: Anthropic.ContentBlockParam[] = blocks.map((b) => {
          if (b.type === "text") {
            return { type: "text", text: b.text ?? "" };
          }
          if (b.type === "tool_use") {
            return {
              type: "tool_use",
              id: b.toolCallId ?? "",
              name: b.toolName ?? "",
              input: b.toolInput ?? {},
            };
          }
          if (b.type === "tool_result") {
            return {
              type: "tool_result",
              tool_use_id: b.toolCallId ?? "",
              content: b.toolOutput ?? "",
              is_error: b.isError ?? false,
            };
          }
          if (b.type === "image") {
            return {
              type: "image",
              source: {
                type: "base64",
                media_type: (b.imageMimeType ?? "image/png") as "image/png" | "image/jpeg" | "image/gif" | "image/webp",
                data: b.imageData ?? "",
              },
            };
          }
          return { type: "text", text: "" };
        });

        return { role: m.role as "user" | "assistant", content: anthropicContent };
      });
  }
}
