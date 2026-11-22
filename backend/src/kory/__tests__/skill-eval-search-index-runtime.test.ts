import { describe, expect, test } from 'bun:test';
import {
  SEARCH_INDEX_RUNTIME_BLOCKER,
  SEARCH_INDEX_RUNTIME_IMAGE,
  SEARCH_INDEX_RUNTIME_VERSION,
  runSearchAnalyzerVersioningRuntime,
  runSearchTenantAuthorizationRuntime,
  searchIndexRuntimeReadiness,
} from '../../eval/skills/skill-eval-search-index-runtime';

function runtimeAvailable(): boolean {
  const blockers = searchIndexRuntimeReadiness();
  if (blockers.length === 0) return true;
  expect(blockers).toEqual([SEARCH_INDEX_RUNTIME_BLOCKER]);
  return false;
}

describe('Elasticsearch search-indexing skill-eval runtime', () => {
  test('runtime is pinned and unavailable engines fail closed', () => {
    expect(SEARCH_INDEX_RUNTIME_IMAGE).toBe('docker.elastic.co/elasticsearch/elasticsearch:8.19.4');
    expect(SEARCH_INDEX_RUNTIME_VERSION).toBe('8.19.4');
    const blockers = searchIndexRuntimeReadiness();
    expect(blockers.length === 0 || blockers[0] === SEARCH_INDEX_RUNTIME_BLOCKER).toBe(true);
    if (blockers.length > 0) {
      const result = runSearchAnalyzerVersioningRuntime();
      expect(result.passed).toBe(false);
      expect(result.evidence).toContain(SEARCH_INDEX_RUNTIME_IMAGE);
    }
  });

  test('scenario 1 executes analyzer versioning, reindex overlap, parity, cutover, rollback, and evidence', () => {
    if (!runtimeAvailable()) return;
    const result = runSearchAnalyzerVersioningRuntime();
    expect(result.passed, result.evidence).toBe(true);
    for (const marker of [
      'Elasticsearch runtime: 8.19.4',
      'scenario-1 versioned mapping boundary:',
      'scenario-1 analyzer inspection:',
      'scenario-1 baseline ambiguity reproduced on v1:',
      'scenario-1 asynchronous reindex + overlapping write journal: pass',
      'scenario-1 write replay create/update/delete: pass',
      'scenario-1 relevance goldens:',
      'scenario-1 document-count parity: pass',
      'scenario-1 alias cutover -> rollback -> recutover: pass',
      'scenario-1 query latency evidence:',
      'scenario-1 index evidence:',
    ]) {
      expect(result.evidence).toContain(marker);
    }
  }, 360_000);

  test('scenario 2 executes tenant authorization, cache identity, ranking, freshness, delete, load, and evidence', () => {
    if (!runtimeAvailable()) return;
    const result = runSearchTenantAuthorizationRuntime();
    expect(result.passed, result.evidence).toBe(true);
    for (const marker of [
      'Elasticsearch runtime: 8.19.4',
      'scenario-2 authorization boundary:',
      'scenario-2 cache identity:',
      'scenario-2 relevance goldens:',
      'scenario-2 profiled tenant-filtered relevance: pass',
      'scenario-2 batched authorization load: 40 alternating tenant searches passed',
      'scenario-2 freshness/update visibility: pass',
      'scenario-2 delete visibility: pass',
      'scenario-2 cache latency evidence:',
      'scenario-2 index/search evidence:',
    ]) {
      expect(result.evidence).toContain(marker);
    }
  }, 360_000);
});
