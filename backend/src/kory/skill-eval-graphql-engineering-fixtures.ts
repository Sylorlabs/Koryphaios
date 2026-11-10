import type {
  SkillEvalDeterministicScorer,
  SkillEvalFixtureMaterializer,
} from './skill-eval-execution';
import {
  fixtureTextEquals,
  packageJson,
  readFixtureText,
  runCandidateBunTests,
  runHiddenBunTest,
  writeFixtureFile,
} from './skill-eval-fixture-helpers';

const SCHEMA_EVOLUTION = 'graphql-engineering-full-task-1-individual';
const LOADER_SCOPE = 'graphql-engineering-full-task-2-individual';

const SCHEMA_INITIAL = `type Query {
  user(id: ID!): User
}

type User {
  id: ID!
  displayName: String!
  avatarUrl: String!
}
`;

const SCHEMA_RESOLVERS = `export interface StoredUser {
  id: string;
  displayName: string;
  avatar?: { url: string; width: number; height: number } | null;
}

export function resolveAvatarUrl(user: StoredUser): string {
  // BUG: legacy field is treated as non-null even though avatar may now be absent.
  if (!user.avatar) throw new Error('avatar missing');
  return user.avatar.url;
}

export function resolveAvatar(user: StoredUser): StoredUser['avatar'] {
  return user.avatar ?? null;
}

export function executeAvatarQuery(
  user: StoredUser,
  options: { avatarResolverFails?: boolean } = {},
): { data: { user: { id: string; avatar: StoredUser['avatar'] | null } | null }; errors: string[] } {
  if (options.avatarResolverFails) {
    // BUG: an optional avatar resolver error incorrectly nulls the whole user.
    return { data: { user: null }, errors: ['avatar backend failed'] };
  }
  return { data: { user: { id: user.id, avatar: resolveAvatar(user) } }, errors: [] };
}
`;

const SCHEMA_PUBLIC_TEST = `import { expect, test } from 'bun:test';
import { resolveAvatarUrl } from '../src/resolvers';

test('legacy avatarUrl still resolves for users with an avatar', () => {
  expect(resolveAvatarUrl({ id: 'u1', displayName: 'A', avatar: { url: 'https://img/a', width: 64, height: 64 } })).toBe('https://img/a');
});
`;

const SCHEMA_LEGACY_QUERY = `query LegacyUser($id: ID!) {
  user(id: $id) {
    id
    displayName
    avatarUrl
  }
}
`;

const SCHEMA_MIGRATION_CONTRACT = `# GraphQL schema-evolution contract

- Existing mobile clients continue querying \`User.avatarUrl\` throughout the compatibility window.
- Some users legitimately have no avatar. The compatibility field therefore cannot remain non-null once absence is representable.
- Add richer optional \`User.avatar: Avatar\`; \`Avatar\` exposes \`url: String!\`, \`width: Int!\`, and \`height: Int!\`.
- Keep \`avatarUrl\` as a nullable \`String\` and deprecate it with a migration reason pointing callers to \`avatar.url\`.
- If the optional avatar resolver fails, GraphQL-style partial semantics retain the user object, set \`avatar\` to null, and surface an error. Do not null the whole User.
- Storage layout is out of scope. Preserve the persisted legacy query.
`;

const schemaMaterializer: SkillEvalFixtureMaterializer = {
  // Version 2 requires tests that detect schema and resolver regressions
  // independently. The revised task instructions are a new input contract.
  id: 'graphql-engineering/nullable-field-evolution@2',
  matches: (scenario) => scenario.id === SCHEMA_EVOLUTION,
  materialize: (destination) => {
    writeFixtureFile(destination, 'package.json', packageJson('kory-eval-graphql-schema'));
    writeFixtureFile(destination, 'schema.graphql', SCHEMA_INITIAL);
    writeFixtureFile(destination, 'src/resolvers.ts', SCHEMA_RESOLVERS);
    writeFixtureFile(destination, 'tests/schema.test.ts', SCHEMA_PUBLIC_TEST);
    writeFixtureFile(destination, 'persisted-queries/legacy-mobile.graphql', SCHEMA_LEGACY_QUERY);
    writeFixtureFile(destination, 'migration-contract.md', SCHEMA_MIGRATION_CONTRACT);
    writeFixtureFile(
      destination,
      'README.md',
      `# GraphQL nullable-field evolution fixture

Evolve \`schema.graphql\` and \`src/resolvers.ts\` under the migration contract. Expand tests for present/absent avatars, old persisted-query behavior, optional-field resolver failure, and schema deprecation/nullability evidence. The tests must distinguish the repaired behavior from both independent regressions: restoring the original non-null legacy schema while retaining the repaired resolvers, and restoring the original missing-avatar/whole-user-null resolver behavior while retaining the repaired schema. Preserve \`persisted-queries/legacy-mobile.graphql\` and \`migration-contract.md\` exactly.
`,
    );
  },
};

