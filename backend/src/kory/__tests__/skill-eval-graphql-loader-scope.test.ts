import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GRAPHQL_ENGINEERING_SKILL_EVAL_MATERIALIZERS,
  GRAPHQL_ENGINEERING_SKILL_EVAL_SCORERS,
  GRAPHQL_LOADER_REFERENCE_SOURCE,
} from '../skill-eval-graphql-engineering-fixtures';
import { readFixtureText, writeFixtureFile } from '../skill-eval-fixture-helpers';

const roots: string[] = [];
const scenario = { id: 'graphql-engineering-full-task-2-individual' } as never;
const materializer = GRAPHQL_ENGINEERING_SKILL_EVAL_MATERIALIZERS.find(
  (item) => item.id === 'graphql-engineering/n-plus-one-loader-scope@2',
)!;
const scorer = GRAPHQL_ENGINEERING_SKILL_EVAL_SCORERS.find(
  (item) => item.id === 'graphql-engineering/n-plus-one-loader-scope-scorer@3',
)!;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'kory-graphql-loader-proof-'));
  roots.push(root);
  return root;
}

const imports = `import { expect, test } from 'bun:test';
import { createRequestContext, createSubscriptionEventContext, executeOrdersQuery, type Backend, type Customer } from '../src/orders';
`;

const batching = `test('deduplicates multiple orders into one batch', async () => {
  const b: Backend = {
    calls: [],
    async batchGet(viewerId, ids) {
      this.calls.push({ viewerId, ids: [...ids] });
      return ids.map((id) => ({ id, label: viewerId + ':' + id }));
    },
  };
  const response = await executeOrdersQuery(createRequestContext('alice', b), [
    { id: 'o1', customerId: 'batch-1' },
    { id: 'o2', customerId: 'batch-2' },
    { id: 'o3', customerId: 'batch-1' },
  ]);
  expect(b.calls).toEqual([{ viewerId: 'alice', ids: ['batch-1', 'batch-2'] }]);
  expect(response.orders.map((item) => item.customer?.label)).toEqual([
    'alice:batch-1', 'alice:batch-2', 'alice:batch-1',
  ]);
  expect(response.errors).toEqual([]);
});`;

const differentViewers = `test('sequential users do not share authorized results', async () => {
  const b: Backend = {
    calls: [],
    async batchGet(viewerId, ids) {
      this.calls.push({ viewerId, ids: [...ids] });
      return ids.map((id) => ({ id, label: viewerId + ':' + id }));
    },
  };
  const alice = await executeOrdersQuery(createRequestContext('alice', b), [{ id: 'a', customerId: 'auth-shared' }]);
  const bob = await executeOrdersQuery(createRequestContext('bob', b), [{ id: 'b', customerId: 'auth-shared' }]);
  expect(alice.orders[0]?.customer?.label).toBe('alice:auth-shared');
  expect(bob.orders[0]?.customer?.label).toBe('bob:auth-shared');
  expect(b.calls.map((call) => call.viewerId)).toEqual(['alice', 'bob']);
});`;

const sameViewer = `test('cache hits only inside one context, including for the same viewer', async () => {
  let generation = 0;
  const b: Backend = {
    calls: [],
    async batchGet(viewerId, ids) {
      this.calls.push({ viewerId, ids: [...ids] });
      generation++;
      return ids.map((id) => ({ id, label: id + ':' + generation }));
    },
  };
  const ctx = createRequestContext('alice', b);
  const one = await executeOrdersQuery(ctx, [{ id: 'o1', customerId: 'cache-key' }]);
  const two = await executeOrdersQuery(ctx, [{ id: 'o2', customerId: 'cache-key' }]);
  const three = await executeOrdersQuery(createRequestContext('alice', b), [{ id: 'o3', customerId: 'cache-key' }]);
  expect([one, two, three].map((result) => result.orders[0]?.customer?.label)).toEqual([
    'cache-key:1', 'cache-key:1', 'cache-key:2',
  ]);
  expect(b.calls).toHaveLength(2);
});`;

