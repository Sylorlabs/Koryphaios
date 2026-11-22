import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { WSMessage } from '@koryphaios/shared';
import { wsBroker } from '../../pubsub';
import { EventEmitterService } from './EventEmitterService';

const MANAGER = 'kory-manager';
const WORKER = 'worker-1';
const SESSION = 'session-1';

/** Capture what the emitter publishes, in order, without touching the real socket broker. */
const published: WSMessage[] = [];
const broker = wsBroker as unknown as { publish: (channel: string, message: unknown) => void };
let originalPublish: typeof broker.publish;
beforeEach(() => {
  originalPublish = broker.publish;
  broker.publish = (_channel, message) => {
    published.push(message as WSMessage);
  };
});
afterEach(() => {
  broker.publish = originalPublish;
  published.length = 0;
});

function callOf(message: WSMessage) {
  return (message.payload as { toolCall: { id: string; nativeRef?: string; name: string } }).toolCall;
}
function resultOf(message: WSMessage) {
  return (message.payload as { toolResult: { callId: string; nativeRef?: string; name: string } }).toolResult;
}

function emitCall(emitter: EventEmitterService, agentId: string, id: string | undefined, name = 'read_file') {
  emitter.emit(SESSION, 'stream.tool_call', {
    agentId,
    toolCall: { ...(id === undefined ? {} : { id }), name, input: {} },
  } as never);
}
function emitResult(emitter: EventEmitterService, agentId: string, callId: string | undefined, output = 'ok') {
  emitter.emit(SESSION, 'stream.tool_result', {
    agentId,
    toolResult: { ...(callId === undefined ? {} : { callId }), name: 'read_file', output, isError: false, durationMs: 0 },
  } as never);
}

describe('EventEmitterService tool call identity', () => {
  test('a result carries the app id of its call and keeps the native id as nativeRef', () => {
    const emitter = new EventEmitterService({ managerAgentId: MANAGER });
    emitCall(emitter, MANAGER, 'toolu_native_1');
    emitResult(emitter, MANAGER, 'toolu_native_1');

    const [call, result] = published;
    const callId = callOf(call).id;
    expect(callId).toMatch(/^tc_/);
    expect(callId).not.toBe('toolu_native_1');
    expect(callOf(call).nativeRef).toBe('toolu_native_1');
    expect(resultOf(result).callId).toBe(callId);
    expect(resultOf(result).nativeRef).toBe('toolu_native_1');
  });

  test('an orphan result (native id never seen) gets a fresh app id and stays visible', () => {
    const emitter = new EventEmitterService({ managerAgentId: MANAGER });
    emitCall(emitter, MANAGER, 'known');
    emitResult(emitter, MANAGER, 'never-called');

    const callId = callOf(published[0]).id;
    const orphan = resultOf(published[1]);
    expect(orphan.callId).toMatch(/^tc_/);
    expect(orphan.callId).not.toBe(callId);
    expect(orphan.nativeRef).toBe('never-called');
  });

  test('a call with no native id gets a fresh app id and no nativeRef', () => {
    const emitter = new EventEmitterService({ managerAgentId: MANAGER });
    emitCall(emitter, MANAGER, undefined);
    emitCall(emitter, MANAGER, undefined);

    const [a, b] = published.map(callOf);
    expect(a.id).toMatch(/^tc_/);
    expect(b.id).toMatch(/^tc_/);
    expect(a.id).not.toBe(b.id);
    expect(a).not.toHaveProperty('nativeRef');
  });

  test('a reused native id across two calls yields two distinct app ids, matched in order', () => {
    const emitter = new EventEmitterService({ managerAgentId: MANAGER });
    emitCall(emitter, MANAGER, 'read');
    emitResult(emitter, MANAGER, 'read', 'first');
    emitCall(emitter, MANAGER, 'read');
    emitResult(emitter, MANAGER, 'read', 'second');

    const [call1, result1, call2, result2] = published;
    expect(callOf(call1).id).not.toBe(callOf(call2).id);
    expect(resultOf(result1).callId).toBe(callOf(call1).id);
    expect(resultOf(result2).callId).toBe(callOf(call2).id);
  });

  test('a call announced again before its result (start, then stop) keeps one app id', () => {
    const emitter = new EventEmitterService({ managerAgentId: MANAGER });
    emitCall(emitter, MANAGER, 'toolu_1');
    emitCall(emitter, MANAGER, 'toolu_1');
    emitResult(emitter, MANAGER, 'toolu_1');

    const [start, stop, result] = published;
    expect(callOf(stop).id).toBe(callOf(start).id);
    expect(resultOf(result).callId).toBe(callOf(start).id);
  });

  test('two agents with the same native id never share an app id', () => {
    const emitter = new EventEmitterService({ managerAgentId: MANAGER });
    emitCall(emitter, MANAGER, 'read');
    emitCall(emitter, WORKER, 'read');
    emitResult(emitter, WORKER, 'read', 'worker output');
    emitResult(emitter, MANAGER, 'read', 'manager output');

    const [managerCall, workerCall, workerResult, managerResult] = published;
    expect(callOf(managerCall).id).not.toBe(callOf(workerCall).id);
    // Each result resolves inside its own agent's scope.
    expect(resultOf(workerResult).callId).toBe(callOf(workerCall).id);
    expect(resultOf(managerResult).callId).toBe(callOf(managerCall).id);
  });

  test('a manager turn start forgets remembered manager ids, so a stale native id is an orphan', () => {
    const emitter = new EventEmitterService({ managerAgentId: MANAGER });
    emitter.transcript.beginTurn(SESSION, 'msg-1');
    emitCall(emitter, MANAGER, 'read');
    emitter.transcript.endTurn(SESSION, 'msg-1');

    emitter.transcript.beginTurn(SESSION, 'msg-2');
    emitResult(emitter, MANAGER, 'read');

    const oldCallId = callOf(published[0]).id;
    expect(resultOf(published[1]).callId).not.toBe(oldCallId);
    expect(resultOf(published[1]).nativeRef).toBe('read');
  });

  test('the stamped app id is what the persisted parts fold to', () => {
    const emitter = new EventEmitterService({ managerAgentId: MANAGER });
    emitter.transcript.beginTurn(SESSION, 'msg-1');
    emitCall(emitter, MANAGER, 'read');
    emitResult(emitter, MANAGER, 'read', 'contents');

    const parts = emitter.transcript.snapshotParts(SESSION);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ kind: 'tool', callId: callOf(published[0]).id, output: 'contents' });
    expect(parts[0]).not.toMatchObject({ callId: 'read' });
  });
});
