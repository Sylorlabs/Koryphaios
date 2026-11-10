import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  POSTGRES_RUNTIME_BLOCKER,
  postgresRuntimeReadiness,
  runPostgresConstraintRuntime,
  runPostgresQueueRuntime,
} from '../skill-eval-postgres-runtime';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'kory-postgres-runtime-'));
  roots.push(root);
  return root;
}

function runtimeAvailable(): boolean {
  const blockers = postgresRuntimeReadiness();
  if (blockers.length === 0) return true;
  expect(blockers).toEqual([POSTGRES_RUNTIME_BLOCKER]);
  return false;
}

describe('PostgreSQL 17.5 skill-eval runtime', () => {
  test('queue harness observes the full operating and verification contract', () => {
    if (!runtimeAvailable()) return;
    const root = fixtureRoot();
    writeFileSync(
      join(root, 'claim.sql'),
      `WITH candidate AS (
  SELECT id
  FROM jobs
  WHERE (status = 'queued' AND available_at <= now())
     OR (status = 'running' AND lease_expires_at <= now())
  ORDER BY priority DESC, id
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
UPDATE jobs AS j
SET status = 'running',
    claimed_at = clock_timestamp(),
    lease_expires_at = clock_timestamp() + $2,
    attempt_count = j.attempt_count + 1,
    claimed_by = $1::uuid,
    claim_token = gen_random_uuid()
FROM candidate
WHERE j.id = candidate.id
RETURNING j.id;
`,
    );

    const result = runPostgresQueueRuntime(root);
    expect(result.passed, result.evidence).toBe(true);
    for (const marker of [
      'PostgreSQL runtime: 17.5',
      '20-worker claim uniqueness: pass',
      'queue constraint violations',
      'observed schema|schema-owner|table-owner:',
      'observed transaction isolation: read committed',
      'observed installed extensions:',
      'observed workload:',
      'measured SKIP LOCKED bypass duration:',
      'measured autocommit claim transaction duration:',
      'production-like ANALYZE statistics:',
      'representative EXPLAIN ANALYZE BUFFERS: pass',
    ]) {
      expect(result.evidence).toContain(marker);
    }
  }, 90_000);

  test('constraint harness observes locks, retry, statistics, and final integrity', () => {
    if (!runtimeAvailable()) return;
    const root = fixtureRoot();
    writeFileSync(
      join(root, 'migration.sql'),
      `BEGIN;
SET LOCAL lock_timeout = '800ms';
DELETE FROM child AS c
WHERE NOT EXISTS (SELECT 1 FROM parent AS p WHERE p.id = c.parent_id);
ALTER TABLE child
  ADD CONSTRAINT child_parent_fk
  FOREIGN KEY (parent_id) REFERENCES parent(id)
  NOT VALID;
COMMIT;

BEGIN;
SET LOCAL lock_timeout = '800ms';
ALTER TABLE child VALIDATE CONSTRAINT child_parent_fk;
COMMIT;
`,
    );

    const result = runPostgresConstraintRuntime(root);
    expect(result.passed, result.evidence).toBe(true);
    for (const marker of [
      'PostgreSQL runtime: 17.5',
      'validated FK and invalid-write rejection: pass',
      'observed schema|schema-owner|table-owners:',
      'observed transaction isolation: read committed',
      'observed installed extensions:',
      'observed workload:',
      'observed waiting lock modes:',
      'rollback/forward-recovery retry: pass',
      'production-like ANALYZE statistics:',
      'representative EXPLAIN ANALYZE BUFFERS: pass',
    ]) {
      expect(result.evidence).toContain(marker);
    }
  }, 90_000);
});
