import { afterEach, describe, expect, test } from 'bun:test';
import type { WSMessage } from '@koryphaios/shared';
import { WSManager } from '../ws-manager';

const managers: WSManager[] = [];
afterEach(() => {
  for (const manager of managers.splice(0)) manager.shutdown();
});

function createManager(): { manager: WSManager; persisted: WSMessage[] } {
  const manager = new WSManager();
  managers.push(manager);
  const persisted: WSMessage[] = [];
  // Record what reaches the ordered log; pass the message through unchanged.
  (manager as any).persist = (message: WSMessage) => {
    persisted.push(message);
    return message;
  };
  return { manager, persisted };
}

describe('WSManager session identity (Invariant 4)', () => {
  test('drops a session-scoped event that has no sessionId', () => {
    const { manager, persisted } = createManager();
    manager.broadcast({
      type: 'stream.delta',
      timestamp: 1,
      payload: { agentId: 'kory-manager', content: 'x' },
    } as WSMessage);
    manager.broadcast({
      type: 'stream.complete',
      timestamp: 2,
      payload: { agentId: 'kory-manager' },
    } as WSMessage);
    manager.broadcast({
      type: 'agent.status',
      timestamp: 3,
      sessionId: '   ',
      payload: { agentId: 'w', status: 'done' },
    } as WSMessage);
    expect(persisted).toEqual([]);
  });

  test('publishes a session-scoped event that carries its sessionId', () => {
    const { manager, persisted } = createManager();
    manager.broadcast({
      type: 'stream.delta',
      timestamp: 1,
      sessionId: 'session-1',
      payload: { agentId: 'kory-manager', content: 'x' },
    } as WSMessage);
    expect(persisted.map((m) => m.type)).toEqual(['stream.delta']);
  });

  test('does not require a sessionId for global events', () => {
    const { manager, persisted } = createManager();
    manager.broadcast({ type: 'provider.status', timestamp: 1, payload: {} } as WSMessage);
    expect(persisted.map((m) => m.type)).toEqual(['provider.status']);
  });
});
