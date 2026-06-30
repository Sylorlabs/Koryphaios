import type { WSMessage } from '@koryphaios/shared';

const COALESCE_TYPES = new Set(['stream.delta', 'stream.thinking']);
const FLUSH_MS = 50;
const MAX_TOOL_OUTPUT_CHARS = 8_192;

type Pending = {
  message: WSMessage;
  timer: ReturnType<typeof setTimeout>;
};

function coalesceKey(message: WSMessage): string | null {
  if (!message.sessionId || !COALESCE_TYPES.has(message.type)) return null;
  const payload = message.payload as { agentId?: string };
  if (!payload?.agentId) return null;
  return `${message.sessionId}:${message.type}:${payload.agentId}`;
}

function mergePayload(
  existing: WSMessage['payload'],
  incoming: WSMessage['payload'],
): WSMessage['payload'] {
  const a = existing as { content?: string };
  const b = incoming as { content?: string };
  return { ...existing, content: (a.content ?? '') + (b.content ?? '') };
}

function truncateToolResult(message: WSMessage): WSMessage {
  if (message.type !== 'stream.tool_result') return message;
  const payload = message.payload as {
    toolResult?: { output?: string; truncated?: boolean };
  };
  const output = payload?.toolResult?.output;
  if (!output || output.length <= MAX_TOOL_OUTPUT_CHARS) return message;
  return {
    ...message,
    payload: {
      ...payload,
      toolResult: {
        ...payload.toolResult!,
        output: `${output.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n\n… [truncated ${output.length - MAX_TOOL_OUTPUT_CHARS} chars — open file or re-run tool for full output]`,
        truncated: true,
      },
    },
  };
}

export class StreamCoalescer {
  private pending = new Map<string, Pending>();

  constructor(private readonly publish: (message: WSMessage) => void) {}

  enqueue(message: WSMessage): void {
    const sanitized = truncateToolResult(message);
    const key = coalesceKey(sanitized);
    if (!key) {
      this.flushAll();
      this.publish(sanitized);
      return;
    }

    const existing = this.pending.get(key);
    if (existing) {
      existing.message = {
        ...existing.message,
        payload: mergePayload(existing.message.payload, sanitized.payload),
        timestamp: sanitized.timestamp,
      };
      clearTimeout(existing.timer);
      existing.timer = setTimeout(() => this.flush(key), FLUSH_MS);
      return;
    }

    const timer = setTimeout(() => this.flush(key), FLUSH_MS);
    this.pending.set(key, { message: { ...sanitized }, timer });
  }

  flush(key: string): void {
    const entry = this.pending.get(key);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(key);
    this.publish(entry.message);
  }

  flushAll(): void {
    for (const key of [...this.pending.keys()]) {
      this.flush(key);
    }
  }

  dispose(): void {
    this.flushAll();
  }
}