import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GRAPHQL_ENGINEERING_SKILL_EVAL_MATERIALIZERS,
  GRAPHQL_ENGINEERING_SKILL_EVAL_SCORERS,
} from '../../eval/skills/skill-eval-graphql-engineering-fixtures';
import { readFixtureText, writeFixtureFile } from '../../eval/skills/skill-eval-fixture-helpers';

const roots: string[] = [];

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'kory-graphql-regression-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const repairedSchema = `type Query {
  user(id: ID!): User
}
type Avatar {
  url: String!
  width: Int!
  height: Int!
}
type User {
  id: ID!
  displayName: String!
  avatarUrl: String @deprecated(reason: "Use avatar.url")
  avatar: Avatar
}
`;

const repairedResolvers = `export interface StoredUser {
  id: string;
  displayName: string;
  avatar?: { url: string; width: number; height: number } | null;
}

export function resolveAvatarUrl(user: StoredUser): string | null {
  return user.avatar?.url ?? null;
}

export function resolveAvatar(user: StoredUser): StoredUser['avatar'] {
  return user.avatar ?? null;
}

export function executeAvatarQuery(
  user: StoredUser,
  options: { avatarResolverFails?: boolean } = {},
): { data: { user: { id: string; avatar: StoredUser['avatar'] | null } | null }; errors: string[] } {
  if (options.avatarResolverFails) {
    return { data: { user: { id: user.id, avatar: null } }, errors: ['avatar backend failed'] };
  }
  return { data: { user: { id: user.id, avatar: resolveAvatar(user) } }, errors: [] };
}
`;

const meaningfulTests = `import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { executeAvatarQuery, resolveAvatarUrl } from '../src/resolvers';

test('the supplied legacy operation remains part of the compatibility check', () => {
  const legacy = readFileSync(new URL('../persisted-queries/legacy-mobile.graphql', import.meta.url), 'utf8');
  expect(legacy).toContain('avatarUrl');
  expect(legacy).toContain('displayName');
});

