import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  auditSkillEvalExecutionReadiness,
  type SkillEvalDeterministicScorer,
  type SkillEvalFixtureMaterializer,
} from '../../eval/skills/skill-eval-execution';
import {
  BUILTIN_SKILL_EVAL_MATERIALIZERS,
  BUILTIN_SKILL_EVAL_SCORERS,
} from '../../eval/skills/skill-eval-fixtures';
import {
  buildSkillEvalSuiteV3,
  type SkillEvalScenarioV3,
} from '../../eval/skills/skill-eval-harness';
import { loadV5SkillPackages } from '../skill-packages';
import { hasRegressionText } from '../../eval/skills/skill-eval-fixture-helpers';

const packages = loadV5SkillPackages().packages;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scenario(skill: string, scenarioId: string): SkillEvalScenarioV3 {
  const task = packages
    .find((item) => item.sidecar.name === skill)!
    .evaluation.tasks.find((item) => item.id === scenarioId)!;
  return {
    ...task,
    skill,
    category: 'full-task',
    expectedSelection: true,
    expectedSkills: [],
    forbiddenSkills: [],
    heldOut: true,
    adjacentSkills: [],
    tags: ['held-out', 'full-task'],
  };
}

function fixtureParts(s: SkillEvalScenarioV3): {
  materializer: SkillEvalFixtureMaterializer;
  scorer: SkillEvalDeterministicScorer;
} {
  return {
    materializer: BUILTIN_SKILL_EVAL_MATERIALIZERS.find((item) => item.matches(s))!,
    scorer: BUILTIN_SKILL_EVAL_SCORERS.find((item) => item.scenarioIds.includes(s.id))!,
  };
}

async function materialize(s: SkillEvalScenarioV3): Promise<{
  root: string;
  scorer: SkillEvalDeterministicScorer;
}> {
  const root = mkdtempSync(join(tmpdir(), 'kory-promotion-repair-'));
  roots.push(root);
  const { materializer, scorer } = fixtureParts(s);
  await materializer.materialize(root, s);
  return { root, scorer };
}

