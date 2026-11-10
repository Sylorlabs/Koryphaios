// Transcript parts: the single ordering model for one assistant turn.
// See docs/architecture/transcript-integrity.md (Invariant 1).
//
// reduceTurnParts() is the only code that decides how reasoning, text and tool
// activity are ordered inside an assistant turn. The backend folds manager events
// through it to persist `parts`; the frontend folds the same live events through it.

export type TranscriptPart =
  | {
      kind: 'reasoning';
      text: string;
      startedAt: number;
      endedAt?: number;
      thinkingTokens?: number;
    }
  | { kind: 'text'; text: string; startedAt: number }
  | {
      kind: 'tool';
      callId: string;
      name: string;
      input: Record<string, unknown>;
      startedAt: number;
      output?: string;
      isError?: boolean;
      durationMs?: number;
      endedAt?: number;
    };

export type TurnEvent =
  | { type: 'reasoning'; text: string; timestamp: number; thinkingTokens?: number }
  | { type: 'text'; text: string; timestamp: number }
  | {
      type: 'tool_call';
      callId: string;
      name: string;
      input: Record<string, unknown>;
      timestamp: number;
    }
  | {
      type: 'tool_result';
      callId: string;
      name: string;
      output: string;
      isError: boolean;
      durationMs: number;
      timestamp: number;
    }
  | { type: 'clear_text'; timestamp: number }
  | { type: 'complete'; timestamp: number };

type ReasoningPart = Extract<TranscriptPart, { kind: 'reasoning' }>;
type TextPart = Extract<TranscriptPart, { kind: 'text' }>;
type ToolPart = Extract<TranscriptPart, { kind: 'tool' }>;

function isToolPart(part: TranscriptPart): part is ToolPart {
  return part.kind === 'tool';
}

function isOpenReasoning(part: TranscriptPart): part is ReasoningPart {
  return part.kind === 'reasoning' && part.endedAt === undefined;
}

function replaceAt(parts: readonly TranscriptPart[], index: number, part: TranscriptPart): TranscriptPart[] {
  const next = parts.slice();
  next[index] = part;
  return next;
}

/** Close every open reasoning part at `timestamp`. Returns a new array. */
function closeOpenReasoning(parts: readonly TranscriptPart[], timestamp: number): TranscriptPart[] {
  return parts.map((part) =>
    isOpenReasoning(part) ? { ...part, endedAt: timestamp } : part,
  );
}

function maxDefined(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.max(a, b);
}

function appendReasoning(
  parts: readonly TranscriptPart[],
  event: Extract<TurnEvent, { type: 'reasoning' }>,
): TranscriptPart[] {
  const tokens = event.thinkingTokens;
  if (event.text === '' && tokens === undefined) return parts.slice();

  const last = parts[parts.length - 1];
  if (last && isOpenReasoning(last)) {
    const merged: ReasoningPart = { ...last, text: last.text + event.text };
    const thinkingTokens = maxDefined(last.thinkingTokens, tokens);
    if (thinkingTokens !== undefined) merged.thinkingTokens = thinkingTokens;
    return replaceAt(parts, parts.length - 1, merged);
  }

  const created: ReasoningPart = { kind: 'reasoning', text: event.text, startedAt: event.timestamp };
  if (tokens !== undefined) created.thinkingTokens = tokens;
  return [...parts, created];
}

function appendText(
  parts: readonly TranscriptPart[],
  event: Extract<TurnEvent, { type: 'text' }>,
): TranscriptPart[] {
  if (event.text === '') return parts.slice();

  const closed = closeOpenReasoning(parts, event.timestamp);
  const last = closed[closed.length - 1];
  if (last && last.kind === 'text') {
    const merged: TextPart = { ...last, text: last.text + event.text };
    return replaceAt(closed, closed.length - 1, merged);
  }
  return [...closed, { kind: 'text', text: event.text, startedAt: event.timestamp }];
}

function applyToolCall(
  parts: readonly TranscriptPart[],
  event: Extract<TurnEvent, { type: 'tool_call' }>,
): TranscriptPart[] {
  const closed = closeOpenReasoning(parts, event.timestamp);
  const index = closed.findIndex((part) => isToolPart(part) && part.callId === event.callId);
  if (index >= 0) {
    const existing = closed[index] as ToolPart;
    const merged: ToolPart = {
      ...existing,
      name: event.name,
      input: { ...existing.input, ...event.input },
    };
    return replaceAt(closed, index, merged);
  }
  return [
    ...closed,
    {
      kind: 'tool',
      callId: event.callId,
      name: event.name,
      input: { ...event.input },
      startedAt: event.timestamp,
    },
  ];
}

