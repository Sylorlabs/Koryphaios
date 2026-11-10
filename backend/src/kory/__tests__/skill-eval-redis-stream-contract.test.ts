import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DATABASE_SKILL_EVAL_MATERIALIZERS,
  DATABASE_SKILL_EVAL_SCORERS,
} from '../skill-eval-database-fixtures';

const scenarioId = 'redis-engineering-full-task-2-individual';
const materializer = DATABASE_SKILL_EVAL_MATERIALIZERS.find((item) =>
  item.matches({ id: scenarioId } as never),
)!;
const scorer = DATABASE_SKILL_EVAL_SCORERS.find((item) => item.scenarioIds.includes(scenarioId))!;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function materialize(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'kory-redis-stream-contract-'));
  roots.push(root);
  await materializer.materialize(root, { id: scenarioId } as never);
  mkdirSync(join(root, '.kory-eval'), { recursive: true });
  return root;
}

function installCandidate(root: string): void {
  const source = readFileSync(join(root, 'src/redis.ts'), 'utf8');
  const repaired = source.replace(
    'process(id:string,now:number,crashAfterEffect=false){const m=this.messages.get(id)!;if(m.poison){',
    'process(id:string,now:number,crashAfterEffect=false){const m=this.messages.get(id)!;if(m.acked)return;if(m.poison){',
  );
  expect(repaired).not.toBe(source);
  writeFileSync(join(root, 'src/redis.ts'), repaired);
  writeFileSync(
    join(root, 'tests/redis-stream.test.ts'),
    `import { test, expect } from 'bun:test';
import { StreamGroup } from '../src/redis';

test('crash leaves one durable effect and pending entry; early claim preserves age', () => {
  const group = new StreamGroup();
  group.add({ id: 'abandoned', attempts: 0, acked: false, pendingSince: 0 });
  expect(() => group.process('abandoned', 0, true)).toThrow('crash');
  expect(group.effects.size).toBe(1);
  expect(group.messages.get('abandoned')?.acked).toBe(false);
  expect(group.claimIdle('abandoned', 9, 10)).toBe(false);
  expect(group.messages.get('abandoned')?.pendingSince).toBe(0);
  expect(group.claimIdle('abandoned', 11, 10)).toBe(true);
  expect(group.messages.get('abandoned')?.pendingSince).toBe(11);
  expect(group.claimIdle('abandoned', 12, 10)).toBe(false);
  group.process('abandoned', 13);
  expect(group.messages.get('abandoned')?.acked).toBe(true);
  expect(group.effects.size).toBe(1);
});

test('poison entry reaches DLQ and ack at a finite bound without duplicate publication', () => {
  const group = new StreamGroup();
  group.add({ id: 'poison', attempts: 0, acked: false, pendingSince: 0, poison: true });
  group.process('poison', 0);
  group.process('poison', 1);
  expect(group.dlq).toEqual([]);
  group.process('poison', 2);
  group.process('poison', 3);
  expect(group.dlq).toEqual(['poison']);
  expect(group.messages.get('poison')?.acked).toBe(true);
});
`,
  );
  writeFileSync(
    join(root, '.kory-eval/redis-stream.json'),
    JSON.stringify({
      environment: 'synthetic StreamGroup model; no real Redis server or failover tested',
      delivery: 'at-least-once transport; logically once durable effect via stable id',
      pending: 'early claim rejected, eligible idle claim resets age; abandoned consumer simulated',
      ordering: 'effect before XACK; replay deduplicates by stable message identity',
      retryBudget: 'poison message to DLQ and ack on the third attempt, duplicate-safe',
      observability: 'pending count, claim idle age, per-message attempts, DLQ count',
      caveats: 'Redis reconnect, persistence, and real failover require integration verification',
      neighbor: 'relational-data-modeling owns the authoritative business effect schema',
    }),
  );
}

describe('Redis Streams recovery evaluator contract', () => {
  test('requires retained verification evidence even when starter behavior passes hidden checks', async () => {
    const root = await materialize();
    const result = await scorer.score({ workingDirectory: root } as never);
    expect(result.passed).toBe(false);
    expect(result.verification).toBe(1);
  });

  test('accepts working crash/replay, claim-age, and finite DLQ regression coverage', async () => {
    const root = await materialize();
    installCandidate(root);
    const result = await scorer.score({ workingDirectory: root } as never);
    expect(result).toMatchObject({ passed: true, quality: 1, verification: 1 });
  });

  test('rejects an early-reclaim bug even when verification files exist', async () => {
    const root = await materialize();
    installCandidate(root);
    const file = join(root, 'src/redis.ts');
    const source = readFileSync(file, 'utf8');
    const mutant = source.replace(
      'if(m.acked||now-m.pendingSince<minIdle)return false;',
      'if(m.acked)return false;',
    );
    expect(mutant).not.toBe(source);
    writeFileSync(file, mutant);
    const result = await scorer.score({ workingDirectory: root } as never);
    expect(result.passed).toBe(false);
    expect(result.verification).toBe(0);
  });
});
