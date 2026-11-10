import type { WSMessage } from '@koryphaios/shared';

const COALESCE_TYPES = new Set(['stream.delta', 'stream.thinking']);
// Fixed micro-batch window (~one frame at 60fps). The timer starts ONCE when
// a batch opens and is NEVER reset by later tokens: continuous token flow
// flushes every FLUSH_MS instead of being deferred until the stream pauses
// (the old clearTimeout+reset debounce turned steady streaming into one big
// blob). Batching still collapses N tokens into one persist+send per window.
const FLUSH_MS = 16;
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
  // stream.delta carries `content`, stream.thinking carries `thinking` —
  // concatenate whichever text field(s) the payload actually uses, and
  // never invent a field the payload doesn't have (a bogus empty
  // `content` on a thinking event would drop the incoming chunk).
  const a = existing as { content?: string; thinking?: string };
  const b = incoming as { content?: string; thinking?: string };
  const merged: Record<string, unknown> = {
    ...(existing as Record<string, unknown>),
    ...(incoming as Record<string, unknown>),
  };
  if (a.content !== undefined || b.content !== undefined) {
    merged.content = (a.content ?? '') + (b.content ?? '');
  }
  if (a.thinking !== undefined || b.thinking !== undefined) {
    merged.thinking = (a.thinking ?? '') + (b.thinking ?? '');
  }
  return merged as WSMessage['payload'];
}

function truncateToolResult(message: WSMessage): WSMessage {
  if (message.type !== 'stream.tool_result') return message;
  const payload = message.payload as {
    toolResult?: { name?: string; output?: string; truncated?: boolean; computerUse?: unknown };
  };
  const output = payload?.toolResult?.output;
  // Preserve structured computer evidence before the generic text preview is clipped.
  // CLI providers transport this same receipt in the JSON text result.
  if (output && /(?:^|__)computer_/.test(payload.toolResult?.name ?? '')) {
    try {
      const computerUse = JSON.parse(output).computerUse;
      if (computerUse?.version === 1) {
        message = { ...message, payload: { ...payload, toolResult: { ...payload.toolResult!, computerUse } } };
      }
    } catch { /* Legacy/plain-text results keep their normal preview. */ }
  }
  if (!output || output.length <= MAX_TOOL_OUTPUT_CHARS) return message;
  return {
    ...message,
    payload: {
      ...(message.payload && typeof message.payload === 'object'
        ? message.payload as Record<string, unknown>
        : {}),
      toolResult: {
        ...(payload.toolResult ?? {}),
        ...(((message.payload as typeof payload).toolResult?.computerUse)
          ? { computerUse: (message.payload as typeof payload).toolResult!.computerUse } : {}),
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
      // Merge into the open batch WITHOUT touching its timer. Resetting the
      // timer here would turn this into a debounce: a steady token stream
      // would never flush until it pauses, arriving as one big blob.
      existing.message = {
        ...existing.message,
        payload: mergePayload(existing.message.payload, sanitized.payload),
        timestamp: sanitized.timestamp,
      };
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
