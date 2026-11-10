import { describe, expect, test } from 'bun:test';
import {
  VECTOR_SEARCH_RUNTIME_BLOCKER,
  VECTOR_SEARCH_RUNTIME_IMAGE,
  VECTOR_SEARCH_RUNTIME_VERSION,
  runVectorRecallMigrationRuntime,
  runVectorShardedRecoveryRuntime,
  vectorSearchRuntimeReadiness,
} from '../skill-eval-vector-search-runtime';

function runtimeAvailable(): boolean {
  const blockers = vectorSearchRuntimeReadiness();
  if (blockers.length === 0) return true;
  expect(blockers).toEqual([VECTOR_SEARCH_RUNTIME_BLOCKER]);
  return false;
}

describe('Elasticsearch vector-search skill-eval runtime', () => {
  test('runtime is pinned and unavailable engines fail closed', () => {
    expect(VECTOR_SEARCH_RUNTIME_IMAGE).toBe(
      'docker.elastic.co/elasticsearch/elasticsearch:8.19.4',
    );
    expect(VECTOR_SEARCH_RUNTIME_VERSION).toBe('8.19.4');
    const blockers = vectorSearchRuntimeReadiness();
    expect(blockers.length === 0 || blockers[0] === VECTOR_SEARCH_RUNTIME_BLOCKER).toBe(true);
  });

  test('scenario 1 executes exact-reference recall, filtering, freshness, migration, rollback, and resource evidence', () => {
    if (!runtimeAvailable()) return;
    const result = runVectorRecallMigrationRuntime();
    expect(result.passed, result.evidence).toBe(true);
    for (const marker of [
      'Elasticsearch vector runtime: 8.19.4',
      'scenario-1 vector contract:',
      'scenario-1 exact-reference ANN recall:',
      'scenario-1 filtering/tenant isolation:',
      'scenario-1 freshness/update/delete:',
      'scenario-1 shadow migration:',
      'scenario-1 alias cutover -> rollback -> recutover:',
      'scenario-1 latency evidence:',
      'scenario-1 build/storage/memory evidence:',
    ]) {
      expect(result.evidence).toContain(marker);
    }
  }, 180_000);

  test('scenario 2 executes sharded global top-k, freshness, failure recovery, latency, and capacity evidence', () => {
    if (!runtimeAvailable()) return;
    const result = runVectorShardedRecoveryRuntime();
    expect(result.passed, result.evidence).toBe(true);
    for (const marker of [
      'Elasticsearch vector runtime: 8.19.4',
      'scenario-2 sharded global top-k:',
      'scenario-2 authorization/filter boundary:',
      'scenario-2 freshness/update/delete:',
      'scenario-2 failure/recovery:',
      'scenario-2 latency evidence:',
      'scenario-2 capacity/storage/memory evidence:',
    ]) {
      expect(result.evidence).toContain(marker);
    }
  }, 180_000);
});