function applyToolResult(
  parts: readonly TranscriptPart[],
  event: Extract<TurnEvent, { type: 'tool_result' }>,
): TranscriptPart[] {
  const result = {
    output: event.output,
    isError: event.isError,
    durationMs: event.durationMs,
    endedAt: event.timestamp,
  };
  const index = parts.findIndex((part) => isToolPart(part) && part.callId === event.callId);
  if (index >= 0) {
    const existing = parts[index] as ToolPart;
    return replaceAt(parts, index, { ...existing, ...result });
  }
  // Orphan result: the call event was never seen (or was dropped). Keep the output
  // visible rather than losing it.
  return [
    ...parts,
    {
      kind: 'tool',
      callId: event.callId,
      name: event.name,
      input: {},
      startedAt: event.timestamp,
      ...result,
    },
  ];
}

/**
 * Pure fold step. Returns a new array; never mutates `parts` or its elements.
 *
 * Ordering guarantee: a delta extends the last part only when the last part has
 * the same kind, so reasoning -> tool -> reasoning -> text yields four parts in order.
 */
export function reduceTurnParts(
  parts: readonly TranscriptPart[],
  event: TurnEvent,
): TranscriptPart[] {
  switch (event.type) {
    case 'reasoning':
      return appendReasoning(parts, event);
    case 'text':
      return appendText(parts, event);
    case 'tool_call':
      return applyToolCall(parts, event);
    case 'tool_result':
      return applyToolResult(parts, event);
    case 'clear_text':
      return parts.filter((part) => part.kind !== 'text');
    case 'complete':
      return closeOpenReasoning(parts, event.timestamp);
    default:
      return parts.slice();
  }
}

/** Fold a complete event sequence from an empty transcript. */
export function reduceTurnEvents(events: readonly TurnEvent[]): TranscriptPart[] {
  return events.reduce<TranscriptPart[]>(reduceTurnParts, []);
}

/**
 * Render a legacy row (no persisted `parts`) as parts:
 * [reasoning(reasoningContent)?, text(content)?].
 */
export function legacyTurnParts(
  content: string,
  reasoningContent: string | undefined,
  createdAt: number,
): TranscriptPart[] {
  const parts: TranscriptPart[] = [];
  if (typeof reasoningContent === 'string' && reasoningContent.length > 0) {
    parts.push({
      kind: 'reasoning',
      text: reasoningContent,
      startedAt: createdAt,
      endedAt: createdAt,
    });
  }
  if (typeof content === 'string' && content.length > 0) {
    parts.push({ kind: 'text', text: content, startedAt: createdAt });
  }
  return parts;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Map a realtime WebSocket message to a turn event. Returns null for unrelated
 * types and for malformed payloads.
 */
export function turnEventFromWSMessage(msg: {
  type: string;
  payload: unknown;
  timestamp: number;
}): TurnEvent | null {
  const timestamp = finiteNumber(msg?.timestamp);
  if (timestamp === undefined || !isRecord(msg.payload)) return null;
  const payload = msg.payload;

  switch (msg.type) {
    case 'stream.thinking': {
      if (typeof payload.thinking !== 'string') return null;
      const thinkingTokens = finiteNumber(payload.thinkingTokens);
      const event: TurnEvent = { type: 'reasoning', text: payload.thinking, timestamp };
      if (thinkingTokens !== undefined) event.thinkingTokens = thinkingTokens;
      return event;
    }
    case 'stream.delta': {
      if (typeof payload.content !== 'string') return null;
      return { type: 'text', text: payload.content, timestamp };
    }
    case 'stream.tool_call': {
      const call = payload.toolCall;
      if (!isRecord(call)) return null;
      if (typeof call.id !== 'string' || call.id.length === 0) return null;
      if (typeof call.name !== 'string') return null;
      const input = call.input === undefined ? {} : call.input;
      if (!isRecord(input)) return null;
      return { type: 'tool_call', callId: call.id, name: call.name, input, timestamp };
    }
    case 'stream.tool_result': {
      const result = payload.toolResult;
      if (!isRecord(result)) return null;
      if (typeof result.callId !== 'string' || result.callId.length === 0) return null;
      if (typeof result.name !== 'string') return null;
      if (typeof result.output !== 'string') return null;
      return {
        type: 'tool_result',
        callId: result.callId,
        name: result.name,
        output: result.output,
        isError: result.isError === true,
        durationMs: finiteNumber(result.durationMs) ?? 0,
        timestamp,
      };
    }
    case 'stream.clear_content':
      return { type: 'clear_text', timestamp };
    case 'stream.complete':
      return { type: 'complete', timestamp };
    default:
      return null;
  }
}