const schemaScorer: SkillEvalDeterministicScorer = {
  id: 'graphql-engineering/nullable-field-evolution-scorer@2',
  scenarioIds: [SCHEMA_EVOLUTION],
  score: ({ workingDirectory }) => {
    const immutableInputs =
      fixtureTextEquals(
        workingDirectory,
        'persisted-queries/legacy-mobile.graphql',
        SCHEMA_LEGACY_QUERY,
      ) && fixtureTextEquals(workingDirectory, 'migration-contract.md', SCHEMA_MIGRATION_CONTRACT);
    if (!immutableInputs) {
      return {
        passed: false,
        quality: 0,
        verification: 0,
        integrityFailure: true,
        evidence: ['Migration contract or persisted legacy query was modified or removed.'],
      };
    }
    const schema = readFixtureText(workingDirectory, 'schema.graphql');
    const schemaContract =
      /type\s+Avatar\s*\{[^}]*url\s*:\s*String![^}]*width\s*:\s*Int![^}]*height\s*:\s*Int!/isu.test(
        schema,
      ) &&
      /avatar\s*:\s*Avatar\b/u.test(schema) &&
      /avatarUrl\s*:\s*String\b(?!\s*!)/u.test(schema) &&
      /avatarUrl[^\n]*@deprecated\s*\([^)]*avatar\.url/iu.test(schema) &&
      !/avatarUrl\s*:\s*String\s*!/u.test(schema);
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import { expect, test } from 'bun:test';
import { executeAvatarQuery, resolveAvatar, resolveAvatarUrl } from '../src/resolvers';

const withAvatar = { id: 'u1', displayName: 'A', avatar: { url: 'https://img/a', width: 64, height: 32 } };
const withoutAvatar = { id: 'u2', displayName: 'B', avatar: null };

test('hidden: legacy field remains compatible and nullable', () => {
  expect(resolveAvatarUrl(withAvatar)).toBe('https://img/a');
  expect(resolveAvatarUrl(withoutAvatar)).toBeNull();
});

test('hidden: richer avatar object is optional', () => {
  expect(resolveAvatar(withAvatar)).toEqual(withAvatar.avatar);
  expect(resolveAvatar(withoutAvatar)).toBeNull();
});

