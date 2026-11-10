import { describe, expect, test } from 'bun:test';
import type { TranscriptPart, WSMessage } from '@koryphaios/shared';
import { wsBroker } from '../../pubsub';
import { EventEmitterService } from './EventEmitterService';
import { TurnTranscriptRecorder, finalizeParts } from './TurnTranscriptRecorder';

const MANAGER = 'kory-manager';
const WORKER = 'worker-1';
const SESSION = 'session-1';

function observe(
  recorder: TurnTranscriptRecorder,
  type: string,
  payload: Record<string, unknown>,
  timestamp = 100,
  sessionId = SESSION,
) {
  return recorder.observe({ sessionId, type, payload, timestamp, managerAgentId: MANAGER }) as Record<string, unknown>;
}

describe('TurnTranscriptRecorder', () => {
  test('stamps manager stream events with the turn message id without mutating the caller payload', () => {
    const recorder = new TurnTranscriptRecorder();
    recorder.beginTurn(SESSION, 'msg-1');
    const payload = { agentId: MANAGER, content: 'Hi', model: 'm' };
    const published = observe(recorder, 'stream.delta', payload);
    expect(published).toEqual({ agentId: MANAGER, content: 'Hi', model: 'm', messageId: 'msg-1' });
    expect(published).not.toBe(payload);
    expect(payload).not.toHaveProperty('messageId');
    expect(recorder.currentMessageId(SESSION)).toBe('msg-1');
  });

  test('folds manager events in order and uses the timestamp given to the publish', () => {
    const recorder = new TurnTranscriptRecorder();
    recorder.beginTurn(SESSION, 'msg-1');
    observe(recorder, 'stream.thinking', { agentId: MANAGER, thinking: 'plan' }, 10);
    observe(recorder, 'stream.tool_call', { agentId: MANAGER, toolCall: { id: 'c1', name: 'read_file', input: { path: 'a' } } }, 20);
    observe(recorder, 'stream.tool_result', { agentId: MANAGER, toolResult: { callId: 'c1', name: 'read_file', output: 'ok', isError: false, durationMs: 5 } }, 30);
    observe(recorder, 'stream.thinking', { agentId: MANAGER, thinking: 'more' }, 40);
    observe(recorder, 'stream.delta', { agentId: MANAGER, content: 'Done' }, 50);
    expect(recorder.snapshotParts(SESSION)).toEqual([
      { kind: 'reasoning', text: 'plan', startedAt: 10, endedAt: 20 },
      {
        kind: 'tool', callId: 'c1', name: 'read_file', input: { path: 'a' }, startedAt: 20,
        output: 'ok', isError: false, durationMs: 5, endedAt: 30,
      },
      { kind: 'reasoning', text: 'more', startedAt: 40, endedAt: 50 },
      { kind: 'text', text: 'Done', startedAt: 50 },
    ]);
  });

  test('leaves worker and other-session events unstamped and unfolded', () => {
    const recorder = new TurnTranscriptRecorder();
    recorder.beginTurn(SESSION, 'msg-1');
    const workerPayload = { agentId: WORKER, content: 'worker text' };
    expect(observe(recorder, 'stream.delta', workerPayload)).toBe(workerPayload);
    const otherSession = observe(recorder, 'stream.delta', { agentId: MANAGER, content: 'x' }, 100, 'session-2');
    expect(otherSession).not.toHaveProperty('messageId');
    expect(recorder.snapshotParts(SESSION)).toEqual([]);
  });

  test('ignores non-stream events and payloads without the manager agent id', () => {
    const recorder = new TurnTranscriptRecorder();
    recorder.beginTurn(SESSION, 'msg-1');
    const status = { agentId: MANAGER, status: 'thinking' };
    expect(observe(recorder, 'agent.status', status)).toBe(status);
    const noAgent = { content: 'orphan' };
    expect(observe(recorder, 'stream.delta', noAgent)).toBe(noAgent);
    expect(recorder.snapshotParts(SESSION)).toEqual([]);
  });

  test('endTurn and dispose stop stamping and folding', () => {
    const recorder = new TurnTranscriptRecorder();
    recorder.beginTurn(SESSION, 'msg-1');
    recorder.endTurn(SESSION, 'msg-1');
    const after = { agentId: MANAGER, content: 'late' };
    expect(observe(recorder, 'stream.delta', after)).toBe(after);
    expect(recorder.snapshotParts(SESSION)).toEqual([]);
    expect(recorder.currentMessageId(SESSION)).toBeUndefined();

    recorder.beginTurn(SESSION, 'msg-2');
    recorder.dispose(SESSION);
    expect(recorder.currentMessageId(SESSION)).toBeUndefined();
  });

  test('a superseded turn ending does not close the newer turn', () => {
    const recorder = new TurnTranscriptRecorder();
    recorder.beginTurn(SESSION, 'msg-1');
    recorder.beginTurn(SESSION, 'msg-2');
    recorder.endTurn(SESSION, 'msg-1');
    expect(recorder.currentMessageId(SESSION)).toBe('msg-2');
    expect(observe(recorder, 'stream.delta', { agentId: MANAGER, content: 'x' })).toMatchObject({ messageId: 'msg-2' });
  });

  test('a new turn starts with empty parts and its own id', () => {
    const recorder = new TurnTranscriptRecorder();
    recorder.beginTurn(SESSION, 'msg-1');
    observe(recorder, 'stream.delta', { agentId: MANAGER, content: 'first' });
    recorder.beginTurn(SESSION, 'msg-2');
    expect(recorder.snapshotParts(SESSION)).toEqual([]);
    expect(observe(recorder, 'stream.delta', { agentId: MANAGER, content: 'second' })).toMatchObject({ messageId: 'msg-2' });
  });

  test('EventEmitterService publishes the stamped payload with the same timestamp it folded', () => {
    const published: WSMessage[] = [];
    const broker = wsBroker as unknown as { publish: (channel: string, message: unknown) => void };
    const original = broker.publish;
    broker.publish = (_channel, message) => {
      published.push(message as WSMessage);
    };
    try {
      const emitter = new EventEmitterService({ managerAgentId: MANAGER });
      emitter.transcript.beginTurn(SESSION, 'msg-9');
      emitter.emit(SESSION, 'stream.delta', { agentId: MANAGER, content: 'hello' } as WSMessage['payload']);
      emitter.emit(SESSION, 'stream.delta', { agentId: WORKER, content: 'w' } as WSMessage['payload']);
      const folded = emitter.transcript.snapshotParts(SESSION);
      emitter.transcript.endTurn(SESSION, 'msg-9');
      emitter.emit(SESSION, 'stream.delta', { agentId: MANAGER, content: 'after' } as WSMessage['payload']);

      const [manager, worker, after] = published;
      expect((manager.payload as { messageId?: string }).messageId).toBe('msg-9');
      expect((worker.payload as { messageId?: string }).messageId).toBeUndefined();
      expect((after.payload as { messageId?: string }).messageId).toBeUndefined();
      expect(folded).toEqual([{ kind: 'text', text: 'hello', startedAt: manager.timestamp }]);
    } finally {
      broker.publish = original;
    }
  });
});

