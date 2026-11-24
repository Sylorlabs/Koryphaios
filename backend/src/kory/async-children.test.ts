import { describe, expect, test } from 'bun:test';
import {
  AsyncChildLedger,
  CompareGroupLedger,
  normalizeCompareGroupId,
  renderAsyncChildEnvelope,
  renderWaitResult,
  type AsyncChildRecord,
} from './async-children';

function start(
  ledger: AsyncChildLedger,
  agentId: string,
  extra: Partial<{ compareGroupId: string; now: number }> = {},
) {
  return ledger.start({
    agentId,
    task: `task for ${agentId}`,
    abort: new AbortController(),
    now: extra.now ?? 1,
    ...(extra.compareGroupId ? { compareGroupId: extra.compareGroupId } : {}),
  });
}

describe('async child ledger', () => {
  test('a finished child is delivered exactly once, in completion order', () => {
    const ledger = new AsyncChildLedger();
    start(ledger, 'a', { now: 1 });
    start(ledger, 'b', { now: 2 });
    ledger.settle('b', { status: 'completed', result: 'B done', now: 10 });
    ledger.settle('a', { status: 'failed', result: 'WORKER_FAILED: x', now: 20 });

    const batch = ledger.claimPending('batch-1');
    expect(batch.map((record) => record.agentId)).toEqual(['b', 'a']);
    expect(ledger.claimPending('batch-2')).toEqual([]);
    expect(ledger.markBatchDelivered('batch-1').map((record) => record.agentId)).toEqual([
      'b',
      'a',
    ]);
    expect(ledger.hasOutstanding()).toBe(false);
  });

  test('a released batch returns to pending and can be claimed again', () => {
    const ledger = new AsyncChildLedger();
    start(ledger, 'a');
    ledger.settle('a', { status: 'completed', result: 'ok' });
    ledger.claimPending('batch-1');
    expect(ledger.pending()).toEqual([]);
    expect(ledger.releaseBatch('batch-1')).toBe(1);
    expect(ledger.claimPending('batch-2').map((record) => record.agentId)).toEqual(['a']);
  });

  test('settlement is idempotent: the first outcome wins', () => {
    const ledger = new AsyncChildLedger();
    const record = start(ledger, 'a');
    ledger.settle('a', { status: 'completed', result: 'first' });
    ledger.settle('a', { status: 'cancelled', result: 'second' });
    expect(record.status).toBe('completed');
    expect(record.result).toBe('first');
  });

  test('wait_for_agents claims finished results so the continuation never repeats them', () => {
    const ledger = new AsyncChildLedger();
    start(ledger, 'a');
    start(ledger, 'b');
    ledger.settle('a', { status: 'completed', result: 'A' });
    const selected = ledger.selectForWait(undefined);
    expect(selected.records.map((record) => record.agentId)).toEqual(['a', 'b']);
    const claimed = ledger.claimForWait(
      selected.records.filter((record) => record.status !== 'running'),
    );
    expect(claimed.map((record) => record.agentId)).toEqual(['a']);
    expect(ledger.pending()).toEqual([]);
    expect(ledger.hasOutstanding()).toBe(true);
    expect(ledger.selectForWait(['a']).unknown).toEqual([]);
    expect(ledger.selectForWait(['missing']).unknown).toEqual(['missing']);
  });

  test('a claimed-by-wait result leaves a queued batch empty', () => {
    const ledger = new AsyncChildLedger();
    start(ledger, 'a');
    ledger.settle('a', { status: 'completed', result: 'A' });
    ledger.claimPending('batch-1');
    ledger.claimForWait(ledger.selectForWait(['a']).records);
    expect(ledger.queuedBatch('batch-1')).toEqual([]);
  });

  test('abortRunning signals only running children', () => {
    const ledger = new AsyncChildLedger();
    const running = start(ledger, 'a');
    start(ledger, 'b');
    ledger.settle('b', { status: 'completed', result: 'B' });
    expect(ledger.abortRunning()).toBe(1);
    expect(running.abort.signal.aborted).toBe(true);
  });

  test('duplicate handles are rejected', () => {
    const ledger = new AsyncChildLedger();
    start(ledger, 'a');
    expect(() => start(ledger, 'a')).toThrow(/already tracked/);
  });

  test('two chats keep separate ledgers', () => {
    const chatOne = new AsyncChildLedger();
    const chatTwo = new AsyncChildLedger();
    start(chatOne, 'shared-id');
    expect(chatTwo.get('shared-id')).toBeUndefined();
    chatOne.settle('shared-id', { status: 'completed', result: 'only chat one' });
    expect(chatTwo.pending()).toEqual([]);
  });
});

