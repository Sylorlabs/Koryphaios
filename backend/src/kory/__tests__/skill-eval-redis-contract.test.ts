import { afterEach, describe, expect, test } from 'bun:test';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  DATABASE_SKILL_EVAL_MATERIALIZERS,
  DATABASE_SKILL_EVAL_SCORERS,
} from '../../eval/skills/skill-eval-database-fixtures';

const scenarioId = 'redis-engineering-full-task-1-individual';
const materializer = DATABASE_SKILL_EVAL_MATERIALIZERS.find((item) =>
  item.matches({ id: scenarioId } as never),
)!;
const scorer = DATABASE_SKILL_EVAL_SCORERS.find((item) => item.scenarioIds.includes(scenarioId))!;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function materialize(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'kory-redis-contract-'));
  roots.push(root);
  await materializer.materialize(root, { id: scenarioId } as never);
  mkdirSync(join(root, '.kory-eval'), { recursive: true });
  return root;
}

function repairedSource(original: string): string {
  const repaired = original
    .replace('release(owner:string){', 'release(owner:string,now:number){')
    .replace(
      '// BUG: release ignores current ownership token.',
      '// Compare current owner and live expiry at command time.',
    )
    .replace(
      'if(this.lock)this.lock=null;return true}',
      'if(!this.lock||this.lock.owner!==owner||this.lock.expiresAt<=now)return false;this.lock=null;return true}',
    )
    .replace(
      'renew(owner:string,now:number,ttl:number){if(!this.lock)return false;',
      'renew(owner:string,now:number,ttl:number){if(!this.lock||this.lock.owner!==owner||this.lock.expiresAt<=now)return false;',
    );
  expect(repaired).not.toBe(original);
  expect(repaired).toContain('release(owner:string,now:number)');
  return repaired;
}

function installPublicEvidence(root: string): void {
  writeFileSync(
    join(root, 'tests/redis.test.ts'),
    `import { expect, test } from 'bun:test';
import { RedisLockSim } from '../src/redis';
test('expiry allows a replacement owner', () => {
  const lock = new RedisLockSim();
  expect(lock.acquire('a', 0, 10)).toBe(true);
  expect(lock.acquire('b', 9, 10)).toBe(false);
  expect(lock.acquire('b', 10, 10)).toBe(true);
});
test('paused stale owner cannot release or renew after failover to next token', () => {
  const lock = new RedisLockSim();
  lock.acquire('a', 0, 10);
  lock.acquire('b', 10, 10);
  expect(lock.release('a', 11)).toBe(false);
  expect(lock.renew('a', 11, 10)).toBe(false);
  expect(lock.lock?.owner).toBe('b');
});
`,
  );
  writeFileSync(
    join(root, '.kory-eval/redis-lock.json'),
    JSON.stringify({
      deployment: 'synthetic single-primary Redis coordination model',
      ownerTokenLifecycle: 'unique owner per acquisition',
      expiry: 'injected deterministic time; equality is expired',
      boundary: 'MongoDB is authoritative; the Redis lock only coordinates refresh work',
    }),
  );
}

async function score(root: string) {
  return scorer.score({ workingDirectory: root } as never);
}

describe('Redis owned-refresh-lock fixture contract', () => {
  test('versions the clocked-release contract without changing the Streams fixture', async () => {
    expect(materializer.id).toBe('redis-engineering/owned-refresh-lock@2');
    expect(scorer.id).toBe('redis-engineering/owned-refresh-lock-scorer@2');
    const stream = DATABASE_SKILL_EVAL_MATERIALIZERS.find((item) =>
      item.matches({ id: 'redis-engineering-full-task-2-individual' } as never),
    )!;
    expect(stream.id).toBe('redis-engineering/streams-pending-recovery@1');

    const root = await materialize();
    const readme = readFileSync(join(root, 'README.md'), 'utf8');
    expect(readme).toContain('release(owner: string, now: number)');
    expect(readme).toContain('no newer worker');
    expect(readme).toContain('eviction, reconnect, duplicate refresh');

    const repo = resolve(import.meta.dir, '../../../..');
    const metadata = JSON.parse(
      readFileSync(join(repo, 'skills-v5/redis-engineering/kory.json'), 'utf8'),
    );
    expect(metadata.version).toBe('5.1.3');
  });

  test('accepts an actual clocked compare-owner fix but rejects release that ignores expiry', async () => {
    const root = await materialize();
    const original = readFileSync(join(root, 'src/redis.ts'), 'utf8');
    const fixed = repairedSource(original);
    installPublicEvidence(root);

    writeFileSync(join(root, 'src/redis.ts'), fixed);
    const passing = await score(root);
    expect(passing).toMatchObject({
      passed: true,
      quality: 1,
      verification: 1,
      integrityFailure: false,
    });

    // Retain a two-argument API, but reproduce the missed expiry check.
    const mutant = fixed.replace(
      'this.lock.owner!==owner||this.lock.expiresAt<=now)return false;this.lock=null;',
      'this.lock.owner!==owner)return false;this.lock=null;',
    );
    expect(mutant).not.toBe(fixed);
    writeFileSync(join(root, 'src/redis.ts'), mutant);
    const failing = await score(root);
    expect(failing.passed).toBe(false);
    expect(failing.verification).toBe(0);
    expect(failing.evidence.join('\n')).toContain('expired release with no successor');
    expect(failing.evidence.join('\n')).toContain('Public tests: passed');
  });

  test('rejects both archived candidates that passed the old deterministic scorer', async () => {
    const repo = resolve(import.meta.dir, '../../../..');
    const pair = 'redis-engineering-full-task-1-individual_10cf52d0-6b1f-4292-bb6e-da76ce0ddc62';
    const artifacts = join(repo, '.koryphaios/skills/eval-artifacts', pair);
    // Archives are local evidence; the portable red/green mutant test above still runs without them.
    let reviewed = 0;
    for (const variant of ['with-skill', 'without-skill']) {
      const source = join(artifacts, variant, 'files/src/redis.ts');
      if (!existsSync(source)) continue;
      const root = await materialize();
      copyFileSync(source, join(root, 'src/redis.ts'));
      copyFileSync(
        join(artifacts, variant, 'files/tests/redis.test.ts'),
        join(root, 'tests/redis.test.ts'),
      );
      copyFileSync(
        join(artifacts, variant, 'files/.kory-eval/redis-lock.json'),
        join(root, '.kory-eval/redis-lock.json'),
      );
      const result = await score(root);
      expect(result.passed).toBe(false);
      expect(result.verification).toBe(0);
      expect(result.evidence.join('\n')).toContain('expired release with no successor');
      expect(result.evidence.join('\n')).toContain('Public tests: passed');
      reviewed++;
    }
    if (existsSync(artifacts)) expect(reviewed).toBe(2);
  });
});