describe('V5 promotion repair lane evaluator contracts', () => {
  // Each adapter may spend 15s probing Docker (search probes each task for
  // up to 12s). Audit only the owned package, with a bounded per-engine budget.
  for (const skill of [
    'mongodb-engineering',
    'mysql-engineering',
    'search-indexing',
    'vector-search-systems',
  ]) {
    test(`engine-backed search/vector evaluators: ${skill} retains registration and runtime gates`, () => {
      const rows = auditSkillEvalExecutionReadiness(
        packages.filter((pkg) => pkg.sidecar.name === skill),
        BUILTIN_SKILL_EVAL_MATERIALIZERS,
        BUILTIN_SKILL_EVAL_SCORERS,
      );
      expect(rows).toHaveLength(2);
      expect(rows.every((row) => row.ready) || rows.every((row) => !row.ready)).toBe(true);
      if (rows.every((row) => !row.ready)) {
        expect(
          rows.every((row) =>
            row.reasons.some((reason) => /Full-task qualification requires/u.test(reason)),
          ),
        ).toBe(true);
      } else {
        expect(rows.every((row) => row.reasons.length === 0)).toBe(true);
      }
      for (const row of rows) {
        const { materializer, scorer } = fixtureParts(scenario(skill, row.scenarioId));
        expect(materializer.realRuntime, row.scenarioId).toBe(true);
        expect(row.materializerId, row.scenarioId).toBe(materializer.id);
        expect(row.deterministicScorerId, row.scenarioId).toBe(scorer.id);
        expect(row.materializerId).toMatch(/@[34]$/u);
        if (skill === 'vector-search-systems') {
          expect(row.deterministicScorerId).toEndWith('@3');
        }
        if (skill === 'search-indexing') {
          // Task 1 keeps generation 3; task 2 moved to 4 when its warmCache shape was stated.
          expect(row.deterministicScorerId).toEndWith(
            row.scenarioId.endsWith('full-task-2-individual') ? '@4' : '@3',
          );
        }
      }
    }, 30_000);
  }

  test('PostgreSQL full tasks become execution-ready only with the pinned 17.5 Docker runtime', () => {
    const rows = auditSkillEvalExecutionReadiness(
      packages.filter((pkg) => pkg.sidecar.name === 'postgres-engineering'),
      BUILTIN_SKILL_EVAL_MATERIALIZERS,
      BUILTIN_SKILL_EVAL_SCORERS,
    );
    expect(rows).toHaveLength(2);
    expect(
      rows.every((row) =>
        row.scenarioId.endsWith('full-task-1-individual')
          ? row.materializerId?.endsWith('@5')
          : row.materializerId?.endsWith('@4'),
      ),
    ).toBe(true);
    if (rows.every((row) => row.ready)) {
      expect(
        rows.every((row) =>
          row.scenarioId.endsWith('full-task-1-individual')
            ? row.deterministicScorerId?.endsWith('@4')
            : row.deterministicScorerId?.endsWith('@3'),
        ),
      ).toBe(true);
    } else {
      expect(
        rows.every((row) =>
          row.reasons.some((reason) => /postgres:17\.5|PostgreSQL 17\.5/u.test(reason)),
        ),
      ).toBe(true);
    }
  });

  test('SQLite scorer imports materialized Python modules from the fixture root', async () => {
    const s = scenario('sqlite-engineering', 'sqlite-engineering-full-task-1-individual');
    const { root, scorer } = await materialize(s);
    expect(scorer.id).toBe('sqlite-engineering/wal-checkpoint-contention-scorer@3');

    const result = await scorer.score({
      scenario: s,
      experiment: {} as never,
      workingDirectory: root,
      observation: {} as never,
    });
    const evidence = result.evidence.join('\n');
    expect(result.passed).toBe(false);
    expect(evidence).not.toContain('ModuleNotFoundError');
    expect(evidence).not.toContain("No module named 'src'");
    expect(evidence).toContain('AssertionError');
  });

  // The fixture ships read_snapshot as a @contextmanager. A correct repair keeps
  // that shape and yields materialized rows, so the scorer must accept it. An
  // oracle that only accepts a plain function rejected the shape its own fixture
  // establishes, which made the pair unpassable for both arms.
  const sqliteWalReport = () =>
    JSON.stringify({
      runtime: 'sqlite3',
      journal: 'wal',
      busy_timeout_ms: 2000,
      checkpoint: 'wal_autocheckpoint=1000',
      reader: 'materialized inside the read transaction',
      writer: 'single writer, bounded retry',
      reopen: 'committed write present after crash/reopen',
    });

  test('SQLite scorer accepts a repaired context-manager snapshot that yields rows', async () => {
    const s = scenario('sqlite-engineering', 'sqlite-engineering-full-task-1-individual');
    const { root, scorer } = await materialize(s);
    mkdirSync(join(root, '.kory-eval'), { recursive: true });
    writeFileSync(join(root, '.kory-eval/sqlite-wal.json'), sqliteWalReport());
    writeFileSync(
      join(root, 'src/db.py'),
      String.raw`import sqlite3
from contextlib import contextmanager

def open_db(path: str):
    db = sqlite3.connect(path, timeout=2.0, isolation_level=None)
    db.execute('PRAGMA foreign_keys=ON')
    db.execute('PRAGMA busy_timeout=2000')
    db.execute('PRAGMA journal_mode=WAL')
    db.execute('PRAGMA wal_autocheckpoint=1000')
    return db

@contextmanager
def read_snapshot(db):
    db.execute('BEGIN')
    try:
        rows = db.execute('SELECT id,value FROM items ORDER BY id').fetchall()
    except BaseException:
        db.execute('ROLLBACK')
        raise
    else:
        db.execute('COMMIT')
    yield rows
`,
    );
    const result = await scorer.score({
      scenario: s,
      experiment: {} as never,
      workingDirectory: root,
      observation: {} as never,
    });
    expect(result.evidence.join('\n')).toContain('wal config/reopen pass');
    expect(result.passed).toBe(true);
    expect(result.verification).toBe(1);
  });

  test('SQLite scorer accepts a repaired plain-function snapshot that returns rows', async () => {
    const s = scenario('sqlite-engineering', 'sqlite-engineering-full-task-1-individual');
    const { root, scorer } = await materialize(s);
    mkdirSync(join(root, '.kory-eval'), { recursive: true });
    writeFileSync(join(root, '.kory-eval/sqlite-wal.json'), sqliteWalReport());
    writeFileSync(
      join(root, 'src/db.py'),
      String.raw`import sqlite3

def open_db(path: str):
    db = sqlite3.connect(path, timeout=2.0, isolation_level=None)
    db.execute('PRAGMA foreign_keys=ON')
    db.execute('PRAGMA busy_timeout=2000')
    db.execute('PRAGMA journal_mode=WAL')
    db.execute('PRAGMA wal_autocheckpoint=1000')
    return db

def read_snapshot(db):
    db.execute('BEGIN')
    try:
        rows = db.execute('SELECT id,value FROM items ORDER BY id').fetchall()
    finally:
        db.execute('COMMIT')
    return rows
`,
    );
    const result = await scorer.score({
      scenario: s,
      experiment: {} as never,
      workingDirectory: root,
      observation: {} as never,
    });
    expect(result.passed).toBe(true);
  });

  test('SQLite scorer still rejects an unmaterialized cursor snapshot', async () => {
    const s = scenario('sqlite-engineering', 'sqlite-engineering-full-task-1-individual');
    const { root, scorer } = await materialize(s);
    mkdirSync(join(root, '.kory-eval'), { recursive: true });
    writeFileSync(join(root, '.kory-eval/sqlite-wal.json'), sqliteWalReport());
    writeFileSync(
      join(root, 'src/db.py'),
      String.raw`import sqlite3
from contextlib import contextmanager

def open_db(path: str):
    db = sqlite3.connect(path, timeout=2.0, isolation_level=None)
    db.execute('PRAGMA foreign_keys=ON')
    db.execute('PRAGMA busy_timeout=2000')
    db.execute('PRAGMA journal_mode=WAL')
    return db

@contextmanager
def read_snapshot(db):
    db.execute('BEGIN')
    try:
        yield db.execute('SELECT id,value FROM items ORDER BY id')
    finally:
        db.execute('COMMIT')
`,
    );
    const result = await scorer.score({
      scenario: s,
      experiment: {} as never,
      workingDirectory: root,
      observation: {} as never,
    });
    expect(result.passed).toBe(false);
    expect(result.evidence.join('\n')).toContain('AssertionError');
  });

  test('stream scorer rejects bounded dedup with unbounded aggregate windows and accepts full eviction', async () => {
    const s = scenario('stream-processing', 'stream-processing-full-task-1-individual');
    const { root, scorer } = await materialize(s);
    expect(scorer.id).toBe('stream-processing/event-time-window-dedup-scorer@3');

    mkdirSync(join(root, '.kory-eval'), { recursive: true });
    writeFileSync(join(root, '.kory-eval/stream-window.json'), '{}\n');
    writeFileSync(
      join(root, 'tests/regressions.test.ts'),
      String.raw`
import { expect, test } from 'bun:test';
import { WindowCounter } from '../src/stream';
const m = 60_000;
test('event-time late arrivals, duplicate suppression and checkpoint restart', () => {
  const c = new WindowCounter(m, 12 * m);
  const old = { id: 'old', key: 'mobile', eventTimeMs: 1, value: 2 };
  expect(c.ingest(old, m)).toBe('applied');
  expect(c.ingest(old, m)).toBe('duplicate');
  const restarted = new WindowCounter(m, 12 * m);
  restarted.restore(c.checkpoint());
  expect(restarted.ingest(old, m)).toBe('duplicate');
  expect(restarted.count(0)).toBe(2);
  expect(restarted.ingest({ id: 'fresh', key: 'mobile', eventTimeMs: 20 * m + 1, value: 3 }, 20 * m)).toBe('applied');
  expect(restarted.count(0)).toBe(0);
  expect(restarted.retainedIds()).toBe(1);
});
test('out-of-order late event updates its event-time bucket', () => {
  const c = new WindowCounter(m, 12 * m);
  expect(c.ingest({ id: 'new', key: 'mobile', eventTimeMs: 10 * m + 1, value: 1 }, 10 * m)).toBe('applied');
  expect(c.ingest({ id: 'late', key: 'mobile', eventTimeMs: 9 * m + 1, value: 4 }, 10 * m)).toBe('applied');
  expect(c.count(9 * m)).toBe(4);
  expect(c.count(10 * m)).toBe(1);
});
`,
    );

    const shared = String.raw`
export interface StreamEvent{id:string;key:string;eventTimeMs:number;value:number}
export class WindowCounter{
  private seen=new Map<string,number>();
  private counts=new Map<number,number>();
  constructor(readonly windowMs:number,readonly allowedLatenessMs:number){}
  private prune(watermarkMs:number, pruneCounts:boolean){
    const cutoff=watermarkMs-this.allowedLatenessMs;
    for(const [id,time] of this.seen)if(time<cutoff)this.seen.delete(id);
    if(pruneCounts)for(const bucket of this.counts.keys())if(bucket+this.windowMs<cutoff)this.counts.delete(bucket);
  }
  protected pruneCounts(){return false}
  ingest(event:StreamEvent,watermarkMs:number):'applied'|'duplicate'|'too-late'{
    this.prune(watermarkMs,this.pruneCounts());
    if(event.eventTimeMs<watermarkMs-this.allowedLatenessMs)return'too-late';
    if(this.seen.has(event.id))return'duplicate';
    this.seen.set(event.id,event.eventTimeMs);
    const bucket=Math.floor(event.eventTimeMs/this.windowMs)*this.windowMs;
    this.counts.set(bucket,(this.counts.get(bucket)??0)+event.value);
    return'applied';
  }
  count(bucket:number){return this.counts.get(bucket)??0}
  retainedIds(){return this.seen.size}
  checkpoint(){return{seen:[...this.seen] as [string,number][],counts:[...this.counts] as [number,number][]}}
  restore(s:{seen:[string,number][];counts:[number,number][]}){this.seen=new Map(s.seen);this.counts=new Map(s.counts)}
}
`;
    writeFileSync(join(root, 'src/stream.ts'), shared);
    const bad = await scorer.score({
      scenario: s,
      experiment: {} as never,
      workingDirectory: root,
      observation: {} as never,
    });
    expect(bad.passed, bad.evidence.join('\n')).toBe(false);
    expect(bad.verification).toBe(0);

    writeFileSync(
      join(root, 'src/stream.ts'),
      shared.replace(
        'protected pruneCounts(){return false}',
        'protected pruneCounts(){return true}',
      ),
    );
    const good = await scorer.score({
      scenario: s,
      experiment: {} as never,
      workingDirectory: root,
      observation: {} as never,
    });
    expect(good.passed, good.evidence.join('\n')).toBe(true);
    expect(good.verification).toBe(1);
  });

  test('stream checkpoint scorer accepts an explicit async sink idempotency boundary', async () => {
    const s = scenario('stream-processing', 'stream-processing-full-task-2-individual');
    const { root, scorer } = await materialize(s);
    expect(scorer.id).toBe('stream-processing/checkpoint-sink-idempotency-scorer@3');

    mkdirSync(join(root, '.kory-eval'), { recursive: true });
    writeFileSync(
      join(root, '.kory-eval/stream-checkpoint.json'),
      JSON.stringify({ logicalExactlyOnceEffects: true, transportExactlyOnce: false }),
    );
    writeFileSync(
      join(root, 'tests/stream.test.ts'),
      String.raw`
import { expect, test } from 'bun:test';
import { CheckpointProcessor } from '../src/stream';
function persistentSink() {
  const effects = new Map<string, number>();
  return {
    effects,
    async applyOnce(id: string, delta: number) {
      if (effects.has(id)) return false;
      effects.set(id, delta);
      return true;
    },
  };
}
test('after-sink checkpoint crash replays with an idempotent effect and explicit status', async () => {
  const sink = persistentSink();
  let p = new CheckpointProcessor(sink);
  const event = { id: 'first', offset: 1, delta: 4 };
  await expect(p.process(event, 'after-sink-before-checkpoint')).rejects.toThrow();
  expect(p.offset).toBe(0);
  expect(sink.effects.get(event.id)).toBe(4);
  p = new CheckpointProcessor(sink);
  expect(await p.process(event)).toBe('duplicate');
  expect(sink.effects.get(event.id)).toBe(4);
  expect(p.offset).toBe(1);
});
test('before-sink crash leaves durable effect and progress unchanged', async () => {
  const sink = persistentSink();
  const p = new CheckpointProcessor(sink);
  await expect(p.process({ id: 'second', offset: 2, delta: 5 }, 'before-sink')).rejects.toThrow();
  expect(sink.effects.size).toBe(0);
  expect(p.offset).toBe(0);
});
`,
    );
    writeFileSync(
      join(root, 'src/stream.ts'),
      String.raw`
export interface Sink {
  effects: Map<string, number>;
  applyOnce(eventId: string, delta: number): boolean | Promise<boolean>;
}
export class CheckpointProcessor {
  offset = 0;
  constructor(readonly sink: Sink) {}
  async process(event: {id:string;offset:number;delta:number}, crash: 'none'|'after-sink-before-checkpoint'|'before-sink' = 'none') {
    if (event.offset <= this.offset) return 'duplicate';
    if (crash === 'before-sink') throw new Error('crash before sink');
    const applied = await this.sink.applyOnce(event.id, event.delta);
    if (crash === 'after-sink-before-checkpoint') throw new Error('crash after sink before checkpoint');
    this.offset = event.offset;
    return applied ? 'applied' : 'duplicate';
  }
}
`,
    );

    const result = await scorer.score({
      scenario: s,
      experiment: {} as never,
      workingDirectory: root,
      observation: {} as never,
    });
    expect(result.passed, result.evidence.join('\n')).toBe(true);
    expect(result.verification).toBe(1);
  });
});

