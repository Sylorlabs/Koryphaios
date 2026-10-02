import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  SkillEvalDeterministicScorer,
  SkillEvalFixtureMaterializer,
} from './skill-eval-execution';
import {
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

const schemaMaterializer: SkillEvalFixtureMaterializer = {
  id: 'graphql-engineering/nullable-field-evolution@1',
  matches: (scenario) => scenario.id === SCHEMA_EVOLUTION,
  materialize: (destination) => {
    writeFixtureFile(destination, 'package.json', packageJson('kory-eval-graphql-schema'));
    writeFixtureFile(destination, 'schema.graphql', SCHEMA_INITIAL);
    writeFixtureFile(destination, 'src/resolvers.ts', SCHEMA_RESOLVERS);
    writeFixtureFile(destination, 'tests/schema.test.ts', SCHEMA_PUBLIC_TEST);
    writeFixtureFile(
      destination,
      'persisted-queries/legacy-mobile.graphql',
      `query LegacyUser($id: ID!) {
  user(id: $id) {
    id
    displayName
    avatarUrl
  }
}
`,
    );
    writeFixtureFile(
      destination,
      'migration-contract.md',
      `# GraphQL schema-evolution contract

- Existing mobile clients continue querying \`User.avatarUrl\` throughout the compatibility window.
- Some users legitimately have no avatar. The compatibility field therefore cannot remain non-null once absence is representable.
- Add richer optional \`User.avatar: Avatar\`; \`Avatar\` exposes \`url: String!\`, \`width: Int!\`, and \`height: Int!\`.
- Keep \`avatarUrl\` as a nullable \`String\` and deprecate it with a migration reason pointing callers to \`avatar.url\`.
- If the optional avatar resolver fails, GraphQL-style partial semantics retain the user object, set \`avatar\` to null, and surface an error. Do not null the whole User.
- Storage layout is out of scope. Preserve the persisted legacy query.
`,
    );
    writeFixtureFile(
      destination,
      'README.md',
      `# GraphQL nullable-field evolution fixture

Evolve \`schema.graphql\` and \`src/resolvers.ts\` under the migration contract. Expand tests for present/absent avatars, old persisted-query behavior, optional-field resolver failure, and schema deprecation/nullability evidence.
`,
    );
  },
};

const schemaScorer: SkillEvalDeterministicScorer = {
  id: 'graphql-engineering/nullable-field-evolution-scorer@1',
  scenarioIds: [SCHEMA_EVOLUTION],
  score: ({ workingDirectory }) => {
    const schema = readFileSync(join(workingDirectory, 'schema.graphql'), 'utf8');
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
    const tests = readFileSync(join(workingDirectory, 'tests/schema.test.ts'), 'utf8');
    const coverage =
      /legacy|avatarUrl/iu.test(tests) &&
      /absent|null/iu.test(tests) &&
      /error|partial/iu.test(tests) &&
      /deprecat|schema|introspect/iu.test(tests);
    const passed = schemaContract && hidden.passed && coverage;
    return {
      passed,
      quality: passed ? 1 : schemaContract && hidden.passed ? 0.75 : 0,
      verification: schemaContract && hidden.passed ? 1 : 0,
      integrityFailure: false,
      evidence: [
        `schema nullability/deprecation contract: ${schemaContract ? 'pass' : 'fail'}`,
        `hidden resolver compatibility/partial errors: ${hidden.passed ? 'pass' : 'fail'}`,
        `representative regression coverage: ${coverage ? 'present' : 'missing'}`,
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

const loaderMaterializer: SkillEvalFixtureMaterializer = {
  id: 'graphql-engineering/n-plus-one-loader-scope@1',
  matches: (scenario) => scenario.id === LOADER_SCOPE,
  materialize: (destination) => {
    writeFixtureFile(destination, 'package.json', packageJson('kory-eval-graphql-loader'));
    writeFixtureFile(destination, 'src/orders.ts', LOADER_SOURCE);
    writeFixtureFile(destination, 'tests/orders.test.ts', LOADER_TEST);
    writeFixtureFile(
      destination,
      'graphql-runtime-contract.md',
      `# GraphQL request/batching contract

- Customer authorization is viewer-specific; the same customer id can resolve to different visible data for different viewers.
- Batch duplicate customer ids once per GraphQL request. One request with three orders for customer c1 should make one backend batch containing c1 once.
- Cache lifetime is exactly one GraphQL request context. Never share cached values/errors across authenticated requests.
- Backend batch results align with requested ids and may contain per-key Error values. A per-key error becomes a null customer plus a GraphQL-style partial error; other order/customer fields remain available.
- Each subscription event gets a fresh loader/cache context. Do not reuse the handshake/request cache across later events.
- Do not disable batching merely to solve isolation.
`,
    );
    writeFixtureFile(
      destination,
      'README.md',
      `# GraphQL DataLoader scope fixture

Repair \`src/orders.ts\` to batch/deduplicate per request while keeping authorization-aware cache lifetime. Expand tests for query count, duplicate ids, per-key errors, simultaneous users, and subscription-event separation.
`,
    );
  },
};

const loaderScorer: SkillEvalDeterministicScorer = {
  id: 'graphql-engineering/n-plus-one-loader-scope-scorer@2',
  scenarioIds: [LOADER_SCOPE],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import { expect, test } from 'bun:test';
import { createRequestContext, createSubscriptionEventContext, executeOrdersQuery, type Backend } from '../src/orders';

function backend(): Backend {
  return {
    calls: [],
    async batchGet(viewerId, ids) {
      this.calls.push({ viewerId, ids: [...ids] });
      return ids.map((id) => id === 'err' ? new Error(viewerId + ':customer unavailable') : { id, label: viewerId + ':' + id });
    },
  };
}

test('hidden: duplicate keys batch once in one request', async () => {
  const b = backend();
  const ctx = createRequestContext('alice', b);
  const result = await executeOrdersQuery(ctx, [
    { id: 'o1', customerId: 'c1' },
    { id: 'o2', customerId: 'c1' },
    { id: 'o3', customerId: 'c2' },
  ]);
  expect(b.calls).toHaveLength(1);
  expect(new Set(b.calls[0]?.ids)).toEqual(new Set(['c1', 'c2']));
  expect(b.calls[0]?.ids).toHaveLength(2);
  expect(result.orders.map((x) => x.customer?.label)).toEqual(['alice:c1', 'alice:c1', 'alice:c2']);
});

test('hidden: overlapping ids never leak across authenticated requests', async () => {
  const b = backend();
  const alice = await executeOrdersQuery(createRequestContext('alice', b), [{ id: 'a', customerId: 'shared' }]);
  const bob = await executeOrdersQuery(createRequestContext('bob', b), [{ id: 'b', customerId: 'shared' }]);
  expect(alice.orders[0]?.customer?.label).toBe('alice:shared');
  expect(bob.orders[0]?.customer?.label).toBe('bob:shared');
  expect(b.calls.map((x) => x.viewerId)).toEqual(['alice', 'bob']);
});

test('hidden: per-key backend error remains partial', async () => {
  const b = backend();
  const result = await executeOrdersQuery(createRequestContext('alice', b), [
    { id: 'good', customerId: 'c1' },
    { id: 'bad', customerId: 'err' },
    { id: 'good2', customerId: 'c2' },
  ]);
  expect(result.orders[0]?.customer?.label).toBe('alice:c1');
  expect(result.orders[1]?.customer).toBeNull();
  expect(result.orders[2]?.customer?.label).toBe('alice:c2');
  expect(result.errors.length).toBe(1);
});

test('hidden: subscription events receive fresh cache lifecycle', async () => {
  const b = backend();
  await executeOrdersQuery(createSubscriptionEventContext('alice', b), [{ id: 'e1', customerId: 'c1' }]);
  await executeOrdersQuery(createSubscriptionEventContext('alice', b), [{ id: 'e2', customerId: 'c1' }]);
  expect(b.calls).toHaveLength(2);
});
`,
    );
    const candidateSource = readFixtureText(workingDirectory, 'src/orders.ts');
    let regressionEvidence = 'Candidate regression tests did not execute.';
    let coverage = false;
    try {
      writeFixtureFile(workingDirectory, 'src/orders.ts', LOADER_SOURCE);
      const regression = runCandidateBunTests(workingDirectory);
      coverage = regression.completed && !regression.passed;
      regressionEvidence = regression.evidence;
    } finally {
      writeFixtureFile(workingDirectory, 'src/orders.ts', candidateSource);
    }
    const passed = hidden.passed && coverage;
    return {
      passed,
      quality: passed ? 1 : hidden.passed ? 0.75 : 0,
      verification: hidden.passed ? 1 : 0,
      integrityFailure: false,
      evidence: [
        `hidden request-scope batching/isolation: ${hidden.passed ? 'pass' : 'fail'}`,
        `known-bad request loader rejected by candidate tests: ${coverage ? 'yes' : 'no'}`,
        regressionEvidence,
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
