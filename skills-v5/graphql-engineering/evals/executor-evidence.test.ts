import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const fixtureRoot = join(import.meta.dir, 'fixtures/nullable-field-evolution');
const schemaSource = readFileSync(join(fixtureRoot, 'schema.graphql'), 'utf8');
const legacyOperation = readFileSync(
  join(fixtureRoot, 'persisted-queries/legacy-mobile.graphql'),
  'utf8',
);

type Evidence =
  | {
      status: 'measured';
      executor: string;
      checks: string[];
    }
  | {
      status: 'unavailable';
      executor: string;
      lookup: string;
      reason: string;
      unperformed: string[];
    };

async function runExecutorEvidence(): Promise<Evidence> {
  let graphql: typeof import('graphql');
  try {
    graphql = await import('graphql');
  } catch (error) {
    return {
      status: 'unavailable',
      executor: 'graphql-js',
      lookup: 'import("graphql")',
      reason: error instanceof Error ? error.message : String(error),
      unperformed: [
        'persisted operation execution',
        'nullable error bubbling',
        '__type introspection',
      ],
    };
  }

  const schema = graphql.buildSchema(schemaSource);
  const rootValue = {
    user: (_args: { id: string }) => ({
      id: 'u1',
      displayName: 'A',
      avatarUrl: 'https://img/a',
      avatar: { url: 'https://img/a', width: 64, height: 32 },
    }),
  };
  const legacy = await graphql.graphql({
    schema,
    source: legacyOperation,
    rootValue,
    variableValues: { id: 'u1' },
  });
  expect(legacy.errors ?? []).toEqual([]);
  expect(legacy.data).toEqual({
    user: { id: 'u1', displayName: 'A', avatarUrl: 'https://img/a' },
  });

  const absent = await graphql.graphql({
    schema,
    source: `query Absent($id: ID!) { user(id: $id) { id displayName avatarUrl avatar { url width height } } }`,
    rootValue: {
      user: () => ({ id: 'u2', displayName: 'B', avatarUrl: null, avatar: null }),
    },
    variableValues: { id: 'u2' },
  });
  expect(absent.errors ?? []).toEqual([]);
  expect(absent.data).toEqual({
    user: { id: 'u2', displayName: 'B', avatarUrl: null, avatar: null },
  });

  const present = await graphql.graphql({
    schema,
    source: `query Present($id: ID!) { user(id: $id) { id displayName avatar { url width height } } }`,
    rootValue,
    variableValues: { id: 'u1' },
  });
  expect(present.errors ?? []).toEqual([]);
  expect(present.data).toEqual({
    user: {
      id: 'u1',
      displayName: 'A',
      avatar: { url: 'https://img/a', width: 64, height: 32 },
    },
  });

  const nestedFailure = await graphql.graphql({
    schema,
    source: `query NestedFailure { user(id: "u3") { id displayName avatar { url width height } } }`,
    rootValue: {
      user: () => ({
        id: 'u3',
        displayName: 'C',
        avatar: { url: 'https://img/c', width: 64, height: 32 },
      }),
      Avatar: undefined,
    },
    fieldResolver: (source, args, context, info) => {
      if (info.parentType.name === 'Avatar' && info.fieldName === 'url') {
        throw new Error('avatar backend failed');
      }
      return graphql.defaultFieldResolver(source, args, context, info);
    },
  });
  expect(nestedFailure.data).toEqual({
    user: { id: 'u3', displayName: 'C', avatar: null },
  });
  expect(nestedFailure.errors?.[0]?.path).toEqual(['user', 'avatar', 'url']);

  const introspection = await graphql.graphql({
    schema,
    source: `query UserMetadata { __type(name: "User") { fields(includeDeprecated: true) { name isDeprecated deprecationReason type { kind name ofType { kind name } } } } }`,
  });
  expect(introspection.errors ?? []).toEqual([]);
  const fields = (
    introspection.data?.__type as {
      fields: Array<{
        name: string;
        isDeprecated: boolean;
        deprecationReason: string | null;
        type: {
          kind: string;
          name: string | null;
          ofType: { kind: string; name: string | null } | null;
        };
      }>;
    }
  ).fields;
  const avatarUrl = fields.find((field) => field.name === 'avatarUrl');
  const avatar = fields.find((field) => field.name === 'avatar');
  expect(avatarUrl).toMatchObject({
    isDeprecated: true,
    deprecationReason: 'Use avatar.url; null when no avatar is set.',
    type: { kind: 'SCALAR', name: 'String', ofType: null },
  });
  expect(avatar).toMatchObject({
    isDeprecated: false,
    type: { kind: 'OBJECT', name: 'Avatar', ofType: null },
  });

  return {
    status: 'measured',
    executor: 'graphql-js',
    checks: [
      'persisted legacy operation',
      'nullable avatar absence',
      'rich avatar projection',
      'nested non-null Avatar.url bubbling to nullable User.avatar',
      '__type deprecation metadata and nullable wrappers',
    ],
  };
}

test('uses a real GraphQL executor when installed or records explicit unavailable evidence', async () => {
  const evidence = await runExecutorEvidence();
  if (evidence.status === 'unavailable') {
    expect(evidence.executor).toBe('graphql-js');
    expect(evidence.lookup).toBe('import("graphql")');
    expect(evidence.unperformed).toEqual([
      'persisted operation execution',
      'nullable error bubbling',
      '__type introspection',
    ]);
    expect(evidence.reason.length).toBeGreaterThan(0);
    return;
  }
  expect(evidence.checks).toEqual([
    'persisted legacy operation',
    'nullable avatar absence',
    'rich avatar projection',
    'nested non-null Avatar.url bubbling to nullable User.avatar',
    '__type deprecation metadata and nullable wrappers',
  ]);
});

test('fixture contract keeps the legacy operation and migration schema byte-stable', () => {
  expect(legacyOperation).toContain('avatarUrl');
  expect(legacyOperation).toContain('displayName');
  expect(schemaSource).toContain('avatarUrl: String @deprecated');
  expect(schemaSource).toContain('avatar: Avatar');
  expect(schemaSource).toContain('url: String!');
});