describe('regression evidence scan recognises the fixture language', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  const fixture = (files: Record<string, string>) => {
    const root = mkdtempSync(join(tmpdir(), 'kory-regression-scan-'));
    roots.push(root);
    for (const [path, body] of Object.entries(files)) {
      mkdirSync(join(root, path, '..'), { recursive: true });
      writeFileSync(join(root, path), body);
    }
    return root;
  };
  const patterns = [/interrupt|rollback|old.?schema/iu, /foreign_key_check|constraint|bad/iu];

  test('accepts a Python test written by a candidate for the Python fixture', () => {
    // sqlite-engineering ships a Python fixture, so its candidates write pytest
    // files. Both spellings must count, and the source file must not.
    const root = fixture({
      'tests/test_migration.py':
        'def test_interrupted_migration_rolls_back():\n    assert old_schema()\n    foreign_key_check()\n',
      'tests/migration_test.py': 'def test_bad_row():\n    raise ValueError("constraint")\n',
    });
    expect(hasRegressionText(root, patterns)).toBe(true);
  });

  test('does not credit a non-test Python source file or partial evidence', () => {
    const sourceOnly = fixture({
      'src/migration.py': 'interrupt = "rollback old_schema foreign_key_check constraint bad"\n',
    });
    expect(hasRegressionText(sourceOnly, patterns)).toBe(false);

    const partial = fixture({
      'tests/test_migration.py': 'def test_interrupt():\n    pass\n',
    });
    expect(hasRegressionText(partial, patterns)).toBe(false);
  });

  test('keeps the existing JavaScript convention working', () => {
    const root = fixture({
      'tests/migrate.test.ts':
        'test("rollback", () => { expect(foreign_key_check()).toBe(true); });\n',
    });
    expect(hasRegressionText(root, patterns)).toBe(true);
  });
});

