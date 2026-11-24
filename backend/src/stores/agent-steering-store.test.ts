import { describe, expect, test } from 'bun:test';
import { agentSteeringStore } from './agent-steering-store';

describe('AgentSteeringStore', () => {
  test('queues, edits, reorders, claims, and terminalizes steering independently per agent', async () => {
    const sessionId = `steering-${crypto.randomUUID()}`;
    const first = await agentSteeringStore.enqueue({
      sessionId,
      agentId: 'worker-a',
      content: 'first',
    });
    const second = await agentSteeringStore.enqueue({
      sessionId,
      agentId: 'worker-a',
      content: 'second',
    });
    await agentSteeringStore.enqueue({ sessionId, agentId: 'worker-b', content: 'other worker' });

    expect(
      (await agentSteeringStore.list(sessionId, 'worker-a')).map((item) => item.content),
    ).toEqual(['first', 'second']);
    await agentSteeringStore.edit(second.id, 'edited second');
    await agentSteeringStore.reorder(second.id, first.id);
    expect(
      (await agentSteeringStore.list(sessionId, 'worker-a')).map((item) => item.content),
    ).toEqual(['edited second', 'first']);

    const claimed = await agentSteeringStore.claimNext(sessionId, 'worker-a');
    expect(claimed).toMatchObject({ id: second.id, status: 'dispatching' });
    await agentSteeringStore.updateStatus(second.id, 'completed');
    expect((await agentSteeringStore.list(sessionId, 'worker-b'))[0]?.content).toBe('other worker');
    await agentSteeringStore.remove(first.id);
    expect(
      (await agentSteeringStore.list(sessionId, 'worker-a')).find((item) => item.id === first.id),
    ).toBeUndefined();
  });
});
