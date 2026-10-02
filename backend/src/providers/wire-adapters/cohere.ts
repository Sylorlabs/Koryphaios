// Cohere v2 native adapter: /v2/chat (SSE streaming, typed events).
// Cohere's OpenAI-compatibility endpoint covers the common path, so this
// adapter is manual-override only (no catalog auto-detection): its /v1/models
// listing is OpenAI-shaped and auto-detecting it would hijack users who want
// the compat route. Select it from the Advanced section when an endpoint only
// implements the native v2 chat protocol.

import type {
  WireAdapter,
  WireAdapterChatRequest,
  WireAdapterHttpRequest,
  WireAdapterRequestContext,
  WireAdapterStreamChunk,
} from './types';

interface CohereWireEvent {
  type: string;
  delta?: {
    message?: { content?: { text?: string } };
    tool_call?: { id?: string; function?: { name?: string; arguments?: string } };
  };
  tool_call?: { id?: string; function?: { name?: string; arguments?: string } };
  usage?: {
    billed_units?: { input_tokens?: number; output_tokens?: number };
    tokens?: { input_tokens?: number; output_tokens?: number };
  };
  finish_reason?: string;
}

/** Canonical messages -> Cohere v2 chat messages. */
function toCohereMessages(request: WireAdapterChatRequest): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [];
  if (request.systemPrompt.trim()) {
    messages.push({ role: 'system', content: request.systemPrompt });
  }
  for (const message of request.messages) {
    const text =
      typeof message.content === 'string'
        ? message.content
        : message.content
            .filter((block) => block.type === 'text' && block.text)
            .map((block) => block.text)
            .join('\n');

    if (message.role === 'assistant' && message.tool_calls?.length) {
      messages.push({
        role: 'assistant',
        ...(text && { content: text }),
        tool_calls: message.tool_calls.map((call) => ({
          id: call.id,
          type: 'function',
          function: {
            name: call.name,
            // Cohere v2 requires a JSON string.
            arguments: JSON.stringify(call.input),
          },
        })),
      });
      continue;
    }
    if (message.role === 'tool') {
      messages.push({
        role: 'tool',
        ...(message.tool_call_id && { tool_call_id: message.tool_call_id }),
        content: text,
      });
      continue;
    }
    messages.push({ role: message.role, content: text });
  }
  return messages;
}

function mapFinishReason(reason: string | undefined): WireAdapterStreamChunk['finishReason'] {
  switch (reason) {
    case 'MAX_TOKENS':
      return 'max_tokens';
    case 'TOOL_CALLS':
      return 'tool_use';
    case 'COMPLETE':
    case 'STOP_SEQUENCE':
      return 'end_turn';
    default:
      return undefined;
  }
}

export const cohereAdapter: WireAdapter = {
  id: 'cohere',
  label: 'Cohere (v2 native)',
  description:
    'Cohere /v2/chat protocol with typed SSE events. Manual override — no auto-detection.',
  streamFormat: 'sse',
  catalogPaths: [],

  matchCatalog() {
    // Deliberately never auto-matches: Cohere's model listing is
    // OpenAI-shaped, so claiming it here would misroute compat users.
    return false;
  },

  buildChatRequest(request, ctx: WireAdapterRequestContext): WireAdapterHttpRequest {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      ...ctx.extraHeaders,
    };
    if (ctx.credential) headers.Authorization = `Bearer ${ctx.credential}`;

    return {
      path: '/v2/chat',
      headers,
      body: {
        model: request.model,
        messages: toCohereMessages(request),
        stream: true,
        // v2 requires max_tokens; default documented value when unset.
        max_tokens: request.maxTokens ?? 4096,
        ...(request.temperature !== undefined && { temperature: request.temperature }),
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
    const event = raw as CohereWireEvent;

    switch (event.type) {
      case 'content-delta': {
        const text = event.delta?.message?.content?.text;
        return text ? { contentDelta: text } : null;
      }
      case 'tool-call-start': {
        const call = event.tool_call ?? event.delta?.tool_call;
        if (!call) return null;
        return {
          toolCall: {
            ...(call.id && { id: call.id }),
            ...(call.function?.name && { name: call.function.name }),
          },
        };
      }
      case 'tool-call-delta': {
        const call = event.delta?.tool_call;
        const argsDelta = call?.function?.arguments;
        return argsDelta ? { toolCall: { argsDelta } } : null;
      }
      case 'message-end': {
        const chunk: WireAdapterStreamChunk = {};
        const billed = event.usage?.billed_units;
        const tokens = event.usage?.tokens;
        const tokensIn = billed?.input_tokens ?? tokens?.input_tokens;
        const tokensOut = billed?.output_tokens ?? tokens?.output_tokens;
        if (tokensIn !== undefined || tokensOut !== undefined) {
          chunk.usage = {
            ...(tokensIn !== undefined && { tokensIn }),
            ...(tokensOut !== undefined && { tokensOut }),
          };
        }
        const finish = mapFinishReason(event.finish_reason);
        if (finish) chunk.finishReason = finish;
        return Object.keys(chunk).length > 0 ? chunk : null;
      }
      default:
        return null;
    }
  },
};