test('hidden: optional avatar resolver error preserves parent and reports partial error', () => {
  const result = executeAvatarQuery(withAvatar, { avatarResolverFails: true });
  expect(result.data.user).toEqual({ id: 'u1', avatar: null });
  expect(result.errors.length).toBeGreaterThan(0);
});
`,
    );
    // A keyword mention in a test does not demonstrate regression protection.
    // Require the candidate's tests to pass its repair and reject the original
    // broken schema and resolver independently, without changing hidden checks.
    const candidateSchema = schema;
    const candidateResolvers = readFixtureText(workingDirectory, 'src/resolvers.ts');
    const candidateTests = readFixtureText(workingDirectory, 'tests/schema.test.ts');
    const legacyOperationCoverage =
      /persisted-queries[\\/]legacy-mobile\.graphql/u.test(candidateTests) &&
      /avatarUrl/u.test(candidateTests) &&
      /expect\s*\(/u.test(candidateTests);
    const candidate = runCandidateBunTests(workingDirectory);
    let rejectsBrokenSchema = false;
    let rejectsBrokenResolver = false;
    let brokenSchemaEvidence = 'Skipped: candidate tests did not pass.';
    let brokenResolverEvidence = 'Skipped: candidate tests did not pass.';
    if (candidate.completed && candidate.passed) {
      try {
        writeFixtureFile(workingDirectory, 'schema.graphql', SCHEMA_INITIAL);
        const brokenSchema = runCandidateBunTests(workingDirectory);
        rejectsBrokenSchema = brokenSchema.completed && !brokenSchema.passed;
        brokenSchemaEvidence = brokenSchema.evidence;

        writeFixtureFile(workingDirectory, 'schema.graphql', candidateSchema);
        writeFixtureFile(workingDirectory, 'src/resolvers.ts', SCHEMA_RESOLVERS);
        const brokenResolver = runCandidateBunTests(workingDirectory);
        rejectsBrokenResolver = brokenResolver.completed && !brokenResolver.passed;
        brokenResolverEvidence = brokenResolver.evidence;
      } finally {
        writeFixtureFile(workingDirectory, 'schema.graphql', candidateSchema);
        writeFixtureFile(workingDirectory, 'src/resolvers.ts', candidateResolvers);
      }
    }
    const regressionProof = candidate.passed && rejectsBrokenSchema && rejectsBrokenResolver;
    const passed = schemaContract && hidden.passed && regressionProof && legacyOperationCoverage;
    return {
      passed,
      quality: passed ? 1 : schemaContract && hidden.passed ? 0.75 : 0,
      verification: schemaContract && hidden.passed ? 1 : 0,
      integrityFailure: false,
      evidence: [
        `schema nullability/deprecation contract: ${schemaContract ? 'pass' : 'fail'}`,
        `hidden resolver compatibility/partial errors: ${hidden.passed ? 'pass' : 'fail'}`,
        `candidate tests pass repair: ${candidate.passed ? 'yes' : 'no'}`,
        `candidate tests reject broken schema: ${rejectsBrokenSchema ? 'yes' : 'no'}`,
        `candidate tests reject broken resolver: ${rejectsBrokenResolver ? 'yes' : 'no'}`,
        `candidate tests exercise persisted legacy operation: ${legacyOperationCoverage ? 'yes' : 'no'}`,
        candidate.evidence,
        brokenSchemaEvidence,
        brokenResolverEvidence,
        hidden.evidence,
      ],
    };
  },
};

const LOADER_SOURCE = `export interface Customer {
  id: string;
  label: string;
}

export interface Order {
  id: string;
  customerId: string;
}

export interface Backend {
  calls: Array<{ viewerId: string; ids: string[] }>;
  batchGet(viewerId: string, ids: string[]): Promise<Array<Customer | Error | null>>;
}

const globalCache = new Map<string, Customer | Error | null>();

export interface RequestContext {
  viewerId: string;
  backend: Backend;
  cache: Map<string, Customer | Error | null>;
}

export function createRequestContext(viewerId: string, backend: Backend): RequestContext {
  // BUG: cache is global, so one caller's authorized object can leak to another.
  return { viewerId, backend, cache: globalCache };
}

export function createSubscriptionEventContext(viewerId: string, backend: Backend): RequestContext {
  return createRequestContext(viewerId, backend);
}

export async function executeOrdersQuery(
  context: RequestContext,
  orders: Order[],
): Promise<{ orders: Array<{ id: string; customer: Customer | null }>; errors: string[] }> {
  const result: Array<{ id: string; customer: Customer | null }> = [];
  const errors: string[] = [];
  for (const order of orders) {
    let customer = context.cache.get(order.customerId);
    if (customer === undefined) {
      const [loaded] = await context.backend.batchGet(context.viewerId, [order.customerId]);
      customer = loaded ?? null;
      context.cache.set(order.customerId, customer);
    }
    if (customer instanceof Error) {
      errors.push(customer.message);
      result.push({ id: order.id, customer: null });
    } else {
      result.push({ id: order.id, customer });
    }
  }
  return { orders: result, errors };
}
`;

// A portable, known-good implementation of the fixture's public contract.
// Candidate-authored tests must pass this control before failures on the
// independent faulty implementations can count as regression evidence.
export const GRAPHQL_LOADER_REFERENCE_SOURCE = `export interface Customer {
  id: string;
  label: string;
}