const partialErrors = `test('key errors preserve other fields, cache within one request and retry in the next', async () => {
  let errorsRemaining = 1;
  const b: Backend = {
    calls: [],
    async batchGet(viewerId, ids) {
      this.calls.push({ viewerId, ids: [...ids] });
      return ids.map((id) => id === 'unstable' && errorsRemaining-- > 0
        ? new Error('missing for ' + viewerId) : { id, label: viewerId + ':' + id });
    },
  };
  const context = createRequestContext('alice', b);
  const first = await executeOrdersQuery(context, [
    { id: 'good', customerId: 'stable' }, { id: 'bad', customerId: 'unstable' },
  ]);
  expect(first.orders).toEqual([
    { id: 'good', customer: { id: 'stable', label: 'alice:stable' } },
    { id: 'bad', customer: null },
  ]);
  expect(first.errors).toEqual(['missing for alice']);
  const repeated = await executeOrdersQuery(context, [{ id: 'again', customerId: 'unstable' }]);
  expect(repeated.errors).toEqual(['missing for alice']);
  expect(repeated.orders[0]?.customer).toBeNull();
  const newRequest = await executeOrdersQuery(createRequestContext('alice', b), [{ id: 'new', customerId: 'unstable' }]);
  expect(newRequest.orders[0]?.customer?.label).toBe('alice:unstable');
  expect(newRequest.errors).toEqual([]);
  expect(b.calls).toHaveLength(2);
});`;

const events = `test('subscription event context is distinct from handshake and prior events', async () => {
  let count = 0;
  const b: Backend = {
    calls: [],
    async batchGet(viewerId, ids) {
      this.calls.push({ viewerId, ids: [...ids] });
      return ids.map((id) => ({ id, label: id + ':' + ++count }));
    },
  };
  const handshake = await executeOrdersQuery(createRequestContext('alice', b), [{ id: 'h', customerId: 'event-key' }]);
  const first = await executeOrdersQuery(createSubscriptionEventContext('alice', b), [{ id: 'e1', customerId: 'event-key' }]);
  const second = await executeOrdersQuery(createSubscriptionEventContext('alice', b), [{ id: 'e2', customerId: 'event-key' }]);
  expect([handshake, first, second].map((result) => result.orders[0]?.customer?.label)).toEqual([
    'event-key:1', 'event-key:2', 'event-key:3',
  ]);
  expect(b.calls).toHaveLength(3);
});`;

const crossUserRace = `test('simultaneous users fetch overlapping keys separately', async () => {
  const pending: Array<{ viewerId: string; ids: string[]; release: (values: Array<Customer | Error | null>) => void }> = [];
  let readySignal = () => {};
  const ready = new Promise<void>((resolve) => { readySignal = resolve; });
  const b: Backend = {
    calls: [],
    batchGet(viewerId, ids) {
      this.calls.push({ viewerId, ids: [...ids] });
      return new Promise((release) => {
        pending.push({ viewerId, ids: [...ids], release });
        if (pending.length === 2) readySignal();
      });
    },
  };
  const alice = executeOrdersQuery(createRequestContext('alice', b), [{ id: 'a', customerId: 'race-key' }]);
  const bob = executeOrdersQuery(createRequestContext('bob', b), [{ id: 'b', customerId: 'race-key' }]);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      ready,
      new Promise<void>((_, reject) => { timeout = setTimeout(() => reject(new Error('Independent batches did not start')), 750); }),
    ]);
    expect(b.calls).toHaveLength(2);
    pending.find((item) => item.viewerId === 'bob')!.release([{ id: 'race-key', label: 'bob:race-key' }]);
    pending.find((item) => item.viewerId === 'alice')!.release([{ id: 'race-key', label: 'alice:race-key' }]);
    const [a, bResult] = await Promise.all([alice, bob]);
    expect(a.orders[0]?.customer?.label).toBe('alice:race-key');
    expect(bResult.orders[0]?.customer?.label).toBe('bob:race-key');
  } finally {
    if (timeout) clearTimeout(timeout);
    for (const item of pending) item.release(item.ids.map((id) => ({ id, label: item.viewerId + ':' + id })));
  }
});`;

const sameContextRace = `test('concurrent fields in one context share an in-flight key', async () => {
  const pending: Array<(values: Array<Customer | Error | null>) => void> = [];
  let signal = () => {};
  const started = new Promise<void>((resolve) => { signal = resolve; });
  const b: Backend = {
    calls: [],
    batchGet(viewerId, ids) {
      this.calls.push({ viewerId, ids: [...ids] });
      return new Promise((release) => { pending.push(release); signal(); });
    },
  };
  const ctx = createRequestContext('alice', b);
  const first = executeOrdersQuery(ctx, [{ id: 'p1', customerId: 'inflight' }]);
  const second = executeOrdersQuery(ctx, [{ id: 'p2', customerId: 'inflight' }]);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      started,
      new Promise<void>((_, reject) => { timeout = setTimeout(() => reject(new Error('No batch started')), 750); }),
    ]);
    expect(b.calls).toEqual([{ viewerId: 'alice', ids: ['inflight'] }]);
  } finally {
    if (timeout) clearTimeout(timeout);
    for (const release of pending) release([{ id: 'inflight', label: 'alice:inflight' }]);
  }
  const [one, two] = await Promise.all([first, second]);
  expect(one.orders[0]?.customer?.label).toBe('alice:inflight');
  expect(two.orders[0]?.customer?.label).toBe('alice:inflight');
});`;

