import { describe, expect, test } from 'bun:test';
import {
  legacyTurnParts,
  reduceTurnEvents,
  reduceTurnParts,
  turnEventFromWSMessage,
  type TranscriptPart,
  type TurnEvent,
} from './TranscriptParts';

const reasoning = (text: string, timestamp: number, thinkingTokens?: number): TurnEvent =>
  thinkingTokens === undefined
    ? { type: 'reasoning', text, timestamp }
    : { type: 'reasoning', text, timestamp, thinkingTokens };
const text = (value: string, timestamp: number): TurnEvent => ({ type: 'text', text: value, timestamp });
const toolCall = (callId: string, name: string, input: Record<string, unknown>, timestamp: number): TurnEvent => ({
  type: 'tool_call',
  callId,
  name,
  input,
  timestamp,
});
const toolResult = (
  callId: string,
  output: string,
  timestamp: number,
  isError = false,
  name = 'bash',
): TurnEvent => ({ type: 'tool_result', callId, name, output, isError, durationMs: 5, timestamp });

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

describe('reduceTurnParts reasoning', () => {
  test('appends deltas to an open reasoning part', () => {
    const parts = reduceTurnEvents([reasoning('a', 1), reasoning('b', 2)]);
    expect(parts).toEqual([{ kind: 'reasoning', text: 'ab', startedAt: 1 }]);
  }); 

  test('keeps the maximum thinkingTokens across deltas', () => {
    const parts = reduceTurnEvents([reasoning('', 1, 10), reasoning('x', 2, 4), reasoning('y', 3, 25)]);
    expect(parts).toEqual([{ kind: 'reasoning', text: 'xy', startedAt: 1, thinkingTokens: 25 }]);
  });

  test('empty text without thinkingTokens is a no-op', () => {
    expect(reduceTurnEvents([reasoning('', 1)])).toEqual([]);
    const before: TranscriptPart[] = [{ kind: 'text', text: 'hi', startedAt: 0 }];
    expect(reduceTurnParts(before, reasoning('', 5))).toEqual(before);
  });

  test('a closed reasoning part is not extended by new reasoning', () => {
    const parts = reduceTurnEvents([reasoning('a', 1), text('t', 2), reasoning('b', 3)]);
    expect(parts).toEqual([
      { kind: 'reasoning', text: 'a', startedAt: 1, endedAt: 2 },
      { kind: 'text', text: 't', startedAt: 2 },
      { kind: 'reasoning', text: 'b', startedAt: 3 },
    ]);
  });
});

describe('reduceTurnParts text', () => {
  test('closes open reasoning and appends to a trailing text part', () => {
    const parts = reduceTurnEvents([reasoning('think', 1), text('He', 2), text('llo', 3)]);
    expect(parts).toEqual([
      { kind: 'reasoning', text: 'think', startedAt: 1, endedAt: 2 },
      { kind: 'text', text: 'Hello', startedAt: 2 },
    ]);
  });

  test('empty text is a no-op and does not close reasoning', () => {
    const parts = reduceTurnEvents([reasoning('think', 1), text('', 2)]);
    expect(parts).toEqual([{ kind: 'reasoning', text: 'think', startedAt: 1 }]);
  });
});

describe('reduceTurnParts tool calls', () => {
  test('closes open reasoning and pushes a tool part', () => {
    const parts = reduceTurnEvents([reasoning('plan', 1), toolCall('c1', 'bash', { cmd: 'ls' }, 2)]);
    expect(parts).toEqual([
      { kind: 'reasoning', text: 'plan', startedAt: 1, endedAt: 2 },
      { kind: 'tool', callId: 'c1', name: 'bash', input: { cmd: 'ls' }, startedAt: 2 },
    ]);
  });

  test('a repeated callId merges input and name instead of pushing', () => {
    const parts = reduceTurnEvents([
      toolCall('c1', 'bash', { cmd: 'ls' }, 1),
      toolCall('c1', 'shell', { cwd: '/tmp' }, 2),
    ]);
    expect(parts).toEqual([
      { kind: 'tool', callId: 'c1', name: 'shell', input: { cmd: 'ls', cwd: '/tmp' }, startedAt: 1 },
    ]);
  });

  test('tool_result fills output, error flag, duration and endedAt', () => {
    const parts = reduceTurnEvents([
      toolCall('c1', 'bash', {}, 1),
      toolResult('c1', 'boom', 4, true),
    ]);
    expect(parts).toEqual([
      {
        kind: 'tool',
        callId: 'c1',
        name: 'bash',
        input: {},
        startedAt: 1,
        output: 'boom',
        isError: true,
        durationMs: 5,
        endedAt: 4,
      },
    ]);
  });

  test('an orphan tool_result pushes a tool part with empty input', () => {
    const parts = reduceTurnEvents([toolResult('ghost', 'out', 7)]);
    expect(parts).toEqual([
      {
        kind: 'tool',
        callId: 'ghost',
        name: 'bash',
        input: {},
        startedAt: 7,
        output: 'out',
        isError: false,
        durationMs: 5,
        endedAt: 7,
      },
    ]);
  });
});