export interface Order {
  id: string;
  customerId: string;
}

export interface Backend {
  calls: Array<{ viewerId: string; ids: string[] }>;
  batchGet(viewerId: string, ids: string[]): Promise<Array<Customer | Error | null>>;
}

export interface RequestContext {
  viewerId: string;
  backend: Backend;
  cache: Map<string, Customer | Error | null>;
  pending: Map<string, Promise<Customer | Error | null>>;
}

export function createRequestContext(viewerId: string, backend: Backend): RequestContext {
  return { viewerId, backend, cache: new Map(), pending: new Map() };
}

export function createSubscriptionEventContext(viewerId: string, backend: Backend): RequestContext {
  return createRequestContext(viewerId, backend);
}

export async function executeOrdersQuery(
  context: RequestContext,
  orders: Order[],
): Promise<{ orders: Array<{ id: string; customer: Customer | null }>; errors: string[] }> {
  const keys = [...new Set(orders.map((order) => order.customerId))];
  const missing = keys.filter((key) => !context.cache.has(key) && !context.pending.has(key));
  if (missing.length) {
    const batch = Promise.resolve().then(() => context.backend.batchGet(context.viewerId, missing));
    missing.forEach((key, index) => {
      const loading = batch.then((values) => values[index] ?? null);
      context.pending.set(key, loading);
      void loading.then(
        (value) => { context.cache.set(key, value); context.pending.delete(key); },
        () => { context.pending.delete(key); },
      );
    });
  }
  const loaded = await Promise.all(orders.map((order) =>
    context.cache.has(order.customerId)
      ? context.cache.get(order.customerId)!
      : context.pending.get(order.customerId)!,
  ));
  const errors: string[] = [];
  const responseOrders = orders.map((order, index) => {
    const value = loaded[index]!;
    if (value instanceof Error) {
      errors.push(value.message);
      return { id: order.id, customer: null };
    }
    return { id: order.id, customer: value };
  });
  return { orders: responseOrders, errors };
}
`;

function loaderFaultySource(original: string, target: string, replacement: string): string {
  if (!original.includes(target))
    throw new Error('GraphQL loader control has a stale mutation anchor');
  return original.replace(target, replacement);
}

// Distinct defects keep unrelated correct behavior available to the candidate
// tests. Rejecting the original source alone would only prove one assertion.
const LOADER_NEGATIVE_CONTROLS = [
  { name: 'original shared cache and N+1', source: LOADER_SOURCE },
  {
    name: 'unbatched independent requests',
    source: loaderFaultySource(
      GRAPHQL_LOADER_REFERENCE_SOURCE,
      'const batch = Promise.resolve().then(() => context.backend.batchGet(context.viewerId, missing));',
      'const batch = Promise.all(missing.map(async (key) => (await context.backend.batchGet(context.viewerId, [key]))[0] ?? null));',
    ),
  },
  {
    name: 'cache shared across authenticated users',
    source:
      'const sharedCache = new Map<string, Customer | Error | null>();\n' +
      loaderFaultySource(
        GRAPHQL_LOADER_REFERENCE_SOURCE,
        'cache: new Map(), pending: new Map()',
        'cache: sharedCache, pending: new Map()',
      ),
  },
  {
    name: 'cache reused by separate requests from the same viewer',
    source:
      `const viewerCaches = new Map<string, Map<string, Customer | Error | null>>();