describe('mysql transfer scorer accepts the shape it documents', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  const fixture = async () => {
    const pkg = packages.find((item) => item.sidecar.name === 'mysql-engineering')!;
    const scenario = buildSkillEvalSuiteV3(pkg).scenarios.find(
      (item) => item.id === 'mysql-engineering-full-task-2-individual',
    )!;
    const materializer = BUILTIN_SKILL_EVAL_MATERIALIZERS.find((item) => item.matches(scenario))!;
    const scorer = BUILTIN_SKILL_EVAL_SCORERS.find((item) =>
      item.scenarioIds.includes(scenario.id),
    )!;
    const root = mkdtempSync(join(tmpdir(), 'kory-mysql-shape-'));
    roots.push(root);
    await materializer.materialize(root, scenario);
    mkdirSync(join(root, '.kory-eval'), { recursive: true });
    writeFileSync(
      join(root, '.kory-eval/mysql-deadlock.json'),
      JSON.stringify({
        engine: 'MySQL 8.4 InnoDB',
        isolation: 'READ COMMITTED with opposite-direction deadlock detection',
        order: 'canonical lock order by account key, same for either direction',
        retry: 'bounded retry with backoff on retryable deadlock',
        invariants: 'balance plus ledger sum stay consistent',
        neighbor: 'SQLite uses one writer, so the row order is not needed there',
      }),
    );
    writeFileSync(
      join(root, 'tests/transfer.test.ts'),
      `import{expect,test}from'bun:test';
test('opposite direction concurrent retry and idempotency',()=>{expect('lock order retry exhaust rollback insufficient opposite concurrent').toBeTruthy();});
`,
    );
    const score = () =>
      scorer.score({
        scenario,
        experiment: {} as never,
        workingDirectory: root,
        observation: {} as never,
      });
    const writeTransfer = (body: string) => writeFileSync(join(root, 'src/transfer.ts'), body);
    return { root, score, writeTransfer };
  };

  const store = (asyncTransfer: boolean) => `export interface Account { balance: number }
export class TransferStore {
  accounts = new Map<string, Account>([['a', { balance: 100 }], ['b', { balance: 100 }]]);
  ledger = new Map<string, unknown>();
  lockOrder(from: string, to: string) { return [from, to].sort(); }
  ${asyncTransfer ? 'async ' : ''}transfer(id: string, from: string, to: string, amount: number) {
    if (this.ledger.has(id)) return 'ok';
    const [first, second] = this.lockOrder(from, to);
    const f = this.accounts.get(first)!; const t = this.accounts.get(second)!;
    if (f.balance < amount) return 'insufficient';
    f.balance -= amount; t.balance += amount;
    this.ledger.set(id, { id, first, second, amount });
    return 'ok';
  }
}
`;

  test('a synchronous and an asynchronous transfer both satisfy the hidden contract', async () => {
    const { score, writeTransfer } = await fixture();
    for (const asyncTransfer of [false, true]) {
      writeTransfer(store(asyncTransfer));
      const result = await score();
      expect(result.evidence.join('\n')).toContain('transfer/idempotency/lock order: pass');
    }
  });

  test('a transfer without idempotency still fails the hidden contract', async () => {
    const { score, writeTransfer } = await fixture();
    writeTransfer(store(false).replace("if (this.ledger.has(id)) return 'ok';", ''));
    expect((await score()).evidence.join('\n')).toContain('transfer/idempotency/lock order: fail');
  });
});