const cases = {
  batching,
  differentViewers,
  sameViewer,
  partialErrors,
  events,
  crossUserRace,
  sameContextRace,
};

async function scorePreparedFixture(testCases: string[], source = GRAPHQL_LOADER_REFERENCE_SOURCE) {
  const root = workspace();
  await materializer.materialize(root, scenario);
  writeFixtureFile(root, 'src/orders.ts', source);
  writeFixtureFile(root, 'tests/orders.test.ts', [imports, ...testCases].join('\n\n'));
  const result = await scorer.score({ workingDirectory: root } as never);
  expect(readFixtureText(root, 'src/orders.ts')).toBe(source);
  return result;
}

describe('GraphQL DataLoader request-scope evaluation oracle', () => {
  test('accepts behaviorally complete regression tests and restores the repair after all controls', async () => {
    const result = await scorePreparedFixture(Object.values(cases));
    expect(result.passed, result.evidence.join('\n')).toBe(true);
    expect(result.evidence).toContain('candidate tests pass reference implementation: yes');
    expect(
      result.evidence.filter((line: string) => line.startsWith('candidate tests reject ')),
    ).toHaveLength(8);
    expect(
      result.evidence
        .filter((line: string) => line.startsWith('candidate tests reject '))
        .every((line: string) => line.endsWith(': yes')),
    ).toBe(true);
  });

  test('rejects keyword-only tests despite a correct candidate implementation', async () => {
    const result = await scorePreparedFixture([
      `test('batch error race subscription cross-user cache', () => { expect(true).toBe(true); });`,
    ]);
    expect(result.passed).toBe(false);
    expect(result.evidence).toContain(
      'hidden batching/request isolation/race/partial errors: pass',
    );
    expect(result.evidence).toContain(
      'candidate tests reject cache shared across authenticated users: no',
    );
    expect(result.evidence).toContain('candidate tests reject unbatched independent requests: no');
  });

  test('requires authored tests that catch cross-user in-flight sharing', async () => {
    const withoutRace = Object.entries(cases)
      .filter(([name]) => name !== 'crossUserRace')
      .map(([, value]) => value);
    const result = await scorePreparedFixture(withoutRace);
    expect(result.passed).toBe(false);
    expect(result.evidence).toContain(
      'candidate tests reject in-flight loads shared across authenticated users: no',
    );
    expect(result.evidence).toContain(
      'candidate tests reject cache shared across authenticated users: yes',
    );
  });

  test('requires authored tests that reject lost partial errors', async () => {
    const withoutErrors = Object.entries(cases)
      .filter(([name]) => name !== 'partialErrors')
      .map(([, value]) => value);
    const result = await scorePreparedFixture(withoutErrors);
    expect(result.passed).toBe(false);
    expect(result.evidence).toContain(
      'candidate tests reject per-key error destroys partial results: no',
    );
    expect(result.evidence).toContain(
      'candidate tests reject subscription events reuse the prior context: yes',
    );
  });

  test('rejects the original broken implementation even with full regression tests', async () => {
    const root = workspace();
    await materializer.materialize(root, scenario);
    writeFixtureFile(root, 'tests/orders.test.ts', [imports, ...Object.values(cases)].join('\n\n'));
    const result = await scorer.score({ workingDirectory: root } as never);
    expect(result.passed).toBe(false);
    expect(result.evidence).toContain(
      'hidden batching/request isolation/race/partial errors: fail',
    );
  });

  test('rejects contract tampering before executing controls, without altering it further', async () => {
    const root = workspace();
    await materializer.materialize(root, scenario);
    const tampered = '# weaker contract\n';
    writeFixtureFile(root, 'graphql-runtime-contract.md', tampered);
    const result = await scorer.score({ workingDirectory: root } as never);
    expect(result).toMatchObject({ passed: false, integrityFailure: true });
    expect(readFixtureText(root, 'graphql-runtime-contract.md')).toBe(tampered);
  });
});