describe('compare groups', () => {
  test('group ids are validated tokens', () => {
    expect(normalizeCompareGroupId(' auth-models ')).toBe('auth-models');
    expect(normalizeCompareGroupId('bad id')).toBeUndefined();
    expect(normalizeCompareGroupId('')).toBeUndefined();
    expect(normalizeCompareGroupId(7)).toBeUndefined();
  });

  test('attempts are recorded per group and re-recording an agent replaces it', () => {
    const groups = new CompareGroupLedger();
    expect(
      groups.record('g1', { agentId: 'x', model: 'a:one', status: 'completed', result: 'r1' }),
    ).toBe(1);
    expect(
      groups.record('g1', { agentId: 'y', model: 'a:two', status: 'failed', result: 'r2' }),
    ).toBe(2);
    expect(
      groups.record('g1', { agentId: 'x', model: 'a:one', status: 'completed', result: 'r1b' }),
    ).toBe(2);
    expect(groups.attempts('g1').map((attempt) => attempt.result)).toEqual(['r1b', 'r2']);
    expect(groups.has('g2')).toBe(false);
  });

  test('a ranking section names every attempt and asks the critic to rank them', () => {
    const groups = new CompareGroupLedger();
    groups.record('g1', {
      agentId: 'x',
      model: 'a:one',
      status: 'completed',
      result: 'first answer',
    });
    groups.record('g1', {
      agentId: 'y',
      model: 'a:two',
      status: 'completed',
      result: 'second answer',
    });
    const section = groups.renderRankingSection('g1') ?? '';
    expect(section).toContain('COMPARE GROUP g1: 2 independent attempt(s)');
    expect(section).toContain('Attempt 1 (x, a:one, completed)');
    expect(section).toContain('Attempt 2 (y, a:two, completed)');
    expect(section).toContain('Rank the attempts');
    expect(groups.renderRankingSection('missing')).toBeUndefined();
  });

  test('a compare group is isolated per session ledger', () => {
    const one = new CompareGroupLedger();
    const two = new CompareGroupLedger();
    one.record('g', { agentId: 'x', status: 'completed', result: 'r' });
    expect(two.has('g')).toBe(false);
  });
});

describe('host-authored continuation text', () => {
  const record = (agentId: string, extra: Partial<AsyncChildRecord>): AsyncChildRecord => {
    const ledger = new AsyncChildLedger();
    const created = start(ledger, agentId);
    ledger.settle(agentId, { status: 'completed', result: 'answer' });
    return Object.assign(created, extra);
  };

  test('the envelope is labelled as host-written, names each worker and groups compare attempts', () => {
    const text = renderAsyncChildEnvelope([
      record('plain', {}),
      record('c1', { compareGroupId: 'g1', routedModel: 'openai:gpt' }),
      record('c2', { compareGroupId: 'g1' }),
    ]);
    expect(text.startsWith('[Host: background worker results]')).toBe(true);
    expect(text).toContain('written by the host, not the user');
    expect(text).toContain('Worker plain (completed).');
    expect(text).toContain('Worker c1 (completed, openai:gpt).');
    expect(text).toContain('Compare group g1 (2 attempt(s)');
    expect(text).toContain('compareGroupId "g1"');
  });

  test('a long worker result is bounded in the continuation', () => {
    const big = 'x'.repeat(20_000);
    const ledger = new AsyncChildLedger();
    start(ledger, 'big');
    ledger.settle('big', { status: 'completed', result: big });
    const text = renderAsyncChildEnvelope(ledger.list());
    expect(text.length).toBeLessThan(7_000);
    expect(text).toContain('[truncated;');
  });

  test('wait results separate finished, running and unknown ids', () => {
    const finished = [record('done', {})];
    const text = renderWaitResult({ finished, running: [record('busy', {})], unknown: ['ghost'] });
    expect(text).toContain('Finished (1):');
    expect(text).toContain('Still running (1): busy');
    expect(text).toContain('Unknown agent ids (not started in this chat): ghost.');
    expect(renderWaitResult({ finished: [], running: [], unknown: [] })).toBe(
      'No background workers are outstanding in this chat.',
    );
  });
});
