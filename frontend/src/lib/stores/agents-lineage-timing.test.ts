import { describe, expect, it, vi } from 'vitest';

vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('$lib/api.svelte', () => ({ apiFetch: vi.fn(), parseJsonResponse: vi.fn() }));
vi.mock('$lib/utils/api-url', () => ({ apiUrl: (path: string) => path }));

import type { AgentIdentity } from '@koryphaios/shared';
import { agentStore, noteAgentToolCall } from './agents.svelte';

function identity(id: string, role: AgentIdentity['role'] = 'coder'): AgentIdentity {
  return {
    id,
    name: id,
    role,
    provider: 'openai',
    model: 'gpt-test',
    domain: 'general',
    glowColor: '',
  } as AgentIdentity;
}

describe('agent display timing and lineage', () => {
  it('stamps spawn time and freezes an end time once terminal, clearing it on resume', () => {
    agentStore.spawnAgent('timing-s', identity('w'), 'task', { startedAt: 1_000 });
    const agent = agentStore.getAgent('timing-s', 'w')!;
    expect(agent.startedAt).toBe(1_000);
    expect(agent.endedAt).toBeUndefined();

    agentStore.updateAgentStatus('timing-s', 'w', 'done', 5_000);
    expect(agent.endedAt).toBe(5_000);
    // A second terminal write keeps the first end time.
    agentStore.updateAgentStatus('timing-s', 'w', 'idle', 9_000);
    expect(agent.endedAt).toBe(5_000);

    agentStore.updateAgentStatus('timing-s', 'w', 'thinking', 10_000);
    expect(agent.endedAt).toBeUndefined();
  });

  it('marks a user stop as cancelled so it is not shown as a success', () => {
    agentStore.spawnAgent('stop-s', identity('w'), 'task', { startedAt: 1 });
    agentStore.markAgentStopped('stop-s', 'w');
    const agent = agentStore.getAgent('stop-s', 'w')!;
    expect(agent.status).toBe('done');
    expect(agent.stopReason).toBe('cancelled');
    agentStore.updateAgentStatus('stop-s', 'w', 'thinking');
    expect(agent.stopReason).toBeUndefined();
  });

  it('records an explicit parent and infers the Critic as a review specialist parent', () => {
    agentStore.spawnAgent('lineage-s', identity('w'), 'task', { parentAgentId: 'kory-lead' });
    expect(agentStore.getAgent('lineage-s', 'w')!.parentAgentId).toBe('kory-lead');

    agentStore.spawnAgent('lineage-s', identity('critic-1', 'critic'), 'review');
    agentStore.updateAgentStatus('lineage-s', 'critic-1', 'criticizing');
    agentStore.spawnAgent('lineage-s', identity('rev-1', 'reviewer'), 'red-team');
    expect(agentStore.getAgent('lineage-s', 'rev-1')!.parentAgentId).toBe('critic-1');

    // No running Critic: a reviewer is a direct report of the manager.
    agentStore.updateAgentStatus('lineage-s', 'critic-1', 'done');
    agentStore.spawnAgent('lineage-s', identity('rev-2', 'reviewer'), 'later');
    expect(agentStore.getAgent('lineage-s', 'rev-2')!.parentAgentId).toBeUndefined();
  });

  it('keeps the current tool per (session, agent)', () => {
    noteAgentToolCall('tool-a', 'w', { id: 'c1', name: 'bash', input: { command: 'ls' } });
    expect(agentStore.getAgentCurrentTool('tool-a', 'w')?.name).toBe('bash');
    expect(agentStore.getAgentCurrentTool('tool-b', 'w')).toBeUndefined();
  });
});
