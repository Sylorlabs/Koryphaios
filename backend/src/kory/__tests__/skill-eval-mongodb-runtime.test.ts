import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MONGODB_RUNTIME_BLOCKER,
  mongodbRuntimeReadiness,
  runMongoAtomicUpdateRuntime,
  runMongoIndexRuntime,
} from '../../eval/skills/skill-eval-mongodb-runtime';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'kory-mongodb-runtime-'));
  roots.push(root);
  mkdirSync(join(root, '.kory-eval'), { recursive: true });
  return root;
}

function runtimeAvailable(): boolean {
  const blockers = mongodbRuntimeReadiness();
  if (blockers.length === 0) return true;
  expect(blockers).toEqual([MONGODB_RUNTIME_BLOCKER]);
  return false;
}

describe('MongoDB 8.0.12 skill-eval runtime', () => {
  test('atomic harness observes real version preconditions and stable item ids', () => {
    if (!runtimeAvailable()) return;

    const result = runMongoAtomicUpdateRuntime();
    expect(result.passed, result.evidence).toBe(true);
    for (const marker of [
      'MongoDB runtime: 8.0.12',
      'topology: single-node replica set rs0; readConcern=majority; writeConcern=majority',
      'atomic version compare-and-swap: pass',
      'stale-add=0',
      'retry-add=1',
      'duplicate stable item id rejection: pass',
      'stale remove precondition: pass',
      'majority read/write concern: pass',
    ]) {
      expect(result.evidence).toContain(marker);
    }
  }, 90_000);

  test('index harness executes representative skew and explain against the candidate index', () => {
    if (!runtimeAvailable()) return;
    const root = fixtureRoot();
    writeFileSync(
      join(root, '.kory-eval', 'mongo-index.json'),
      JSON.stringify({
        keys: [
          ['tenantId', 1],
          ['resolved', 1],
          ['createdAt', -1],
        ],
        partialUnresolved: true,
      }),
    );

    const result = runMongoIndexRuntime(root);
    expect(result.passed, result.evidence).toBe(true);
    for (const marker of [
      'MongoDB runtime: 8.0.12',
      'representative tenant workload: documents=1000000; unresolved=2000; returned=100',
      'baseline explain: docsExamined=',
      'candidate index explain: docsExamined=',
      'blockingSort=false',
      'candidate index shape:',
      'representative index/explain behavior: pass',
    ]) {
      expect(result.evidence).toContain(marker);
    }
  }, 270_000);

  test('malformed candidate index fails closed without runtime evidence', () => {
    const root = fixtureRoot();
    writeFileSync(
      join(root, '.kory-eval', 'mongo-index.json'),
      JSON.stringify({ keys: [['tenantId', 0]] }),
    );

    const result = runMongoIndexRuntime(root);
    expect(result.passed).toBe(false);
    expect(result.evidence).toContain('invalid MongoDB index specification');
    expect(result.evidence).not.toContain('MongoDB runtime:');
  });
});