function viewerCache(viewerId: string): Map<string, Customer | Error | null> {
  let cache = viewerCaches.get(viewerId);
  if (!cache) { cache = new Map(); viewerCaches.set(viewerId, cache); }
  return cache;
}
` +
      loaderFaultySource(
        GRAPHQL_LOADER_REFERENCE_SOURCE,
        'cache: new Map(), pending: new Map()',
        'cache: viewerCache(viewerId), pending: new Map()',
      ),
  },
  {
    name: 'in-flight loads shared across authenticated users',
    source:
      'const sharedPending = new Map<string, Promise<Customer | Error | null>>();\n' +
      loaderFaultySource(
        GRAPHQL_LOADER_REFERENCE_SOURCE,
        'cache: new Map(), pending: new Map()',
        'cache: new Map(), pending: sharedPending',
      ),
  },
  {
    name: 'in-flight duplicate loads within one request',
    source: loaderFaultySource(
      GRAPHQL_LOADER_REFERENCE_SOURCE,
      '!context.cache.has(key) && !context.pending.has(key)',
      '!context.cache.has(key)',
    ),
  },
  {
    name: 'per-key error destroys partial results',
    source: loaderFaultySource(
      GRAPHQL_LOADER_REFERENCE_SOURCE,
      'return { orders: responseOrders, errors };',
      'return { orders: errors.length ? responseOrders.map((order) => ({ ...order, customer: null })) : responseOrders, errors: [] };',
    ),
  },
  {
    name: 'subscription events reuse the prior context',
    source:
      'const eventContexts = new Map<string, RequestContext>();\n' +
      loaderFaultySource(
        GRAPHQL_LOADER_REFERENCE_SOURCE,
        'return createRequestContext(viewerId, backend);',
        `let context = eventContexts.get(viewerId);
  if (!context) { context = createRequestContext(viewerId, backend); eventContexts.set(viewerId, context); }
  return context;`,
      ),
  },
] as const;

const LOADER_TEST = `import { expect, test } from 'bun:test';
import { createRequestContext, executeOrdersQuery, type Backend } from '../src/orders';

test('query resolves customer objects', async () => {
  const backend: Backend = {
    calls: [],
    async batchGet(viewerId, ids) {
      this.calls.push({ viewerId, ids });
      return ids.map((id) => ({ id, label: viewerId + ':' + id }));
    },
  };
  const result = await executeOrdersQuery(createRequestContext('alice', backend), [{ id: 'o1', customerId: 'c1' }]);
  expect(result.orders[0]?.customer?.label).toBe('alice:c1');
});
`;

const LOADER_RUNTIME_CONTRACT = `# GraphQL request/batching contract

- Customer authorization is viewer-specific; the same customer id can resolve to different visible data for different viewers.
- Batch duplicate customer ids once per GraphQL request. One request with three orders for customer c1 should make one backend batch containing c1 once.
- Cache lifetime is exactly one GraphQL request context. Never share cached values/errors across authenticated requests.
- Backend batch results align with requested ids and may contain per-key Error values. A per-key error becomes a null customer plus a GraphQL-style partial error; other order/customer fields remain available.
- Each subscription event gets a fresh loader/cache context. Do not reuse the handshake/request cache across later events.
- Do not disable batching merely to solve isolation.
`;

const loaderMaterializer: SkillEvalFixtureMaterializer = {
  id: 'graphql-engineering/n-plus-one-loader-scope@2',
  matches: (scenario) => scenario.id === LOADER_SCOPE,
  materialize: (destination) => {
    writeFixtureFile(destination, 'package.json', packageJson('kory-eval-graphql-loader'));
    writeFixtureFile(destination, 'src/orders.ts', LOADER_SOURCE);
    writeFixtureFile(destination, 'tests/orders.test.ts', LOADER_TEST);
    writeFixtureFile(destination, 'graphql-runtime-contract.md', LOADER_RUNTIME_CONTRACT);
    writeFixtureFile(
      destination,
      'README.md',
      `# GraphQL DataLoader scope fixture

Repair \`src/orders.ts\` to batch/deduplicate per request while keeping authorization-aware cache lifetime. Expand behavioral tests for duplicate ids, concurrent and sequential authenticated requests, per-key errors and their cache lifetime, repeated requests by the same viewer, and subscription events. Tests must pass the repaired implementation and a reference implementation of the public API, and independently reject faulty implementations that disable batching, share cached values or in-flight loads across requests, erase partial errors, or reuse subscription-event contexts. Preserve \`graphql-runtime-contract.md\` exactly.
`,
    );
  },
};

