// Expansion of one assistant turn's ordered parts into feed rows.
// See docs/architecture/transcript-integrity.md (Invariants 1 and 2).
//
// This is the only place that turns TranscriptPart[] into rows. Live turns
// (feed.svelte.ts applyManagerTurnEvent) and persisted history both call it, so
// a reloaded transcript is the live transcript by construction. Ids are
// deterministic (`turn-<messageId>-<index>`) so a row keeps its identity while
// the turn grows.

import type { TranscriptPart } from '@koryphaios/shared';
import type { FeedEntry } from '$lib/types';

export interface PartsToFeedEntriesInput {
  sessionId: string;
  messageId: string;
  parts: TranscriptPart[];
  agentName: string;
  glowClass: string;
  /** Existing message metadata (model, variants, cost, attachments ...). It is
   *  placed on the text row, or on the last row when the turn has no text. */
  messageMetadata?: Record<string, unknown>;
  /** The message's source recorded no clock time; every row says "Time unknown". */
  timeUnknown?: boolean;
}

/** Feed text for a finished tool call, matching the live stream.tool_result path. */
export function toolResultText(output: string, isError: boolean, durationMs: number): string {
  if (isError) return `Tool error: ${output}`;
  if (durationMs > 0) return `Tool result (${durationMs.toFixed(0)}ms): ${output}`;
  return `Tool result (time not reported by provider): ${output}`;
}

/** Identity of the manager's turn rows. Live turns and reloaded turns both use
 *  it, so the two renderings cannot disagree about who said what. */
export const MANAGER_TURN_IDENTITY = { agentName: 'Kory', glowClass: 'glow-kory' } as const;

export function turnRowId(messageId: string, index: number): string {
  return `turn-${messageId}-${index}`;
}

export function partsToFeedEntries(input: PartsToFeedEntriesInput): FeedEntry[] {
  const { sessionId, messageId, parts, agentName, glowClass, messageMetadata, timeUnknown } = input;
  if (!messageId) return [];
  const rows = parts.map((part, index): FeedEntry => {
    const base = {
      id: turnRowId(messageId, index),
      agentId: 'kory-manager',
      agentName,
      glowClass,
      ...(timeUnknown ? { timeUnknown: true as const } : {}),
    };
    const rowMetadata: Record<string, unknown> = { sessionId, turnMessageId: messageId };

    switch (part.kind) {
      case 'reasoning': {
        const ended = part.endedAt !== undefined;
        const metadata: Record<string, unknown> = { ...rowMetadata };
        if (part.thinkingTokens !== undefined) metadata.thinkingTokens = part.thinkingTokens;
        if (part.timeUnknown) {
          // No recorded duration: the block is over (it came from a source, not a
          // live stream) and carries no duration a renderer could show as 0.0s.
          return {
            ...base,
            timestamp: part.startedAt,
            type: 'thinking',
            text: part.text,
            thinkingStartedAt: part.startedAt,
            thinkingFinalized: true,
            durationUnknown: true,
            metadata,
          };
        }
        return {
          ...base,
          timestamp: part.startedAt,
          type: 'thinking',
          text: part.text,
          thinkingStartedAt: part.startedAt,
          thinkingFinalized: ended,
          ...(ended ? { durationMs: (part.endedAt as number) - part.startedAt } : {}),
          metadata,
        };
      }
      case 'text':
        return {
          ...base,
          timestamp: part.startedAt,
          type: 'content',
          text: part.text,
          metadata: { ...rowMetadata },
        };
      case 'tool': {
        const toolCall = { id: part.callId, name: part.name, input: part.input };
        const toolMetadata: Record<string, unknown> = { ...rowMetadata, toolCall };
        // Display data only: the sub-agent's own conversation rides on its row —
        // or, for imported chats, a stub whose transcript loads on first expand.
        if (part.subagent) toolMetadata.subagent = part.subagent;
        if (part.subagentStub) toolMetadata.subagentStub = part.subagentStub;
        const durationUnknown = part.timeUnknown ? { durationUnknown: true as const } : {};
        if (part.endedAt === undefined) {
          return {
            ...base,
            ...durationUnknown,
            timestamp: part.startedAt,
            type: 'tool_call',
            text: `Calling tool: ${part.name}`,
            metadata: toolMetadata,
          };
        }
        const output = part.output ?? '';
        const isError = part.isError === true;
        if (part.timeUnknown) {
          return {
            ...base,
            ...durationUnknown,
            timestamp: part.endedAt,
            type: 'tool_result',
            text: toolResultText(output, isError, 0),
            metadata: {
              ...toolMetadata,
              toolResult: {
                callId: part.callId,
                name: part.name,
                output,
                isError,
                timeUnknown: true,
              },
            },
          };
        }
        const durationMs = part.durationMs ?? 0;
        return {
          ...base,
          timestamp: part.endedAt,
          type: 'tool_result',
          text: toolResultText(output, isError, durationMs),
          metadata: {
            ...toolMetadata,
            toolResult: {
              callId: part.callId,
              name: part.name,
              output,
              isError,
              durationMs,
            },
          },
        };
      }
    }
  });

  if (!messageMetadata || rows.length === 0) return rows;
  const textIndex = parts.findIndex((part) => part.kind === 'text');
  const target = textIndex >= 0 ? textIndex : rows.length - 1;
  rows[target] = {
    ...rows[target],
    metadata: { ...messageMetadata, ...rows[target].metadata },
  };
  return rows;
}