describe('ordering guarantee', () => {
  test('reasoning -> tool -> reasoning -> text yields four parts in order', () => {
    const parts = reduceTurnEvents([
      reasoning('first', 1),
      toolCall('c1', 'read', { path: 'a' }, 2),
      toolResult('c1', 'ok', 3),
      reasoning('second', 4),
      text('answer', 5),
      { type: 'complete', timestamp: 6 },
    ]);
    expect(parts.map((p) => p.kind)).toEqual(['reasoning', 'tool', 'reasoning', 'text']);
    expect(parts[0]).toEqual({ kind: 'reasoning', text: 'first', startedAt: 1, endedAt: 2 });
    expect(parts[2]).toEqual({ kind: 'reasoning', text: 'second', startedAt: 4, endedAt: 5 });
    expect(parts[3]).toEqual({ kind: 'text', text: 'answer', startedAt: 5 });
  });

  test('a tool part between two text deltas keeps the text parts separate', () => {
    const parts = reduceTurnEvents([text('a', 1), toolCall('c', 'x', {}, 2), text('b', 3)]);
    expect(parts.map((p) => p.kind)).toEqual(['text', 'tool', 'text']);
  });
});

describe('clear_text and complete', () => {
  test('clear_text removes text parts only', () => {
    const parts = reduceTurnEvents([
      reasoning('r', 1),
      text('t', 2),
      toolCall('c', 'x', {}, 3),
      { type: 'clear_text', timestamp: 4 },
    ]);
    expect(parts.map((p) => p.kind)).toEqual(['reasoning', 'tool']);
  });

  test('complete closes open reasoning and leaves closed parts alone', () => {
    const parts = reduceTurnEvents([reasoning('r', 1), { type: 'complete', timestamp: 9 }]);
    expect(parts).toEqual([{ kind: 'reasoning', text: 'r', startedAt: 1, endedAt: 9 }]);
  });
});

