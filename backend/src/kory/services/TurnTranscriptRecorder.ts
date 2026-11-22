/**
 * TurnTranscriptRecorder
 *
 * The single choke point where a manager turn gets its identity and its ordered
 * parts. See docs/architecture/transcript-integrity.md (Invariants 1 and 2).
 *
 * - beginTurn() allocates the turn's message id. Every manager `stream.*` event
 *   emitted while the turn is active is stamped with `payload.messageId`.
 * - Each stamped event is folded through the shared reducer, so the parts that
 *   are persisted are exactly the parts a live client would have built.
 * - Worker and critic events are neither stamped nor folded.
 */

import {
  reduceTurnParts,
  turnEventFromWSMessage,
  type TranscriptPart,
} from '@koryphaios/shared';

interface ActiveTurn {
  messageId: string;
  parts: TranscriptPart[];
}

export interface TranscriptObservation {
  sessionId: string;
  type: string;
  payload: unknown;
  timestamp: number;
  managerAgentId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface TurnTranscriptRecorderOptions {
  /** Called when a manager turn starts, before its first event is stamped. */
  onTurnBegin?: (sessionId: string) => void;
  /** Called when a session's transcript state is disposed. */
  onDispose?: (sessionId: string) => void;
}

export class TurnTranscriptRecorder {
  private readonly turns = new Map<string, ActiveTurn>();

  constructor(private readonly options: TurnTranscriptRecorderOptions = {}) {}

  beginTurn(sessionId: string, messageId: string): void {
    this.turns.set(sessionId, { messageId, parts: [] });
    this.options.onTurnBegin?.(sessionId);
  }

  currentMessageId(sessionId: string): string | undefined {
    return this.turns.get(sessionId)?.messageId;
  }

  /** Copy of the parts folded so far for the active turn; empty when none is active. */
  snapshotParts(sessionId: string): TranscriptPart[] {
    const turn = this.turns.get(sessionId);
    return turn ? turn.parts.slice() : [];
  }

  /** Close the turn identified by `messageId`. A newer turn that already began
   *  in the same session is left untouched, so a late `finally` from a superseded
   *  turn cannot stop the stamping of the current one. */
  endTurn(sessionId: string, messageId: string): void {
    if (this.turns.get(sessionId)?.messageId === messageId) this.turns.delete(sessionId);
  }

  dispose(sessionId: string): void {
    this.turns.delete(sessionId);
    this.options.onDispose?.(sessionId);
  }

  /**
   * Stamp and fold one outgoing event. Returns the payload to publish: the
   * caller's object unchanged, or a copy carrying `messageId`.
   */
  observe(input: TranscriptObservation): unknown {
    const turn = this.turns.get(input.sessionId);
    if (!turn || !input.type.startsWith('stream.')) return input.payload;
    if (!isRecord(input.payload) || input.payload.agentId !== input.managerAgentId) {
      return input.payload;
    }
    const stamped = { ...input.payload, messageId: turn.messageId };
    const event = turnEventFromWSMessage({
      type: input.type,
      payload: stamped,
      timestamp: input.timestamp,
    });
    if (event) turn.parts = reduceTurnParts(turn.parts, event);
    return stamped;
  }
}

/**
 * Make the persisted text authoritative. Text parts must concatenate to exactly
 * `toPersist` (which covers deferred responses, withheld responses and stops);
 * when they do not, text parts are replaced by one text part holding `toPersist`.
 * Reasoning and tool parts keep their order.
 */
export function finalizeParts(
  parts: readonly TranscriptPart[],
  toPersist: string,
  createdAt: number,
): TranscriptPart[] {
  // A persisted turn is over: reasoning a cancelled or failed turn left open
  // (no complete event) ends at persistence time, never renders as live.
  const closed = parts.map((part) =>
    part.kind === 'reasoning' && part.endedAt === undefined ? { ...part, endedAt: createdAt } : part,
  );
  const textOf = (list: readonly TranscriptPart[]) =>
    list.map((part) => (part.kind === 'text' ? part.text : '')).join('');
  if (toPersist !== '' && textOf(closed) === toPersist) return closed;

  // Only the final answer — the text after the last reasoning or tool part —
  // is reconciled with the persisted content. Text the model wrote earlier in
  // the turn (narration before a tool call) is part of the transcript and is
  // never dropped: the reader saw it stream, and it must survive the swap to
  // persisted rows and every reload.
  let lastNonText = -1;
  closed.forEach((part, index) => {
    if (part.kind !== 'text') lastNonText = index;
  });
  const head = closed.slice(0, lastNonText + 1);
  const tail = closed.slice(lastNonText + 1);
  if (textOf(tail) === toPersist) return closed;
  if (toPersist === '') return head;
  const startedAt = tail[0]?.startedAt ?? createdAt;
  return [...head, { kind: 'text', text: toPersist, startedAt }];
}
