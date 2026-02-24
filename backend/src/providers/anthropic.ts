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
import { withRetry } from "./utils";
import { detectClaudeCodeToken } from "./auth-utils";
import { createUsageInterceptingFetch } from "../credit-accountant";

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

    // Extended thinking: Opus 4.6 & Sonnet 4.6 use adaptive + output_config.effort (Anthropic API);
    // Haiku 4.5 and others use thinking.type "enabled" + budget_tokens.
    const isOpus46 = /^claude-opus-4-6/i.test(request.model || "");
    const isSonnet46 = /^claude-sonnet-4-6/i.test(request.model || "");
    const isHaiku45 = /^claude-haiku-4-5/i.test(request.model || "");

    if (request.reasoningLevel !== undefined && request.reasoningLevel !== "") {
      const level = String(request.reasoningLevel).toLowerCase().trim();
      const outputTokens = request.maxTokens ?? 16_384;

      if (isOpus46 || isSonnet46) {
        // API: output_config.effort (low|medium|high|max), thinking.type "adaptive". Max is Opus 4.6 only.
        const effort = (["low", "medium", "high", "max"] as const).includes(level as any)
          ? level
          : "medium";
        if (effort === "max" && isSonnet46) {
          (params as any).output_config = { effort: "high" };
        } else {
          (params as any).output_config = { effort };
        }
        (params as any).thinking = { type: "adaptive" };
      } else if (isHaiku45) {
        // Haiku 4.5: extended thinking with budget_tokens (same API as other Claude 4).
        const budget = level === "0" || level === "off" ? 0 : Math.max(0, parseInt(level, 10) || 8192);
        if (budget > 0) {
          (params as any).thinking = { type: "enabled", budget_tokens: budget };
          params.max_tokens = budget + outputTokens;
        }
      } else {
        // Other Anthropic (Sonnet 4.5, 4, 3.7, etc.): thinking on/off with budget.
        let thinkingBudget = 8192;
        if (level === "off" || level === "none" || level === "0") {
          thinkingBudget = 0;
        } else if (level === "on") {
          thinkingBudget = 8192;
        } else if (level === "low") {
          thinkingBudget = 4096;
        } else if (level === "medium") {
          thinkingBudget = 8192;
        } else if (level === "high" || level === "max" || level === "xhigh") {
          thinkingBudget = 32768;
        } else if (!isNaN(Number(level))) {
          thinkingBudget = Number(level);
        }
        if (thinkingBudget > 0) {
          (params as any).thinking = { type: "enabled", budget_tokens: thinkingBudget };
          params.max_tokens = thinkingBudget + outputTokens;
        }
      }
    }

    try {
      const stream = await withRetry(() => this.client.messages.stream(params, {
        signal: request.signal,
      }));

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
            const usage = (event as any).usage;
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
              tokensCache: (usage as any).cache_read_input_tokens,
            };
            break;
          }
        }
      }
    } catch (err: any) {
      if (err.name === "AbortError") return;
      yield { type: "error", error: err.message ?? String(err) };
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
                media_type: (b.imageMimeType ?? "image/png") as any,
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
