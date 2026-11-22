import { describe, expect, it } from 'bun:test';
import { DEFAULT_AGENT_SETTINGS, mergeAgentSettings } from '../agent-settings';
import {
  TOOL_CONTEXT_SUMMARY_MAX_CHARS,
  boundToolSummary,
  capToolOutputForContext,
  isSummaryWorthwhile,
  normalizeToolContextMode,
  renderHiddenToolOutput,
  resolveToolContextMode,
} from '../tool-context-policy';

describe('tool context policy', () => {
  it('defaults to full and lets a session override win over the project policy', () => {
    const userPolicies = { bash: 'hidden', read_file: 'summary' } as const;
    expect(resolveToolContextMode(userPolicies, undefined, 'bash')).toBe('hidden');
    expect(resolveToolContextMode(userPolicies, undefined, 'grep')).toBe('full');
    expect(resolveToolContextMode(userPolicies, new Map([['bash', 'summary']]), 'bash')).toBe(
      'summary',
    );
  });

  it('ignores unknown persisted values instead of guessing a mode', () => {
    expect(normalizeToolContextMode('truncated')).toBeNull();
    expect(normalizeToolContextMode(undefined)).toBeNull();
    expect(resolveToolContextMode({ bash: 'bogus' }, undefined, 'bash')).toBe('full');
  });

  it('reports only the tool name, time, size and archive id for hidden results', () => {
    const stub = renderHiddenToolOutput({
      toolName: 'bash',
      outputChars: 24_800,
      ts: new Date('2026-01-01T10:32:04').getTime(),
      archiveId: 'cx_12',
    });
    expect(stub).toContain('bash');
    expect(stub).toContain('24.8k');
    expect(stub).toContain('fetch_context id=cx_12');
    expect(stub).not.toContain('stdout');
  });

  it('only summarizes outputs that are actually worth a round-trip', () => {
    expect(isSummaryWorthwhile(400)).toBe(false);
    expect(isSummaryWorthwhile(20_000)).toBe(true);
  });

  it('bounds a summarizer response without inventing content', () => {
    const long = `${'fact '.repeat(1000)}END`;
    const bounded = boundToolSummary(long);
    expect(bounded.length).toBeLessThanOrEqual(TOOL_CONTEXT_SUMMARY_MAX_CHARS);
    expect(bounded.startsWith('fact fact')).toBe(true);
  });
});

describe('tool output context cap', () => {
  it('leaves a small output untouched', () => {
    expect(capToolOutputForContext('done', 30_000)).toBe('done');
  });

  it('truncates plain text at the cap', () => {
    const capped = capToolOutputForContext('x'.repeat(40_000), 1_000);
    expect(capped.length).toBeLessThan(1_200);
    expect(capped).toContain('truncated');
  });

  it('keeps a JSON result parseable instead of slicing through a string', () => {
    const output = JSON.stringify({ agentId: 'a', evidence: 'e'.repeat(40_000) });
    const capped = capToolOutputForContext(output, 1_000, 'cx_1');
    const parsed = JSON.parse(capped) as { agentId: string; evidence: string };
    expect(parsed.agentId).toBe('a');
    expect(parsed.evidence).toContain('truncated');
    expect(parsed.evidence).toContain('id=cx_1');
    expect(capped.length).toBeLessThanOrEqual(1_400);
  });
});

describe('toolContextPolicies setting', () => {
  it('accepts known modes and drops full or malformed entries', () => {
    const merged = mergeAgentSettings(DEFAULT_AGENT_SETTINGS, {
      toolContextPolicies: {
        bash: 'hidden',
        read_file: 'summary',
        grep: 'full',
        glob: 'nonsense',
      },
    });
    expect(merged.toolContextPolicies).toEqual({ bash: 'hidden', read_file: 'summary' });
  });

  it('rejects a non-object patch', () => {
    const merged = mergeAgentSettings(DEFAULT_AGENT_SETTINGS, {
      toolContextPolicies: ['bash'],
    });
    expect(merged.toolContextPolicies).toEqual({});
  });
});
