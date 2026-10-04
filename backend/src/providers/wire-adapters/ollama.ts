// Ollama native adapter: /api/chat (JSONL streaming) + /api/tags discovery.
// Lets a custom provider speak Ollama's own protocol — including native tool
// calls — instead of relying on Ollama's OpenAI-compatibility shim, which is
// missing on some installs and lags behind native capabilities.

import type {
  WireAdapter,
  WireAdapterChatRequest,
  WireAdapterHttpRequest,
  WireAdapterRequestContext,
  WireAdapterStreamChunk,
} from './types';

interface OllamaToolCallObject {
  function: { name: string; arguments: Record<string, unknown> };
}

/** Canonical messages -> Ollama /api/chat messages. */
function toOllamaMessages(request: WireAdapterChatRequest): Array<Record<string, unknown>> {
  // Ollama tool results carry a tool_name (not the call id); pair ids back to
  // names from the assistant tool_calls that precede them.
  const callIdToName = new Map<string, string>();
  for (const message of request.messages) {
    for (const call of message.tool_calls ?? []) {
      callIdToName.set(call.id, call.name);
    }
  }

  const messages: Array<Record<string, unknown>> = [];
  if (request.systemPrompt.trim()) {
    messages.push({ role: 'system', content: request.systemPrompt });
  }
  for (const message of request.messages) {
    const images =
      typeof message.content === 'string'
        ? []
        : message.content
            .filter((block) => block.type === 'image')
            .map((block) => {
              if (!block.imageData?.trim())
                throw new Error('Ollama received an image without image data.');
              return block.imageData;
            });
    const imageContent = images.length ? { images } : {};
    const text =
      typeof message.content === 'string'
        ? message.content
        : message.content
            .filter((block) => block.type === 'text' && block.text)
            .map((block) => block.text)
            .join('\n');

    if (message.role === 'assistant' && message.tool_calls?.length) {
      const toolCalls: OllamaToolCallObject[] = message.tool_calls.map((call) => ({
        function: { name: call.name, arguments: call.input },
      }));
      messages.push({ role: 'assistant', content: text, tool_calls: toolCalls, ...imageContent });
      continue;
    }
    if (message.role === 'tool') {
      messages.push({
        role: 'tool',
        content: text,
        ...imageContent,
        ...(message.tool_call_id &&
          callIdToName.get(message.tool_call_id) && {
            tool_name: callIdToName.get(message.tool_call_id),
          }),
      });
      continue;
    }
    messages.push({ role: message.role, content: text, ...imageContent });
  }
  return messages;
}

export const ollamaAdapter: WireAdapter = {
  id: 'ollama',
  imageInputTransport: 'native',
  label: 'Ollama (native)',
  description: 'Ollama /api/chat protocol with native tool calls and /api/tags discovery.',
  streamFormat: 'jsonl',
  catalogPaths: ['/api/tags'],

  matchCatalog(payload, path) {
    if (path !== '/api/tags' || !payload || typeof payload !== 'object') return false;
    const models = (payload as Record<string, unknown>).models;
    if (!Array.isArray(models) || models.length === 0) return false;
    // Ollama tag entries carry digest/size/details markers a generic name
    // list does not — this keeps Ollama detection from hijacking proxies
    // that happen to serve { models: [{ name }] }.
    return models.some(
      (entry) =>
        !!entry &&
        typeof entry === 'object' &&
        ((entry as Record<string, unknown>).digest !== undefined ||
          (entry as Record<string, unknown>).details !== undefined ||
          (entry as Record<string, unknown>).size !== undefined),
    );
  },

  buildChatRequest(request, ctx: WireAdapterRequestContext): WireAdapterHttpRequest {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...ctx.extraHeaders,
    };
    if (ctx.credential) headers.Authorization = `Bearer ${ctx.credential}`;

    const options: Record<string, unknown> = {};
    if (request.temperature !== undefined) options.temperature = request.temperature;
    if (request.maxTokens !== undefined) options.num_predict = request.maxTokens;

    return {
      path: '/api/chat',
      headers,
      body: {
        model: request.model,
        messages: toOllamaMessages(request),
        stream: true,
        ...(Object.keys(options).length > 0 && { options }),
        ...(request.tools?.length && {
          tools: request.tools.map((tool) => ({
            type: 'function',
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.inputSchema,
            },
          })),
        }),
      },
    };
  },

  parseEvent(raw): WireAdapterStreamChunk | null {
    if (!raw || typeof raw !== 'object') return null;
    const event = raw as Record<string, unknown>;
    const message = event.message as Record<string, unknown> | undefined;
    if (!message) return null;

    const chunk: WireAdapterStreamChunk = {};

    if (typeof message.content === 'string' && message.content) {
      chunk.contentDelta = message.content;
    }
    if (typeof message.thinking === 'string' && message.thinking) {
      chunk.thinkingDelta = message.thinking;
    }

    const toolCalls = message.tool_calls;
    if (Array.isArray(toolCalls)) {
      for (const call of toolCalls) {
        const fn = (call as Record<string, unknown> | null)?.function as
          { name?: unknown; arguments?: unknown } | undefined;
        if (!fn || typeof fn.name !== 'string') continue;
        chunk.toolCall = {
          name: fn.name,
          ...(fn.arguments !== null && typeof fn.arguments === 'object'
            ? { argsObject: fn.arguments as Record<string, unknown> }
            : {}),
        };
        // Ollama emits complete calls one at a time; take the first.
        break;
      }
    }

    if (event.done === true) {
      const usage: NonNullable<WireAdapterStreamChunk['usage']> = {};
      if (typeof event.prompt_eval_count === 'number') usage.tokensIn = event.prompt_eval_count;
      if (typeof event.eval_count === 'number') usage.tokensOut = event.eval_count;
      if (usage.tokensIn !== undefined || usage.tokensOut !== undefined) chunk.usage = usage;
      const reason = event.done_reason;
      if (reason === 'length') chunk.finishReason = 'max_tokens';
      else if (reason === 'tool_calls') chunk.finishReason = 'tool_use';
      else if (reason === 'stop' || reason === 'error') chunk.finishReason = 'end_turn';
    }

    return Object.keys(chunk).length > 0 ? chunk : null;
  },
};
