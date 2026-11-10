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

export class TurnTranscriptRecorder {
  private readonly turns = new Map<string, ActiveTurn>();

  beginTurn(sessionId: string, messageId: string): void {
    this.turns.set(sessionId, { messageId, parts: [] });
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
  const nonText = parts.filter((part) => part.kind !== 'text');
  if (toPersist === '') return nonText;
  const textOf = parts.map((part) => (part.kind === 'text' ? part.text : '')).join('');
  if (textOf === toPersist) return parts.slice();
  return [...nonText, { kind: 'text', text: toPersist, startedAt: createdAt }];
}
