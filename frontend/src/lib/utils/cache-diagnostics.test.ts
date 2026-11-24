import { describe, expect, it } from 'vitest';
import { buildCacheDiagnosticsNotice, normalizeCacheDiagnostics } from './cache-diagnostics';

describe('normalizeCacheDiagnostics', () => {
  it('rejects payloads that are not objects', () => {
    expect(normalizeCacheDiagnostics(null)).toBeNull();
    expect(normalizeCacheDiagnostics(undefined)).toBeNull();
    expect(normalizeCacheDiagnostics('boom')).toBeNull();
    expect(normalizeCacheDiagnostics([])).toBeNull();
  });

  it('fills every section when the backend omits them entirely', () => {
    const diagnostics = normalizeCacheDiagnostics({});
    expect(diagnostics).not.toBeNull();
    expect(diagnostics!.prompt.dispatches).toBe(0);
    expect(diagnostics!.evidence.hits).toBe(0);
    expect(diagnostics!.maintenance.refreshes).toBe(0);
    expect(diagnostics!.durable.hitRate).toBe(0);
    expect(diagnostics!.durable.byProvider).toEqual([]);
    expect(diagnostics!.recent).toEqual([]);
    expect(() => buildCacheDiagnosticsNotice(diagnostics!)).not.toThrow();
  });

  it('keeps working when only some sections are present', () => {
    const diagnostics = normalizeCacheDiagnostics({
      prompt: { dispatches: 4, warmCandidates: 3 },
      durable: { hitRate: 0.42, savingsUsd: -0.5, averageTtftMs: null },
    });
    expect(diagnostics!.prompt.warmCandidates).toBe(3);
    expect(diagnostics!.prompt.workspaceWarmCandidates).toBe(0);
    expect(diagnostics!.durable.hitRate).toBe(0.42);
    expect(diagnostics!.durable.averageLatencyMs).toBeNull();
    expect(buildCacheDiagnosticsNotice(diagnostics!)).toContain('42% hit rate');
  });

  it('drops non-numeric counters instead of propagating NaN', () => {
    const diagnostics = normalizeCacheDiagnostics({
      prompt: { dispatches: 'many' },
      evidence: { hits: null, misses: Number.NaN, waits: Infinity },
      durable: { byProvider: 'nope' },
    });
    expect(diagnostics!.prompt.dispatches).toBe(0);
    expect(diagnostics!.evidence.hits).toBe(0);
    expect(diagnostics!.evidence.misses).toBe(0);
    expect(diagnostics!.evidence.waits).toBe(0);
    expect(diagnostics!.durable.byProvider).toEqual([]);
  });

  it('normalizes recent dispatches, including missing details', () => {
    const diagnostics = normalizeCacheDiagnostics({
      recent: [
        { state: 'nonsense', reasons: ['toolset', 7] },
        {
          state: 'cold',
          laneKind: 'kory',
          reasons: ['history-rewrite'],
          details: { toolsAdded: 'kory_read', historyRewriteAt: 2 },
        },
      ],
    });
    expect(diagnostics!.recent[0].state).toBe('cold');
    expect(diagnostics!.recent[0].reasons).toEqual(['toolset']);
    expect(diagnostics!.recent[0].details).toBeUndefined();
    expect(diagnostics!.recent[1].details).toEqual({
      toolsAdded: [],
      toolsRemoved: [],
      toolSchemasChanged: false,
      stableComponentsChanged: [],
      historyRewriteAt: 2,
    });
  });
});

describe('buildCacheDiagnosticsNotice', () => {
  it('describes the cold reason of the newest dispatch', () => {
    const notice = buildCacheDiagnosticsNotice(
      normalizeCacheDiagnostics({
        prompt: { dispatches: 5, warmCandidates: 2, workspaceWarmCandidates: 1 },
        recent: [
          {
            state: 'cold',
            reasons: ['toolset'],
            details: { toolsAdded: ['kory_read'], toolSchemasChanged: false },
          },
        ],
      })!,
    );
    expect(notice).toContain('Harness cache: 3/5 warm candidates.');
    expect(notice).toContain('Last cold reason: toolset (tools added: kory_read).');
  });

  it('reports a net cache premium when savings are negative', () => {
    const notice = buildCacheDiagnosticsNotice(
      normalizeCacheDiagnostics({ durable: { savingsUsd: -0.1234 } })!,
    );
    expect(notice).toContain('net cache premium');
  });
});
