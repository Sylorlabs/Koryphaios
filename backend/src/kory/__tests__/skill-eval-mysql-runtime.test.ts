import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MYSQL_RUNTIME_BLOCKER,
  MYSQL_RUNTIME_IMAGE,
  mysqlRuntimeReadiness,
  runMySqlDeadlockRuntime,
  runMySqlOnlineIndexRuntime,
} from '../../eval/skills/skill-eval-mysql-runtime';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'kory-mysql-runtime-'));
  roots.push(root);
  return root;
}

function runtimeAvailable(): boolean {
  const blockers = mysqlRuntimeReadiness();
  if (blockers.length === 0) return true;
  expect(blockers).toEqual([MYSQL_RUNTIME_BLOCKER]);
  return false;
}

describe('MySQL 8.4.6 skill-eval runtime', () => {
  test('readiness is pinned and fail closed when the local image is unavailable', () => {
    expect(MYSQL_RUNTIME_IMAGE).toBe('mysql:8.4.6');
    const blockers = mysqlRuntimeReadiness();
    expect(blockers.length === 0 || blockers[0] === MYSQL_RUNTIME_BLOCKER).toBe(true);
  });

  test('online-index harness observes MySQL online DDL and metadata-lock behavior', () => {
    if (!runtimeAvailable()) return;
    const root = fixtureRoot();
    writeFileSync(
      join(root, 'migration.sql'),
      `ALTER TABLE events
  ADD INDEX idx_events_tenant_created (tenant_id, created_at),
  ALGORITHM=INPLACE,
  LOCK=NONE;
`,
    );

    const result = runMySqlOnlineIndexRuntime(root);
    expect(result.passed, result.evidence).toBe(true);
    for (const marker of [
      'MySQL runtime: 8.4.6',
      'online DDL ALGORITHM=INPLACE LOCK=NONE execution: pass',
      'observed server settings:',
      'observed table engine: InnoDB',
      'observed row/selectivity distribution:',
      'pre-DDL EXPLAIN lacked target index: pass',
      'observed metadata locks during blocked DDL:',
      'bounded metadata-lock abort: pass',
      'abort recovery retry: pass',
      'concurrent writes during LOCK=NONE DDL: pass',
      'post-DDL EXPLAIN uses idx_events_tenant_created: pass',
      'observed write/storage cost:',
      'replication topology: standalone; observed replica channels=',
    ]) {
      expect(result.evidence).toContain(marker);
    }
  }, 240_000);

  test('deadlock harness observes InnoDB victim rollback, retry, idempotency, and canonical locking', () => {
    if (!runtimeAvailable()) return;
    const root = fixtureRoot();

    const result = runMySqlDeadlockRuntime(root);
    expect(result.passed, result.evidence).toBe(true);
    for (const marker of [
      'MySQL runtime: 8.4.6',
      'real InnoDB opposite-order deadlock: pass',
      'SHOW ENGINE INNODB STATUS latest deadlock evidence: present',
      'bounded deadlock retry: pass',
      'deadlock rollback + balance/ledger invariants: pass',
      'duplicate transfer-id exactly-once effect: pass',
      'canonical lock order trace: a,b',
      'opposite-direction canonical concurrency: pass',
      'observed table engines: accounts:InnoDB,ledger:InnoDB',
      'observed server settings:',
    ]) {
      expect(result.evidence).toContain(marker);
    }
  }, 180_000);
});
