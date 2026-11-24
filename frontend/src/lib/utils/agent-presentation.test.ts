import { describe, expect, it } from 'vitest';
import {
  agentElapsedMs,
  agentStatusInfo,
  buildLineage,
  describeToolActivity,
  flattenLineage,
  formatElapsed,
  providerLabel,
  resultSummary,
} from './agent-presentation';

const node = (id: string, parentAgentId?: string) => ({ identity: { id }, parentAgentId });

describe('agentStatusInfo', () => {
  it('maps every status to a sentence-case label and a group', () => {
    expect(agentStatusInfo('tool_calling')).toMatchObject({ label: 'Running tool', group: 'running', live: true });
    expect(agentStatusInfo('waiting_user')).toMatchObject({ label: 'Waiting on you', tone: 'attention', live: false });
    expect(agentStatusInfo('criticizing').label).toBe('Reviewing');
    expect(agentStatusInfo('error')).toMatchObject({ label: 'Failed', group: 'failed' });
  });

  it('never calls a user cancellation a success', () => {
    expect(agentStatusInfo('done', { stopReason: 'cancelled' })).toMatchObject({ label: 'Stopped', tone: 'muted' });
    expect(agentStatusInfo('error', { stopReason: 'cancelled' }).label).toBe('Failed');
  });

  it('falls back to a neutral live label for an unknown status', () => {
    expect(agentStatusInfo('teleporting').label).toBe('Working');
  });
});

describe('describeToolActivity', () => {
  it('pairs the tool with its most telling argument, clipped', () => {
    expect(describeToolActivity({ name: 'bash', input: { command: 'ls   -la\n src' } })).toBe('bash · ls -la src');
    expect(describeToolActivity({ name: 'grep', input: { path: 'src/', pattern: 'TODO' } })).toBe('grep · TODO');
    expect(describeToolActivity({ name: 'mcp__kory__kory__read_file', input: { path: 'a.ts' } })).toBe('read_file · a.ts');
    const long = describeToolActivity({ name: 'bash', input: { command: 'x'.repeat(200) } }, 20);
    expect(long).toBe(`bash · ${'x'.repeat(19)}…`);
    expect(describeToolActivity({ name: 'list' })).toBe('list');
    expect(describeToolActivity(undefined)).toBe('');
  });
});

describe('timing', () => {
  it('formats compact elapsed times', () => {
    expect(formatElapsed(8_400)).toBe('8s');
    expect(formatElapsed(245_000)).toBe('4m 05s');
    expect(formatElapsed(4_320_000)).toBe('1h 12m');
    expect(formatElapsed(undefined)).toBe('');
    expect(formatElapsed(-1)).toBe('');
  });

  it('freezes at endedAt and ticks against now otherwise', () => {
    expect(agentElapsedMs({ startedAt: 100, endedAt: 600 }, 10_000)).toBe(500);
    expect(agentElapsedMs({ startedAt: 100 }, 1_100)).toBe(1_000);
    expect(agentElapsedMs({}, 1_100)).toBeUndefined();
    // Clock skew never yields a negative duration.
    expect(agentElapsedMs({ startedAt: 5_000 }, 1_000)).toBe(0);
  });
});

describe('labels', () => {
  it('names providers and capitalises unknown ids', () => {
    expect(providerLabel('codex')).toBe('Codex CLI');
    expect(providerLabel('commandcode')).toBe('Commandcode');
  });

  it('summarises a result by its first non-heading line', () => {
    expect(resultSummary('## Summary\n\n- Added **x**')).toBe('Added **x**');
    expect(resultSummary('')).toBe('');
  });
});

describe('buildLineage', () => {
  it('nests children (and grandchildren) under their parent in input order', () => {
    const rows = flattenLineage(buildLineage([node('a'), node('b', 'a'), node('c', 'b'), node('d')]));
    expect(rows.map((row) => [row.agent.identity.id, row.depth])).toEqual([
      ['a', 0], ['b', 1], ['c', 2], ['d', 0],
    ]);
  });

  it('treats a missing parent as a root and survives cycles', () => {
    const orphan = flattenLineage(buildLineage([node('x', 'gone')]));
    expect(orphan.map((row) => row.depth)).toEqual([0]);
    const cyclic = flattenLineage(buildLineage([node('p', 'q'), node('q', 'p')]));
    expect(cyclic.map((row) => row.agent.identity.id).sort()).toEqual(['p', 'q']);
  });
});