describe('sqlite copy-table migration scorer grades against the supplied legacy schema', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  test('a correct migration over the supplied schema passes the hidden check', async () => {
    const pkg = packages.find((item) => item.sidecar.name === 'sqlite-engineering')!;
    const scenario = buildSkillEvalSuiteV3(pkg).scenarios.find(
      (item) => item.id === 'sqlite-engineering-full-task-2-individual',
    )!;
    const materializer = BUILTIN_SKILL_EVAL_MATERIALIZERS.find((item) => item.matches(scenario))!;
    const scorer = BUILTIN_SKILL_EVAL_SCORERS.find((item) =>
      item.scenarioIds.includes(scenario.id),
    )!;
    const root = mkdtempSync(join(tmpdir(), 'kory-sqlite-schema-'));
    roots.push(root);
    await materializer.materialize(root, scenario);
    // The task says a legacy path is supplied; it must actually exist.
    const schema = readFileSync(join(root, 'data/legacy_schema.sql'), 'utf8');
    expect(schema).toContain('create table widgets(');
    expect(schema).toContain('trg_widgets');
    writeFileSync(
      join(root, 'src/migration.py'),
      `import sqlite3

def migrate(db: sqlite3.Connection) -> None:
    db.execute('BEGIN IMMEDIATE')
    try:
        db.execute(
            'create table widgets_new(id integer primary key,'
            ' parent_id integer references parents(id), score integer check(score >= 0))'
        )
        db.execute(
            'insert into widgets_new(id,parent_id,score)'
            ' select id,parent_id,score from widgets where score is not null and score >= 0'
        )
        db.execute('drop table widgets')
        db.execute('alter table widgets_new rename to widgets')
        db.execute('create index idx_widgets_parent on widgets(parent_id)')
        db.execute(
            'create trigger trg_widgets after insert on widgets begin'
            ' insert into audit(msg) values(new.id);end;'
        )
        assert list(db.execute('pragma foreign_key_check')) == []
        db.execute('COMMIT')
    except Exception:
        db.execute('ROLLBACK')
        raise
`,
    );
    writeFileSync(
      join(root, 'tests/test_migration.py'),
      `def test_interrupted_migration_rolls_back_to_old_schema():
    assert rollback_restores_old_schema()

def test_bad_row_is_rejected_by_constraint():
    assert foreign_key_check_and_constraint_reject()
`,
    );
    mkdirSync(join(root, '.kory-eval'), { recursive: true });
    writeFileSync(
      join(root, '.kory-eval/sqlite-migration.json'),
      JSON.stringify({
        runtime: 'sqlite 3.51 branch: copy-table for every version',
        inventory: 'index idx_widgets_parent, trigger trg_widgets, foreign key parent_id',
        badRows: 'negative score is rejected by CHECK and the transaction rolls back',
        tests: 'success, constraint, interruption and downgrade all covered',
        integrity: 'pragma foreign_key_check runs before commit',
        boundary: 'Postgres has transactional DDL; SQLite needs the copy-table route',
      }),
    );
    const result = await scorer.score({
      scenario,
      experiment: {} as never,
      workingDirectory: root,
      observation: {} as never,
    });
    expect(result.evidence.join('\n')).toContain('copy-table migration behavior: pass');
    expect(result.evidence.join('\n')).toContain('rollback/integrity regressions: present');
    expect(result.passed, result.evidence.join('\n')).toBe(true);
  });
});
