import { afterEach, describe, expect, test } from 'bun:test';
import type { ServerWebSocket } from 'bun';
import type { WSMessage } from '@koryphaios/shared';
import { WSManager, type WSClientData } from '../ws-manager';

const managers: WSManager[] = [];
afterEach(() => {
  for (const manager of managers.splice(0)) manager.shutdown();
});

interface FakeSocket {
  sent: string[];
  socket: ServerWebSocket<WSClientData>;
}

function fakeSocket(id: string): FakeSocket {
  const sent: string[] = [];
  const socket = {
    data: { id },
    readyState: 1,
    send(data: string) {
      sent.push(data);
    },
    getBufferedAmount: () => 0,
    close() {},
  } as unknown as ServerWebSocket<WSClientData>;
  return { sent, socket };
}

function createManager() {
  const manager = new WSManager();
  managers.push(manager);
  const persisted: WSMessage[] = [];
  // Terminal traffic must never reach the ordered, replayable event log.
  (manager as any).persist = (message: WSMessage) => {
    persisted.push(message);
    return message;
  };
  return { manager, persisted };
}

function subscribe(manager: WSManager, id: string, sessionId: string) {
  (manager as any).clients.get(id).subscribedSessions.add(sessionId);
}

const output = (terminalId: string): WSMessage =>
  ({
    type: 'terminal.output',
    timestamp: 1,
    payload: { terminalId, seq: 1, data: 'aGk=' },
  }) as WSMessage;

describe('terminal live fan-out', () => {
  test('delivers output only to sockets subscribed to the owning chat', () => {
    const { manager, persisted } = createManager();
    const chatA = fakeSocket('client-a');
    const chatB = fakeSocket('client-b');
    manager.add(chatA.socket);
    manager.add(chatB.socket);
    subscribe(manager, 'client-a', 'chat-a');
    subscribe(manager, 'client-b', 'chat-b');

    manager.broadcastEphemeralToSession('chat-a', output('t1'));

    expect(chatA.sent).toHaveLength(1);
    expect(chatB.sent).toHaveLength(0);
    const frame = JSON.parse(chatA.sent[0]!) as WSMessage;
    expect(frame).toMatchObject({ type: 'terminal.output', sessionId: 'chat-a' });
    expect(persisted).toEqual([]);
  });

  test('does not replay terminal traffic to a client that is not subscribed', () => {
    const { manager } = createManager();
    const stranger = fakeSocket('client-x');
    manager.add(stranger.socket);
    manager.broadcastEphemeralToSession('chat-a', output('t1'));
    expect(stranger.sent).toEqual([]);
  });

  test('drops fan-out to a chat that has been erased', () => {
    const { manager } = createManager();
    const client = fakeSocket('client-a');
    manager.add(client.socket);
    subscribe(manager, 'client-a', 'chat-a');
    manager.forgetSession('chat-a');
    manager.broadcastEphemeralToSession('chat-a', output('t1'));
    expect(client.sent).toEqual([]);
    expect(manager.isClientSubscribedTo('client-a', 'chat-a')).toBe(false);
  });

  test('a command is accepted only from a socket subscribed to that chat', () => {
    const { manager } = createManager();
    const client = fakeSocket('client-a');
    manager.add(client.socket);
    expect(manager.isClientSubscribedTo('client-a', 'chat-a')).toBe(false);
    subscribe(manager, 'client-a', 'chat-a');
    expect(manager.isClientSubscribedTo('client-a', 'chat-a')).toBe(true);
    expect(manager.isClientSubscribedTo('client-a', 'chat-b')).toBe(false);
    expect(manager.isClientSubscribedTo('no-such-client', 'chat-a')).toBe(false);
  });
});