describe('finalizeParts', () => {
  const reasoning: TranscriptPart = { kind: 'reasoning', text: 'r', startedAt: 1, endedAt: 2 };
  const tool: TranscriptPart = {
    kind: 'tool', callId: 'c', name: 'n', input: {}, startedAt: 2, output: 'o', endedAt: 3,
  };

  test('keeps parts unchanged when text parts already equal the persisted content', () => {
    const parts: TranscriptPart[] = [reasoning, { kind: 'text', text: 'Hel', startedAt: 3 }, tool, { kind: 'text', text: 'lo', startedAt: 4 }];
    expect(finalizeParts(parts, 'Hello', 99)).toEqual(parts);
  });

  test('closes reasoning a cancelled turn left open at persistence time', () => {
    const open: TranscriptPart = { kind: 'reasoning', text: 'thinking', startedAt: 1 };
    expect(finalizeParts([open], '', 50)).toEqual([{ ...open, endedAt: 50 }]);
    expect(finalizeParts([open, { kind: 'text', text: 'Hi', startedAt: 5 }], 'Hi', 50)).toEqual([
      { ...open, endedAt: 50 },
      { kind: 'text', text: 'Hi', startedAt: 5 },
    ]);
  });

  test('replaces mismatched text with one text part and keeps non-text order', () => {
    const parts: TranscriptPart[] = [reasoning, { kind: 'text', text: 'draft', startedAt: 3 }, tool];
    expect(finalizeParts(parts, 'withheld notice', 99)).toEqual([
      reasoning,
      tool,
      { kind: 'text', text: 'withheld notice', startedAt: 99 },
    ]);
  });

  test('deferred response with no streamed text gets a single authoritative text part', () => {
    expect(finalizeParts([reasoning, tool], 'Answer', 50)).toEqual([
      reasoning, tool, { kind: 'text', text: 'Answer', startedAt: 50 },
    ]);
  });

  test('empty persisted content drops every text part', () => {
    const parts: TranscriptPart[] = [reasoning, { kind: 'text', text: 'stopped partial', startedAt: 3 }, tool];
    expect(finalizeParts(parts, '', 50)).toEqual([reasoning, tool]);
    expect(finalizeParts([], '', 50)).toEqual([]);
  });

  test('does not mutate its input', () => {
    const parts: TranscriptPart[] = [reasoning];
    finalizeParts(parts, 'x', 1);
    expect(parts).toEqual([reasoning]);
  });
});