test('schema preserves the deprecated nullable legacy field and optional avatar object', () => {
  const schema = readFileSync(new URL('../schema.graphql', import.meta.url), 'utf8');
  expect(schema).toMatch(/avatarUrl\\s*:\\s*String\\s+@deprecated/);
  expect(schema).toMatch(/avatar\\s*:\\s*Avatar\\b/);
  expect(schema).toMatch(/type Avatar\\s*\\{/);
});

test('legacy nullable field and optional resolver error retain the User', () => {
  const absent = { id: 'u2', displayName: 'B', avatar: null };
  expect(resolveAvatarUrl(absent)).toBeNull();
  expect(executeAvatarQuery(absent, { avatarResolverFails: true })).toEqual({
    data: { user: { id: 'u2', avatar: null } },
    errors: ['avatar backend failed'],
  });
});
`;

const withoutLegacyOperationTests = `import { expect, test } from 'bun:test';
import { executeAvatarQuery, resolveAvatarUrl } from '../src/resolvers';

test('schema and resolver behavior are covered without the supplied legacy operation', () => {
  const absent = { id: 'u2', displayName: 'B', avatar: null };
  expect(resolveAvatarUrl(absent)).toBeNull();
  expect(executeAvatarQuery(absent, { avatarResolverFails: true })).toEqual({
    data: { user: { id: 'u2', avatar: null } },
    errors: ['avatar backend failed'],
  });
});
`;

const resolverOnlyTests = `import { expect, test } from 'bun:test';
import { executeAvatarQuery, resolveAvatarUrl } from '../src/resolvers';
test('legacy nullable field and optional resolver error retain the User', () => {
  const absent = { id: 'u2', displayName: 'B', avatar: null };
  expect(resolveAvatarUrl(absent)).toBeNull();
  expect(executeAvatarQuery(absent, { avatarResolverFails: true })).toEqual({
    data: { user: { id: 'u2', avatar: null } },
    errors: ['avatar backend failed'],
  });
});
`;

async function scorePreparedFixture(tests: string) {
  const root = workspace();
  const materializer = GRAPHQL_ENGINEERING_SKILL_EVAL_MATERIALIZERS.find(
    (item) => item.id === 'graphql-engineering/nullable-field-evolution@2',
  );
  const scorer = GRAPHQL_ENGINEERING_SKILL_EVAL_SCORERS.find(
    (item) => item.id === 'graphql-engineering/nullable-field-evolution-scorer@2',
  );
  expect(materializer).toBeDefined();
  expect(scorer).toBeDefined();
  await materializer!.materialize(root, {
    id: 'graphql-engineering-full-task-1-individual',
  } as never);
  writeFixtureFile(root, 'schema.graphql', repairedSchema);
  writeFixtureFile(root, 'src/resolvers.ts', repairedResolvers);
  writeFixtureFile(root, 'tests/schema.test.ts', tests);
  const result = await scorer!.score({ workingDirectory: root } as never);
  expect(readFixtureText(root, 'schema.graphql')).toBe(repairedSchema);
  expect(readFixtureText(root, 'src/resolvers.ts')).toBe(repairedResolvers);
  return result;
}

describe('GraphQL schema evolution regression proof', () => {
  test('accepts fixed schema and resolvers with tests that reject each original bug', async () => {
    const result = await scorePreparedFixture(meaningfulTests);
    expect(result.passed, result.evidence.join('\n')).toBe(true);
    expect(result.evidence).toContain('candidate tests reject broken schema: yes');
    expect(result.evidence).toContain('candidate tests reject broken resolver: yes');
  });

  test('rejects a repaired implementation whose tests omit schema regression protection', async () => {
    const result = await scorePreparedFixture(resolverOnlyTests);
    expect(result.passed).toBe(false);
    expect(result.evidence).toContain('candidate tests reject broken schema: no');
    expect(result.evidence).toContain('candidate tests reject broken resolver: yes');
  });

  test('rejects keyword-only coverage with no executed assertions', async () => {
    const result = await scorePreparedFixture(`import { expect, test } from 'bun:test';
test('legacy avatarUrl absent null error partial deprecation schema', () => {
  expect(true).toBe(true);
});\n`);
    expect(result.passed).toBe(false);
    expect(result.evidence).toContain('candidate tests reject broken schema: no');
    expect(result.evidence).toContain('candidate tests reject broken resolver: no');
  });

  test('requires the supplied persisted legacy operation in candidate verification', async () => {
    const result = await scorePreparedFixture(withoutLegacyOperationTests);
    expect(result.passed).toBe(false);
    expect(result.evidence).toContain('candidate tests exercise persisted legacy operation: no');
  });

  test('rejects tampering with the evaluator-owned mobile query and migration contract', async () => {
    for (const changedFile of [
      'persisted-queries/legacy-mobile.graphql',
      'migration-contract.md',
    ]) {
      const root = workspace();
      const materializer = GRAPHQL_ENGINEERING_SKILL_EVAL_MATERIALIZERS.find(
        (item) => item.id === 'graphql-engineering/nullable-field-evolution@2',
      )!;
      const scorer = GRAPHQL_ENGINEERING_SKILL_EVAL_SCORERS.find(
        (item) => item.id === 'graphql-engineering/nullable-field-evolution-scorer@2',
      )!;
      await materializer.materialize(root, {
        id: 'graphql-engineering-full-task-1-individual',
      } as never);
      writeFixtureFile(root, 'schema.graphql', repairedSchema);
      writeFixtureFile(root, 'src/resolvers.ts', repairedResolvers);
      writeFixtureFile(root, 'tests/schema.test.ts', meaningfulTests);
      writeFixtureFile(root, changedFile, 'silently weakened contract\n');
      const result = await scorer.score({ workingDirectory: root } as never);
      expect(result).toMatchObject({ passed: false, integrityFailure: true });
      expect(readFixtureText(root, changedFile)).toBe('silently weakened contract\n');
    }
  });
});