const loaderScorer: SkillEvalDeterministicScorer = {
  id: 'graphql-engineering/n-plus-one-loader-scope-scorer@3',
  scenarioIds: [LOADER_SCOPE],
  score: ({ workingDirectory }) => {
    if (
      !fixtureTextEquals(workingDirectory, 'graphql-runtime-contract.md', LOADER_RUNTIME_CONTRACT)
    ) {
      return {
        passed: false,
        quality: 0,
        verification: 0,
        integrityFailure: true,
        evidence: ['GraphQL request/batching contract was modified or removed.'],
      };
    }
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import { expect, test } from 'bun:test';
import { createRequestContext, createSubscriptionEventContext, executeOrdersQuery, type Backend, type Customer } from '../src/orders';

function backend(): Backend {
  return {
    calls: [],
    async batchGet(viewerId, ids) {
      this.calls.push({ viewerId, ids: [...ids] });
      return ids.map((id) => ({ id, label: viewerId + ':' + id }));
    },
  };
}

test('hidden: duplicate keys batch once in one request', async () => {
  const b = backend();
  const ctx = createRequestContext('alice', b);
  const result = await executeOrdersQuery(ctx, [
    { id: 'o1', customerId: 'batch-c1' },
    { id: 'o2', customerId: 'batch-c1' },
    { id: 'o3', customerId: 'batch-c2' },
  ]);
  expect(b.calls).toEqual([{ viewerId: 'alice', ids: ['batch-c1', 'batch-c2'] }]);
  expect(result.orders).toEqual([
    { id: 'o1', customer: { id: 'batch-c1', label: 'alice:batch-c1' } },
    { id: 'o2', customer: { id: 'batch-c1', label: 'alice:batch-c1' } },
    { id: 'o3', customer: { id: 'batch-c2', label: 'alice:batch-c2' } },
  ]);
  expect(result.errors).toEqual([]);
});

test('hidden: a context caches successful keys but a fresh request by the same viewer refetches', async () => {
  let revision = 0;
  const b: Backend = {
    calls: [],
    async batchGet(viewerId, ids) {
      this.calls.push({ viewerId, ids: [...ids] });
      revision++;
      return ids.map((id) => ({ id, label: viewerId + ':' + id + ':' + revision }));
    },
  };
  const firstContext = createRequestContext('alice', b);
  const first = await executeOrdersQuery(firstContext, [{ id: 'a1', customerId: 'scope-key' }]);
  const cached = await executeOrdersQuery(firstContext, [{ id: 'a2', customerId: 'scope-key' }]);
  const fresh = await executeOrdersQuery(createRequestContext('alice', b), [{ id: 'a3', customerId: 'scope-key' }]);
  expect(first.orders[0]?.customer?.label).toBe('alice:scope-key:1');
  expect(cached.orders[0]?.customer?.label).toBe('alice:scope-key:1');
  expect(fresh.orders[0]?.customer?.label).toBe('alice:scope-key:2');
  expect(b.calls).toEqual([
    { viewerId: 'alice', ids: ['scope-key'] },
    { viewerId: 'alice', ids: ['scope-key'] },
  ]);
});

test('hidden: per-key errors remain partial and cannot poison another viewer or request', async () => {
  let aliceAttempts = 0;
  const b: Backend = {
    calls: [],
    async batchGet(viewerId, ids) {
      this.calls.push({ viewerId, ids: [...ids] });
      return ids.map((id) => {
        if (id === 'flaky' && viewerId === 'alice' && ++aliceAttempts === 1)
          return new Error('alice:customer unavailable');
        return { id, label: viewerId + ':' + id };
      });
    },
  };
  const aliceContext = createRequestContext('alice', b);
  const first = await executeOrdersQuery(aliceContext, [
    { id: 'good', customerId: 'good-key' },
    { id: 'bad', customerId: 'flaky' },
    { id: 'good2', customerId: 'other-key' },
  ]);
  expect(first.orders.map((order) => order.customer?.label ?? null)).toEqual([
    'alice:good-key', null, 'alice:other-key',
  ]);
  expect(first.errors).toEqual(['alice:customer unavailable']);
  const repeated = await executeOrdersQuery(aliceContext, [{ id: 'repeat', customerId: 'flaky' }]);
  expect(repeated.orders[0]?.customer).toBeNull();
  expect(repeated.errors).toEqual(['alice:customer unavailable']);
  const bob = await executeOrdersQuery(createRequestContext('bob', b), [{ id: 'bob', customerId: 'flaky' }]);
  const aliceFresh = await executeOrdersQuery(createRequestContext('alice', b), [{ id: 'again', customerId: 'flaky' }]);
  expect(bob.orders[0]?.customer?.label).toBe('bob:flaky');
  expect(bob.errors).toEqual([]);
  expect(aliceFresh.orders[0]?.customer?.label).toBe('alice:flaky');
  expect(aliceFresh.errors).toEqual([]);
  expect(b.calls.map((call) => call.viewerId)).toEqual(['alice', 'bob', 'alice']);
});

test('hidden: subscription events cannot inherit the handshake or a previous event cache', async () => {
  let revision = 0;
  const b: Backend = {
    calls: [],
    async batchGet(viewerId, ids) {
      this.calls.push({ viewerId, ids: [...ids] });
      return ids.map((id) => ({ id, label: viewerId + ':' + id + ':' + ++revision }));
    },
  };
  const handshake = await executeOrdersQuery(createRequestContext('alice', b), [{ id: 'h', customerId: 'event-key' }]);
  const first = await executeOrdersQuery(createSubscriptionEventContext('alice', b), [{ id: 'e1', customerId: 'event-key' }]);
  const second = await executeOrdersQuery(createSubscriptionEventContext('alice', b), [{ id: 'e2', customerId: 'event-key' }]);
  expect([handshake, first, second].map((item) => item.orders[0]?.customer?.label)).toEqual([
    'alice:event-key:1', 'alice:event-key:2', 'alice:event-key:3',
  ]);
  expect(b.calls).toHaveLength(3);
});

test('hidden: concurrent users with overlapping keys remain isolated across reversed batch completion', async () => {
  const pending: Array<{ viewerId: string; ids: string[]; resolve: (values: Array<Customer | Error | null>) => void }> = [];
  let bothStarted = () => {};
  const ready = new Promise<void>((resolve) => { bothStarted = resolve; });
  const b: Backend = {
    calls: [],
    batchGet(viewerId, ids) {
      this.calls.push({ viewerId, ids: [...ids] });
      return new Promise((resolve) => {
        pending.push({ viewerId, ids: [...ids], resolve });
        if (pending.length === 2) bothStarted();
        // A defective N+1 implementation can issue more batches after the
        // first two settle; release those so its failure is prompt and specific.
        if (pending.length > 2) queueMicrotask(() => resolve(ids.map((id) =>
          viewerId === 'alice' && id === 'race-error'
            ? new Error('alice:race-error') : { id, label: viewerId + ':' + id },
        )));
      });
    },
  };
  const alicePromise = executeOrdersQuery(createRequestContext('alice', b), [
    { id: 'a1', customerId: 'race-shared' }, { id: 'a2', customerId: 'race-error' },
  ]);
  const bobPromise = executeOrdersQuery(createRequestContext('bob', b), [
    { id: 'b1', customerId: 'race-shared' }, { id: 'b2', customerId: 'race-error' },
  ]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      ready,
      new Promise<void>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Both authorized batches must start independently')), 1_000);
      }),
    ]);
    expect(b.calls).toHaveLength(2);
    expect(new Set(b.calls.map((call) => call.viewerId))).toEqual(new Set(['alice', 'bob']));
    const bob = pending.find((item) => item.viewerId === 'bob')!;
    bob.resolve(bob.ids.map((id) => ({ id, label: 'bob:' + id })));
    const alice = pending.find((item) => item.viewerId === 'alice')!;
    alice.resolve(alice.ids.map((id) => id === 'race-error'
      ? new Error('alice:race-error') : { id, label: 'alice:' + id }));
    const [aliceResult, bobResult] = await Promise.all([alicePromise, bobPromise]);
    expect(aliceResult.orders.map((order) => order.customer?.label ?? null)).toEqual(['alice:race-shared', null]);
    expect(aliceResult.errors).toEqual(['alice:race-error']);
    expect(bobResult.orders.map((order) => order.customer?.label)).toEqual(['bob:race-shared', 'bob:race-error']);
    expect(bobResult.errors).toEqual([]);
  } finally {
    if (timer) clearTimeout(timer);
    for (const request of pending) request.resolve(request.ids.map((id) => ({ id, label: request.viewerId + ':' + id })));
  }
});