describe('immutability', () => {
  test('reduceTurnParts does not mutate its input and returns a new array', () => {
    const input = deepFreeze<TranscriptPart[]>([
      { kind: 'reasoning', text: 'a', startedAt: 1 },
      { kind: 'tool', callId: 'c', name: 'x', input: { k: 1 }, startedAt: 2 },
      { kind: 'text', text: 'b', startedAt: 3 },
    ]);
    const snapshot = JSON.stringify(input);
    const events: TurnEvent[] = [
      reasoning('more', 4),
      text('c', 5),
      toolCall('c', 'x', { k: 2 }, 6),
      toolResult('c', 'done', 7),
      { type: 'complete', timestamp: 8 },
      { type: 'clear_text', timestamp: 9 },
    ];
    for (const event of events) {
      const next = reduceTurnParts(input, event);
      expect(next).not.toBe(input);
    }
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  test('a no-op event still returns a fresh array', () => {
    const input: TranscriptPart[] = [{ kind: 'text', text: 'x', startedAt: 1 }];
    const next = reduceTurnParts(input, text('', 2));
    expect(next).toEqual(input);
    expect(next).not.toBe(input);
  });
});

describe('legacyTurnParts', () => {
  test('renders reasoning then text', () => {
    expect(legacyTurnParts('answer', 'why', 42)).toEqual([
      { kind: 'reasoning', text: 'why', startedAt: 42, endedAt: 42 },
      { kind: 'text', text: 'answer', startedAt: 42 },
    ]);
  });

  test('omits empty reasoning and empty content', () => {
    expect(legacyTurnParts('answer', '', 1)).toEqual([{ kind: 'text', text: 'answer', startedAt: 1 }]);
    expect(legacyTurnParts('', undefined, 1)).toEqual([]);
    expect(legacyTurnParts('', 'why', 1)).toEqual([
      { kind: 'reasoning', text: 'why', startedAt: 1, endedAt: 1 },
    ]);
  });
});

describe('turnEventFromWSMessage', () => {
  const ts = 1000;

  test('stream.thinking maps to reasoning with optional thinkingTokens', () => {
    expect(
      turnEventFromWSMessage({ type: 'stream.thinking', payload: { agentId: 'a', thinking: 'hm', thinkingTokens: 3 }, timestamp: ts }),
    ).toEqual({ type: 'reasoning', text: 'hm', timestamp: ts, thinkingTokens: 3 });
    expect(
      turnEventFromWSMessage({ type: 'stream.thinking', payload: { agentId: 'a', thinking: '' }, timestamp: ts }),
    ).toEqual({ type: 'reasoning', text: '', timestamp: ts });
  });

  test('stream.delta maps to text', () => {
    expect(
      turnEventFromWSMessage({ type: 'stream.delta', payload: { agentId: 'a', content: 'hi', model: 'm' }, timestamp: ts }),
    ).toEqual({ type: 'text', text: 'hi', timestamp: ts });
  });

  test('stream.tool_call maps to tool_call keyed by toolCall.id', () => {
    expect(
      turnEventFromWSMessage({
        type: 'stream.tool_call',
        payload: { agentId: 'a', toolCall: { id: 'c1', name: 'bash', input: { cmd: 'ls' } } },
        timestamp: ts,
      }),
    ).toEqual({ type: 'tool_call', callId: 'c1', name: 'bash', input: { cmd: 'ls' }, timestamp: ts });
  });

  test('stream.tool_result maps to tool_result', () => {
    expect(
      turnEventFromWSMessage({
        type: 'stream.tool_result',
        payload: {
          agentId: 'a',
          toolResult: { callId: 'c1', name: 'bash', output: 'ok', isError: false, durationMs: 12 },
        },
        timestamp: ts,
      }),
    ).toEqual({
      type: 'tool_result',
      callId: 'c1',
      name: 'bash',
      output: 'ok',
      isError: false,
      durationMs: 12,
      timestamp: ts,
    });
  });

  test('stream.clear_content maps to clear_text', () => {
    expect(turnEventFromWSMessage({ type: 'stream.clear_content', payload: { agentId: 'a' }, timestamp: ts })).toEqual({
      type: 'clear_text',
      timestamp: ts,
    });
  });

  test('stream.complete maps to complete', () => {
    expect(
      turnEventFromWSMessage({ type: 'stream.complete', payload: { agentId: 'a' }, timestamp: ts }),
    ).toEqual({ type: 'complete', timestamp: ts });
  });

  test('unrelated types map to null', () => {
    expect(turnEventFromWSMessage({ type: 'stream.usage', payload: {}, timestamp: ts })).toBeNull();
    expect(turnEventFromWSMessage({ type: 'agent.status', payload: { status: 'done' }, timestamp: ts })).toBeNull();
  });

  test('malformed payloads map to null', () => {
    const bad: Array<{ type: string; payload: unknown; timestamp: number }> = [
      { type: 'stream.thinking', payload: { thinking: 42 }, timestamp: ts },
      { type: 'stream.thinking', payload: null, timestamp: ts },
      { type: 'stream.delta', payload: { content: undefined }, timestamp: ts },
      { type: 'stream.delta', payload: 'text', timestamp: ts },
      { type: 'stream.tool_call', payload: { toolCall: { name: 'bash', input: {} } }, timestamp: ts },
      { type: 'stream.tool_call', payload: { toolCall: { id: '', name: 'bash' } }, timestamp: ts },
      { type: 'stream.tool_call', payload: { toolCall: { id: 'c', name: 'bash', input: [1] } }, timestamp: ts },
      { type: 'stream.tool_call', payload: { toolCall: null }, timestamp: ts },
      { type: 'stream.tool_result', payload: { toolResult: { callId: 'c', name: 'bash' } }, timestamp: ts },
      { type: 'stream.tool_result', payload: { toolResult: { callId: 'c', name: 'bash', output: 1 } }, timestamp: ts },
      { type: 'stream.delta', payload: { content: 'x' }, timestamp: Number.NaN },
    ];
    for (const msg of bad) expect(turnEventFromWSMessage(msg)).toBeNull();
  });

  test('tool_result tolerates a missing duration and non-boolean isError', () => {
    expect(
      turnEventFromWSMessage({
        type: 'stream.tool_result',
        payload: { toolResult: { callId: 'c', name: 'bash', output: 'x', isError: 'yes' } },
        timestamp: ts,
      }),
    ).toEqual({
      type: 'tool_result',
      callId: 'c',
      name: 'bash',
      output: 'x',
      isError: false,
      durationMs: 0,
      timestamp: ts,
    });
  });
});
