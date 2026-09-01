import type { SessionRunSnapshot, SessionRunStatePayload, WSMessage } from '@koryphaios/shared';

interface OrderedErrorEntry {
  type: string;
  text: string;
  metadata?: Record<string, unknown>;
}

// These manager preflights deliberately publish a human-readable system.error
// first, then terminalize the same run with a stable machine reason. Restrict
// differing-text dedupe to those proven producer pairs: sequence adjacency on
// its own is not enough to decide that two different errors mean the same thing.
const HUMAN_ERROR_THEN_RUN_FAILURE_REASONS = new Set([
  'provider_unavailable',
  'spend_policy_blocked',
]);

export interface SequencedTerminalRunFailure {
  snapshot: SessionRunSnapshot;
  reason: string;
}

/** A durable failed run is transcript evidence only for its owning session. */
export function sequencedTerminalRunFailure(
  msg: WSMessage,
  targetSessionId: string,
): SequencedTerminalRunFailure | null {
  if (
    msg.type !== 'run.state' ||
    !msg.sessionId ||
    msg.sessionId !== targetSessionId ||
    !Number.isSafeInteger(msg.epoch) ||
    !Number.isSafeInteger(msg.sequence)
  ) {
    return null;
  }

  const { snapshot } = msg.payload as SessionRunStatePayload;
  const reason = snapshot?.terminalReason?.trim() ?? '';
  if (snapshot?.status !== 'terminal' || snapshot.phase !== 'error' || !reason) return null;
  return { snapshot, reason };
}

/** Collapse a paired system.error even when database work separated timestamps. */
export function isImmediateOrderedErrorDuplicate(
  last: OrderedErrorEntry | undefined,
  msg: WSMessage,
  text: string,
): boolean {
  if (last?.type !== 'error') return false;
  const lastEpoch = last.metadata?.eventEpoch;
  const lastSequence = last.metadata?.sequenceEnd ?? last.metadata?.sequenceStart;
  const isAdjacent =
    Number.isSafeInteger(lastEpoch) &&
    Number.isSafeInteger(lastSequence) &&
    lastEpoch === msg.epoch &&
    Number(lastSequence) + 1 === msg.sequence;
  if (!isAdjacent) return false;
  if (last.text === text) return true;

  return (
    msg.type === 'run.state' &&
    last.metadata?.sourceEvent === 'system.error' &&
    HUMAN_ERROR_THEN_RUN_FAILURE_REASONS.has(text)
  );
}
