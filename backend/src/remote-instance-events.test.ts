import { expect, test } from 'bun:test';
import { WSManager } from './ws/ws-manager';
import { startRemoteInstanceEvents } from './remote-instance-events';

test('remote replies are scoped to the hosted session, reset correctly, and stop on disposal', async () => {
  const events: Record<string, unknown>[] = [];
  const manager = new WSManager();
  const stop = startRemoteInstanceEvents('remote', (event) => events.push(event), manager);
  manager.broadcastToSession('other', {
    type: 'stream.delta',
    sessionId: 'other',
    timestamp: 0,
    payload: { agentId: 'kory-manager', content: 'PRIVATE OTHER CHAT' },
  });
  manager.broadcastToSession('remote', {
    type: 'stream.delta',
    sessionId: 'remote',
    timestamp: 0,
    replayed: true,
    payload: { agentId: 'kory-manager', content: 'OLD REPLAY' },
  });
  for (const message of [
    { type: 'stream.delta' as const, payload: { agentId: 'kory-manager', content: 'discard' } },
    { type: 'stream.clear_content' as const, payload: { agentId: 'kory-manager' } },
    { type: 'stream.delta' as const, payload: { agentId: 'kory-manager', content: 'Hello ' } },
    { type: 'stream.delta' as const, payload: { agentId: 'kory-manager', content: 'VPS' } },
    { type: 'stream.complete' as const, payload: { agentId: 'kory-manager' } },
    { type: 'agent.status' as const, payload: { agentId: 'kory-manager', status: 'done' } },
  ])
    manager.broadcastToSession('remote', { ...message, sessionId: 'remote', timestamp: 0 });
  await Bun.sleep(10);
  expect(events).toEqual([
    { type: 'chat', from: 'agent', content: 'Hello VPS' },
    { type: 'agent-status', status: 'kory-manager: done' },
  ]);
  await stop();
  manager.broadcastToSession('remote', {
    type: 'agent.status',
    timestamp: 0,
    payload: { agentId: 'kory-manager', status: 'thinking' },
  });
  expect(events).toHaveLength(2);
  manager.shutdown();
});

test('direct run-coordinator publications and errors reach the guest and stale revisions are ignored', async () => {
  const events: Record<string, unknown>[] = [];
  const manager = new WSManager();
  const stop = startRemoteInstanceEvents(
    'remote-lifecycle',
    (event) => events.push(event),
    manager,
  );
  for (const revision of [2, 2, 1])
    manager.broadcastToSession('remote-lifecycle', {
      type: 'run.state',
      timestamp: 0,
      payload: { snapshot: { revision, phase: 'error', status: 'terminal' } },
    });
  manager.broadcastToSession('remote-lifecycle', {
    type: 'system.error',
    timestamp: 0,
    payload: { error: 'No providers configured.' },
  });
  expect(events).toEqual([
    { type: 'agent-status', status: 'Remote run: error' },
    { type: 'agent-status', status: 'Remote run: error' },
    { type: 'chat', from: 'agent', content: 'No providers configured.' },
  ]);
  await stop();
  manager.shutdown();
});