test('hidden: simultaneous fields in the same context reuse pending keys', async () => {
  const releases: Array<(values: Array<Customer | Error | null>) => void> = [];
  let started = () => {};
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const b: Backend = {
    calls: [],
    batchGet(viewerId, ids) {
      this.calls.push({ viewerId, ids: [...ids] });
      return new Promise((resolve) => { releases.push(resolve); started(); });
    },
  };
  const ctx = createRequestContext('alice', b);
  const first = executeOrdersQuery(ctx, [{ id: 'p1', customerId: 'pending-key' }]);
  const second = executeOrdersQuery(ctx, [{ id: 'p2', customerId: 'pending-key' }]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      ready,
      new Promise<void>((_, reject) => { timer = setTimeout(() => reject(new Error('Pending batch never started')), 1_000); }),
    ]);
    expect(b.calls).toEqual([{ viewerId: 'alice', ids: ['pending-key'] }]);
  } finally {
    if (timer) clearTimeout(timer);
    for (const resolve of releases) resolve([{ id: 'pending-key', label: 'alice:pending-key' }]);
  }
  const [a, bResult] = await Promise.all([first, second]);
  expect(a.orders[0]?.customer?.label).toBe('alice:pending-key');
  expect(bResult.orders[0]?.customer?.label).toBe('alice:pending-key');
});
`,
    );
    const candidateSource = readFixtureText(workingDirectory, 'src/orders.ts');
    const candidate = runCandidateBunTests(workingDirectory);
    let referencePassed = false;
    let referenceEvidence = 'Skipped: candidate tests did not pass the submitted repair.';
    const controls: Array<{ name: string; rejected: boolean; evidence: string }> = [];
    if (candidate.completed && candidate.passed) {
      try {
        writeFixtureFile(workingDirectory, 'src/orders.ts', GRAPHQL_LOADER_REFERENCE_SOURCE);
        const reference = runCandidateBunTests(workingDirectory);
        referencePassed = reference.completed && reference.passed;
        referenceEvidence = reference.evidence;
        if (referencePassed) {
          for (const control of LOADER_NEGATIVE_CONTROLS) {
            writeFixtureFile(workingDirectory, 'src/orders.ts', control.source);
            const result = runCandidateBunTests(workingDirectory);
            controls.push({
              name: control.name,
              rejected: result.completed && !result.passed,
              evidence: result.evidence,
            });
          }
        }
      } finally {
        writeFixtureFile(workingDirectory, 'src/orders.ts', candidateSource);
      }
    }
    const coverage =
      candidate.passed &&
      referencePassed &&
      controls.length === LOADER_NEGATIVE_CONTROLS.length &&
      controls.every((control) => control.rejected);
    const passed = hidden.passed && coverage;
    return {
      passed,
      quality: passed ? 1 : hidden.passed ? 0.75 : 0,
      verification: hidden.passed ? 1 : 0,
      integrityFailure: false,
      evidence: [
        `hidden batching/request isolation/race/partial errors: ${hidden.passed ? 'pass' : 'fail'}`,
        `candidate tests pass repair: ${candidate.passed ? 'yes' : 'no'}`,
        `candidate tests pass reference implementation: ${referencePassed ? 'yes' : 'no'}`,
        ...LOADER_NEGATIVE_CONTROLS.map((control) => {
          const result = controls.find((item) => item.name === control.name);
          return `candidate tests reject ${control.name}: ${result?.rejected ? 'yes' : 'no'}`;
        }),
        candidate.evidence,
        referenceEvidence,
        ...controls.filter((control) => !control.rejected).map((control) => control.evidence),
        hidden.evidence,
      ],
    };
  },
};

export const GRAPHQL_ENGINEERING_SKILL_EVAL_MATERIALIZERS: readonly SkillEvalFixtureMaterializer[] =
  [schemaMaterializer, loaderMaterializer];

export const GRAPHQL_ENGINEERING_SKILL_EVAL_SCORERS: readonly SkillEvalDeterministicScorer[] = [
  schemaScorer,
  loaderScorer,
];
