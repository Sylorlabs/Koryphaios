import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type {
  SkillEvalDeterministicScorer,
  SkillEvalFixtureMaterializer,
} from './skill-eval-execution';
import {
  hasRegressionText,
  packageJson,
  readJsonArtifact,
  runHiddenBunTest,
  writeFixtureFile,
} from './skill-eval-fixture-helpers';

const REL_MEMBERSHIP = 'relational-data-modeling-full-task-1-individual';
const REL_ORDERS = 'relational-data-modeling-full-task-2-individual';
const POSTGRES_QUEUE = 'postgres-engineering-full-task-1-individual';
const POSTGRES_CONSTRAINT = 'postgres-engineering-full-task-2-individual';
const MYSQL_INDEX = 'mysql-engineering-full-task-1-individual';
const MYSQL_DEADLOCK = 'mysql-engineering-full-task-2-individual';
const SQLITE_WAL = 'sqlite-engineering-full-task-1-individual';
const SQLITE_MIGRATION = 'sqlite-engineering-full-task-2-individual';
const MONGO_UPDATE = 'mongodb-engineering-full-task-1-individual';
const MONGO_INDEX = 'mongodb-engineering-full-task-2-individual';
const REDIS_LOCK = 'redis-engineering-full-task-1-individual';
const REDIS_STREAM = 'redis-engineering-full-task-2-individual';

const POSTGRES_RUNTIME_BLOCKER =
  'Full-task qualification requires PostgreSQL 17.5-backed lock, concurrency, constraint, and plan execution; this fixture currently checks SQL/report structure only.';
const MYSQL_RUNTIME_BLOCKER =
  'Full-task qualification requires MySQL 8/InnoDB-backed DDL, metadata-lock, replication, and deadlock execution; this fixture currently checks SQL/report structure or an in-memory transfer model only.';
const MONGODB_RUNTIME_BLOCKER =
  'Full-task qualification requires MongoDB-backed atomic-update and explain/index execution; this fixture currently uses an in-memory document/index model only.';

function artifactText(root: string, path: string): { artifact: unknown | null; text: string } {
  const artifact = readJsonArtifact<unknown>(root, path);
  return { artifact, text: JSON.stringify(artifact ?? '').toLowerCase() };
}

function runPython(root: string, source: string): { passed: boolean; evidence: string } {
  const path = join(root, 'tests', '__kory_db_test.py');
  writeFileSync(path, source);
  try {
    const result = spawnSync('python3', [path], {
      cwd: root,
      encoding: 'utf8',
      timeout: 8_000,
      maxBuffer: 1_000_000,
    });
    return {
      passed: result.status === 0,
      evidence: `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim().slice(-4_000),
    };
  } finally {
    rmSync(path, { force: true });
  }
}

const membershipMaterializer: SkillEvalFixtureMaterializer = {
  id: 'relational-data-modeling/membership-history@1',
  matches: (scenario) => scenario.id === REL_MEMBERSHIP,
  materialize: (destination) => {
    writeFixtureFile(destination, 'package.json', packageJson('kory-eval-rel-membership'));
    writeFixtureFile(destination, 'tests/.gitkeep', '');
    writeFixtureFile(
      destination,
      'schema.sql',
      `CREATE TABLE memberships (
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  role TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, workspace_id)
);
`,
    );
    writeFixtureFile(
      destination,
      'README.md',
      `# Relational membership-history fixture

Replace \`schema.sql\` with the post-migration relational model. Preserve every membership tenure and role transition as history rather than overwriting one row. Each history row needs stable identity, \`user_id\`, \`workspace_id\`, role, start time and nullable end time. Enforce at the database level that at most one row with no end time exists per user/workspace, including concurrent inserts. Leave/rejoin creates a new history row; role change closes the old row and opens the next in one transaction.

Use explicit foreign/uniqueness/index constraints where relevant. Write \`.kory-eval/rel-membership.json\` with old→new migration, transactional update semantics, rollback, high-value lookup index/query-plan evidence, broader backend-engineering, relational children (MySQL/Postgres/SQLite), and MongoDB neighbor boundary.
`,
    );
  },
};

const membershipScorer: SkillEvalDeterministicScorer = {
  id: 'relational-data-modeling/membership-history-scorer@1',
  scenarioIds: [REL_MEMBERSHIP],
  score: ({ workingDirectory }) => {
    const hidden = runPython(
      workingDirectory,
      `import sqlite3
sql=open('schema.sql').read()
db=sqlite3.connect(':memory:')
db.executescript(sql)
tables=[r[0] for r in db.execute("select name from sqlite_master where type='table'")]
table='membership_history' if 'membership_history' in tables else ('memberships' if 'memberships' in tables else None)
assert table
cols=[r[1] for r in db.execute(f'pragma table_info({table})')]
for c in ['user_id','workspace_id','role']:
    assert c in cols
start=next((c for c in ['started_at','valid_from','joined_at'] if c in cols),None)
end=next((c for c in ['ended_at','valid_to','left_at'] if c in cols),None)
assert start and end
db.execute(f"insert into {table}(user_id,workspace_id,role,{start},{end}) values(?,?,?,?,NULL)",('u','w','member',1))
try:
    db.execute(f"insert into {table}(user_id,workspace_id,role,{start},{end}) values(?,?,?,?,NULL)",('u','w','admin',2))
    raise AssertionError('duplicate active membership accepted')
except sqlite3.IntegrityError:
    pass
db.execute(f"update {table} set {end}=3 where user_id='u' and workspace_id='w' and {end} is null")
db.execute(f"insert into {table}(user_id,workspace_id,role,{start},{end}) values(?,?,?,?,NULL)",('u','w','admin',4))
rows=list(db.execute(f"select role,{start},{end} from {table} where user_id='u' and workspace_id='w' order by {start}"))
assert rows==[('member',1,3),('admin',4,None)], rows
print('membership temporal constraints pass')
`,
    );
    const report = artifactText(workingDirectory, '.kory-eval/rel-membership.json');
    const bounded =
      Boolean(report.artifact) &&
      /migration/u.test(report.text) &&
      /rollback/u.test(report.text) &&
      /index|plan/u.test(report.text) &&
      /postgres|mysql|sqlite/u.test(report.text) &&
      /mongodb/u.test(report.text);
    const passed = hidden.passed && bounded;
    return {
      passed,
      quality: passed ? 1 : hidden.passed ? 0.8 : 0,
      verification: hidden.passed ? 1 : 0,
      integrityFailure: false,
      evidence: [
        `temporal relational constraints: ${hidden.passed ? 'pass' : 'fail'}`,
        `migration/hierarchy evidence: ${bounded ? 'present' : 'missing'}`,
        hidden.evidence,
      ],
    };
  },
};

const ordersMaterializer: SkillEvalFixtureMaterializer = {
  id: 'relational-data-modeling/order-refund-facts@1',
  matches: (scenario) => scenario.id === REL_ORDERS,
  materialize: (destination) => {
    writeFixtureFile(destination, 'package.json', packageJson('kory-eval-rel-orders'));
    writeFixtureFile(destination, 'tests/.gitkeep', '');
    writeFixtureFile(
      destination,
      'schema.sql',
      `CREATE TABLE orders(id INTEGER PRIMARY KEY, external_order_id TEXT, items TEXT, total REAL);\n`,
    );
    writeFixtureFile(
      destination,
      'README.md',
      `# Relational order/refund modeling fixture

Normalize orders into immutable purchase facts. Use integer minor currency units (for example \`*_cents\` INTEGER) rather than float. \`orders.external_order_id\` is unique. \`order_lines\` stores immutable purchased description/unit-price/tax snapshots independent of later catalog rename. Refund facts reference a line and database-enforced logic must reject aggregate refunds above that line's purchased amount. Order/payment reconciliation must be queryable from exact line/tax/refund facts.

Write schema + constraints/triggers needed by the SQLite-compatible harness, plus \`.kory-eval/rel-orders.json\` covering JSON/blob migration, compatibility view/API, rollback, duplicate external id, partial-refund limits, historical rename, reconciliation query plan, broader backend-engineering and Redis neighbor boundary.
`,
    );
  },
};
const ordersScorer: SkillEvalDeterministicScorer = {
  id: 'relational-data-modeling/order-refund-facts-scorer@1',
  scenarioIds: [REL_ORDERS],
  score: ({ workingDirectory }) => {
    const hidden = runPython(
      workingDirectory,
      `import sqlite3
db=sqlite3.connect(':memory:');db.executescript(open('schema.sql').read())
tables={r[0] for r in db.execute("select name from sqlite_master where type='table'")}
assert {'orders','order_lines','refunds'} <= tables
ocols={r[1]:r[2].upper() for r in db.execute('pragma table_info(orders)')};lcols={r[1]:r[2].upper() for r in db.execute('pragma table_info(order_lines)')}
assert 'external_order_id' in ocols
money=[c for c in lcols if 'cent' in c or 'minor' in c]
assert money and all('REAL' not in lcols[c] for c in money)
db.execute("insert into orders(id,external_order_id) values(1,'ext-1')")
try:
 db.execute("insert into orders(id,external_order_id) values(2,'ext-1')");raise AssertionError('duplicate external id accepted')
except sqlite3.IntegrityError: pass
desc=next(c for c in lcols if 'description' in c or 'name' in c)
price=next(c for c in lcols if ('cent' in c or 'minor' in c) and ('price' in c or 'amount' in c))
db.execute(f"insert into order_lines(id,order_id,{desc},{price}) values(10,1,'Purchased Name',1000)")
rcols={r[1] for r in db.execute('pragma table_info(refunds)')};amount=next(c for c in rcols if 'cent' in c or 'minor' in c or 'amount' in c);linefk=next(c for c in rcols if 'line' in c)
db.execute(f"insert into refunds(id,{linefk},{amount}) values(1,10,400)")
try:
 db.execute(f"insert into refunds(id,{linefk},{amount}) values(2,10,700)");raise AssertionError('over-refund accepted')
except (sqlite3.IntegrityError,sqlite3.OperationalError): pass
assert db.execute(f"select {desc} from order_lines where id=10").fetchone()[0]=='Purchased Name'
print('order/refund constraints pass')
`,
    );
    const report = artifactText(workingDirectory, '.kory-eval/rel-orders.json');
    const bounded =
      Boolean(report.artifact) &&
      /migration/u.test(report.text) &&
      /compatib/u.test(report.text) &&
      /rollback/u.test(report.text) &&
      /reconcil/u.test(report.text);
    const passed = hidden.passed && bounded;
    return {
      passed,
      quality: passed ? 1 : hidden.passed ? 0.8 : 0,
      verification: hidden.passed ? 1 : 0,
      integrityFailure: false,
      evidence: [
        `normalized monetary/refund constraints: ${hidden.passed ? 'pass' : 'fail'}`,
        `migration/reconciliation evidence: ${bounded ? 'present' : 'missing'}`,
        hidden.evidence,
      ],
    };
  },
};

const PG_QUEUE_SOURCE = `-- PostgreSQL 17.5 synthetic starting query
SELECT id FROM jobs WHERE status = 'queued' ORDER BY priority DESC, id LIMIT 1;
UPDATE jobs SET status = 'running' WHERE id = $1;
`;
const pgQueueMaterializer: SkillEvalFixtureMaterializer = {
  id: 'postgres-engineering/job-claim-sql@2',
  readinessBlockers: [POSTGRES_RUNTIME_BLOCKER],
  matches: (s) => s.id === POSTGRES_QUEUE,
  materialize: (d) => {
    writeFixtureFile(d, 'package.json', packageJson('kory-eval-pg-queue'));
    writeFixtureFile(d, 'claim.sql', PG_QUEUE_SOURCE);
    writeFixtureFile(d, 'tests/.gitkeep', '');
    writeFixtureFile(
      d,
      'README.md',
      `# PostgreSQL concurrent job-claim fixture

Repair \`claim.sql\` for PostgreSQL 17.5 using actual row-lock semantics. One bounded transaction should select the highest-priority available row with \`FOR UPDATE SKIP LOCKED\` (or an equally correct pinned-version pattern), transition claim state, and return it atomically. Do not hold that transaction across external job work. Include explicit claimed-at/lease or recovery metadata so a worker crash after claim becomes retryable without concurrent ownership.

Write \`.kory-eval/postgres-job-claim.json\` with 20-worker simulation, empty queue, crash/retry visibility, transaction/lock duration, representative EXPLAIN/priority behavior, version/schema/isolation identity, broader relational-data-modeling/MySQL neighbor boundary. Do not add a broker.
`,
    );
  },
};
const pgQueueScorer: SkillEvalDeterministicScorer = {
  id: 'postgres-engineering/job-claim-sql-scorer@1',
  scenarioIds: [POSTGRES_QUEUE],
  score: ({ workingDirectory }) => {
    const sql = readFileSync(join(workingDirectory, 'claim.sql'), 'utf8').toLowerCase();
    const structure =
      /for\s+update/u.test(sql) &&
      /skip\s+locked/u.test(sql) &&
      /update/u.test(sql) &&
      /returning/u.test(sql) &&
      /order\s+by/u.test(sql) &&
      /claimed_at|lease|locked_at|attempt/u.test(sql);
    const report = artifactText(workingDirectory, '.kory-eval/postgres-job-claim.json');
    const bounded =
      Boolean(report.artifact) &&
      /17\.5|postgresql 17/u.test(report.text) &&
      /20/u.test(report.text) &&
      /crash|retry/u.test(report.text) &&
      /explain/u.test(report.text) &&
      /transaction|lock/u.test(report.text) &&
      /mysql/u.test(report.text);
    const passed = structure && bounded;
    return {
      passed,
      quality: passed ? 1 : structure ? 0.75 : 0,
      verification: structure && bounded ? 1 : 0,
      integrityFailure: false,
      evidence: [
        `atomic row-lock SQL shape: ${structure ? 'pass' : 'fail'}`,
        `concurrency/recovery/plan evidence: ${bounded ? 'present' : 'missing'}`,
      ],
    };
  },
};

const pgConstraintMaterializer: SkillEvalFixtureMaterializer = {
  id: 'postgres-engineering/not-valid-constraint@2',
  readinessBlockers: [POSTGRES_RUNTIME_BLOCKER],
  matches: (s) => s.id === POSTGRES_CONSTRAINT,
  materialize: (d) => {
    writeFixtureFile(d, 'package.json', packageJson('kory-eval-pg-constraint'));
    writeFixtureFile(
      d,
      'migration.sql',
      `ALTER TABLE child ADD CONSTRAINT child_parent_fk FOREIGN KEY(parent_id) REFERENCES parent(id);\n`,
    );
    writeFixtureFile(d, 'tests/.gitkeep', '');
    writeFixtureFile(
      d,
      'README.md',
      `# PostgreSQL low-blocking integrity migration

Repair \`migration.sql\` for PostgreSQL 17.5. Explicitly identify/repair/quarantine supplied orphan rows first. Add the FK with \`NOT VALID\` so new writes are constrained while old rows await scan, then \`VALIDATE CONSTRAINT\` separately. Bound lock acquisition with local timeout/abort semantics; do not claim syntax alone is nonblocking. Include retry/forward-recovery/rollback strategy.

Write \`.kory-eval/postgres-constraint.json\` with orphan counts, concurrent-invalid-write rejection, measured/synthetic lock modes+durations, validation result, representative plan/statistics, timeout/abort/retry evidence and relational-data-modeling/SQLite neighbor boundary.
`,
    );
  },
};
const pgConstraintScorer: SkillEvalDeterministicScorer = {
  id: 'postgres-engineering/not-valid-constraint-scorer@1',
  scenarioIds: [POSTGRES_CONSTRAINT],
  score: ({ workingDirectory }) => {
    const sql = readFileSync(join(workingDirectory, 'migration.sql'), 'utf8').toLowerCase();
    const structure =
      /not\s+valid/u.test(sql) &&
      /validate\s+constraint/u.test(sql) &&
      /delete|update|quarantine|orphan/u.test(sql) &&
      /lock_timeout|statement_timeout/u.test(sql);
    const report = artifactText(workingDirectory, '.kory-eval/postgres-constraint.json');
    const bounded =
      Boolean(report.artifact) &&
      /17\.5|postgresql 17/u.test(report.text) &&
      /orphan/u.test(report.text) &&
      /concurrent/u.test(report.text) &&
      /lock/u.test(report.text) &&
      /retry|rollback|recovery/u.test(report.text);
    const passed = structure && bounded;
    return {
      passed,
      quality: passed ? 1 : structure ? 0.75 : 0,
      verification: passed ? 1 : 0,
      integrityFailure: false,
      evidence: [
        `Postgres NOT VALID/validate sequence: ${structure ? 'pass' : 'fail'}`,
        `lock/orphan/recovery evidence: ${bounded ? 'present' : 'missing'}`,
      ],
    };
  },
};

const mysqlIndexMaterializer: SkillEvalFixtureMaterializer = {
  id: 'mysql-engineering/online-index-ddl@2',
  readinessBlockers: [MYSQL_RUNTIME_BLOCKER],
  matches: (s) => s.id === MYSQL_INDEX,
  materialize: (d) => {
    writeFixtureFile(d, 'package.json', packageJson('kory-eval-mysql-index'));
    writeFixtureFile(
      d,
      'migration.sql',
      `ALTER TABLE events ADD INDEX idx_events_tenant_created (tenant_id, created_at);\n`,
    );
    writeFixtureFile(d, 'tests/.gitkeep', '');
    writeFixtureFile(
      d,
      'README.md',
      `# MySQL 8 online-index DDL fixture

Repair the migration for the pinned MySQL 8/InnoDB fixture. State exact server minor version, SQL mode, charset/collation and replication topology in evidence. The index DDL must request supported online behavior explicitly (for this fixture \`ALGORITHM=INPLACE\`, \`LOCK=NONE\`) and preflight/abort if long transactions would make metadata-lock acquisition unsafe. Do not add a redundant prefix index.

Write \`.kory-eval/mysql-index.json\` with long-transaction block timing, DDL start/finish metadata locks, write latency, replica lag, abort/recovery, pre/post EXPLAIN, row/selectivity distribution and write/storage cost. Keep PostgreSQL semantics explicitly separate.
`,
    );
  },
};
const mysqlIndexScorer: SkillEvalDeterministicScorer = {
  id: 'mysql-engineering/online-index-ddl-scorer@1',
  scenarioIds: [MYSQL_INDEX],
  score: ({ workingDirectory }) => {
    const sql = readFileSync(join(workingDirectory, 'migration.sql'), 'utf8').toLowerCase();
    const structure =
      /algorithm\s*=\s*inplace/u.test(sql) &&
      /lock\s*=\s*none/u.test(sql) &&
      /add\s+(?:index|key)/u.test(sql);
    const report = artifactText(workingDirectory, '.kory-eval/mysql-index.json');
    const bounded =
      Boolean(report.artifact) &&
      /mysql 8|8\.0/u.test(report.text) &&
      /innodb/u.test(report.text) &&
      /sql.?mode/u.test(report.text) &&
      /collation/u.test(report.text) &&
      /long.*transaction|metadata.*lock/u.test(report.text) &&
      /replica/u.test(report.text) &&
      /explain/u.test(report.text) &&
      /abort|rollback|recover/u.test(report.text);
    const passed = structure && bounded;
    return {
      passed,
      quality: passed ? 1 : structure ? 0.75 : 0,
      verification: passed ? 1 : 0,
      integrityFailure: false,
      evidence: [
        `online DDL shape: ${structure ? 'pass' : 'fail'}`,
        `MySQL-specific lock/plan evidence: ${bounded ? 'present' : 'missing'}`,
      ],
    };
  },
};

const MYSQL_DEADLOCK_SOURCE = `export interface Account{id:string;balance:number}export interface Ledger{transferId:string;from:string;to:string;amount:number}
export class TransferStore{accounts=new Map<string,Account>();ledger=new Map<string,Ledger>();constructor(){this.accounts.set('a',{id:'a',balance:100});this.accounts.set('b',{id:'b',balance:100})}
 transfer(transferId:string,from:string,to:string,amount:number,attempt=1):'ok'|'insufficient'|'retry'{if(this.ledger.has(transferId))return'ok';// BUG: lock acquisition follows caller direction, so a->b and b->a can invert order; logical ledger insert is not transactionally coupled.
const f=this.accounts.get(from)!,t=this.accounts.get(to)!;if(f.balance<amount)return'insufficient';f.balance-=amount;t.balance+=amount;this.ledger.set(transferId,{transferId,from,to,amount});return'ok'}}
`;
const mysqlDeadlockMaterializer: SkillEvalFixtureMaterializer = {
  id: 'mysql-engineering/transfer-deadlock-order@2',
  readinessBlockers: [MYSQL_RUNTIME_BLOCKER],
  matches: (s) => s.id === MYSQL_DEADLOCK,
  materialize: (d) => {
    writeFixtureFile(d, 'package.json', packageJson('kory-eval-mysql-deadlock'));
    writeFixtureFile(d, 'src/transfer.ts', MYSQL_DEADLOCK_SOURCE);
    writeFixtureFile(
      d,
      'tests/transfer.test.ts',
      `import{expect,test}from'bun:test';import{TransferStore}from'../src/transfer';test('transfer',()=>expect(new TransferStore().transfer('t','a','b',10)).toBe('ok'));\n`,
    );
    writeFixtureFile(
      d,
      'README.md',
      `# MySQL transfer deadlock/idempotency fixture

Repair the transfer ownership model: all account rows are acquired in one canonical key order independent of transfer direction, transaction boundaries stay minimal, insufficient funds rolls the whole transfer back, and the ledger idempotency key \`transferId\` prevents duplicate logical effects across bounded deadlock retry. Expose a deterministic lock-order trace or helper that tests can verify.

Add opposite-direction concurrent transfer, insufficient funds, synthetic retryable-deadlock, retry exhaustion and duplicate transfer-id regressions. Write \`.kory-eval/mysql-deadlock.json\` with pinned MySQL/InnoDB isolation/deadlock evidence, canonical row order, max retries/backoff, balance+ledger invariants and SQLite neighbor boundary.
`,
    );
  },
};
const mysqlDeadlockScorer: SkillEvalDeterministicScorer = {
  id: 'mysql-engineering/transfer-deadlock-order-scorer@1',
  scenarioIds: [MYSQL_DEADLOCK],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import{expect,test}from'bun:test';import{TransferStore}from'../src/transfer';
test('hidden: duplicate logical transfer is exactly once',()=>{const s=new TransferStore();expect(s.transfer('x','a','b',10)).toBe('ok');expect(s.transfer('x','a','b',10)).toBe('ok');expect(s.accounts.get('a')!.balance).toBe(90);expect(s.accounts.get('b')!.balance).toBe(110);expect(s.ledger.size).toBe(1);});
test('hidden: insufficient funds leaves all facts unchanged',()=>{const s=new TransferStore();expect(s.transfer('bad','a','b',1000)).toBe('insufficient');expect(s.accounts.get('a')!.balance).toBe(100);expect(s.accounts.get('b')!.balance).toBe(100);expect(s.ledger.size).toBe(0);});
test('hidden: implementation exposes canonical lock ordering independent of direction',()=>{const s:any=new TransferStore();expect(typeof s.lockOrder).toBe('function');expect(s.lockOrder('a','b')).toEqual(s.lockOrder('b','a'));expect(s.lockOrder('a','b')).toEqual(['a','b']);});
`,
    );
    const reg = hasRegressionText(workingDirectory, [
      /deadlock|retry|exhaust/iu,
      /insufficient|rollback/iu,
      /opposite|concurrent|lock.?order/iu,
    ]);
    const report = artifactText(workingDirectory, '.kory-eval/mysql-deadlock.json');
    const passed = hidden.passed && reg && Boolean(report.artifact);
    return {
      passed,
      quality: passed ? 1 : hidden.passed && reg ? 0.85 : hidden.passed ? 0.6 : 0,
      verification: hidden.passed ? 1 : 0,
      integrityFailure: false,
      evidence: [
        `transfer/idempotency/lock order: ${hidden.passed ? 'pass' : 'fail'}`,
        `deadlock/retry regressions: ${reg ? 'present' : 'missing'}`,
        hidden.evidence,
      ],
    };
  },
};

const SQLITE_APP = `import sqlite3
from contextlib import contextmanager

def open_db(path: str):
    db=sqlite3.connect(path, timeout=0.0, isolation_level=None)
    db.execute('PRAGMA journal_mode=WAL')
    # BUG: no busy_timeout/foreign_keys/checkpoint policy.
    return db

@contextmanager
def read_snapshot(db):
    db.execute('BEGIN')
    try:
        yield db.execute('SELECT id,value FROM items ORDER BY id')
    finally:
        # BUG: caller may hold cursor/transaction arbitrarily; transaction is not bounded before yielding results.
        db.execute('COMMIT')
`;
const sqliteWalMaterializer: SkillEvalFixtureMaterializer = {
  id: 'sqlite-engineering/wal-checkpoint-contention@1',
  matches: (s) => s.id === SQLITE_WAL,
  materialize: (d) => {
    writeFixtureFile(d, 'package.json', packageJson('kory-eval-sqlite-wal'));
    writeFixtureFile(d, 'src/__init__.py', '');
    writeFixtureFile(d, 'src/db.py', SQLITE_APP);
    writeFixtureFile(d, 'tests/.gitkeep', '');
    writeFixtureFile(
      d,
      'README.md',
      `# SQLite WAL contention fixture

Repair \`open_db\`/\`read_snapshot\` for the embedded desktop workload. Keep WAL; enable foreign keys; set bounded busy timeout; choose an explicit auto/manual checkpoint policy and document it. Read snapshots should materialize the required rows and end the transaction before returning data so UI/client work cannot hold a read transaction indefinitely. Keep connection count bounded by ownership.

Write \`.kory-eval/sqlite-wal.json\` with SQLite runtime version, journal/busy/checkpoint settings, concurrent reader/writer + long-reader result, bounded retry, WAL-size/checkpoint observations, crash/reopen committed-write proof, file/local-only boundary and MySQL neighbor hierarchy.
`,
    );
  },
};
const sqliteWalScorer: SkillEvalDeterministicScorer = {
  id: 'sqlite-engineering/wal-checkpoint-contention-scorer@2',
  scenarioIds: [SQLITE_WAL],
  score: ({ workingDirectory }) => {
    const hidden = runPython(
      workingDirectory,
      `import os,sys,tempfile,sqlite3
sys.path.insert(0, os.getcwd())
from src.db import open_db,read_snapshot
fd,path=tempfile.mkstemp();os.close(fd)
try:
 db=open_db(path);db.execute('create table items(id integer primary key,value text)');db.execute("insert into items(value) values('a')")
 assert db.execute('pragma journal_mode').fetchone()[0].lower()=='wal'
 assert db.execute('pragma foreign_keys').fetchone()[0]==1
 assert db.execute('pragma busy_timeout').fetchone()[0]>=250
 rows=read_snapshot(db)
 assert isinstance(rows,(list,tuple)), type(rows)
 db.close();db=open_db(path);assert db.execute('select count(*) from items').fetchone()[0]==1;db.close()
 print('wal config/reopen pass')
finally:
 for suffix in ['', '-wal','-shm']:
  try: os.unlink(path+suffix)
  except FileNotFoundError: pass
`,
    );
    const report = artifactText(workingDirectory, '.kory-eval/sqlite-wal.json');
    const bounded =
      Boolean(report.artifact) &&
      /wal/u.test(report.text) &&
      /busy/u.test(report.text) &&
      /checkpoint/u.test(report.text) &&
      /reader/u.test(report.text) &&
      /writer/u.test(report.text) &&
      /reopen|crash/u.test(report.text);
    const passed = hidden.passed && bounded;
    return {
      passed,
      quality: passed ? 1 : hidden.passed ? 0.8 : 0,
      verification: hidden.passed ? 1 : 0,
      integrityFailure: false,
      evidence: [
        `SQLite WAL runtime config: ${hidden.passed ? 'pass' : 'fail'}`,
        `contention/reopen evidence: ${bounded ? 'present' : 'missing'}`,
        hidden.evidence,
      ],
    };
  },
};

const SQLITE_MIGRATION_SOURCE = `import sqlite3

def migrate(db: sqlite3.Connection) -> None:
    # BUG: direct DROP COLUMN is not version-portable for the supported old runtime fixture and does not preserve dependent objects.
    db.execute('ALTER TABLE widgets DROP COLUMN legacy')
    db.execute('ALTER TABLE widgets ADD COLUMN score INTEGER CHECK(score >= 0)')
`;
const sqliteMigrationMaterializer: SkillEvalFixtureMaterializer = {
  id: 'sqlite-engineering/copy-table-migration@1',
  matches: (s) => s.id === SQLITE_MIGRATION,
  materialize: (d) => {
    writeFixtureFile(d, 'package.json', packageJson('kory-eval-sqlite-migration'));
    writeFixtureFile(d, 'src/__init__.py', '');
    writeFixtureFile(d, 'src/migration.py', SQLITE_MIGRATION_SOURCE);
    writeFixtureFile(d, 'tests/.gitkeep', '');
    writeFixtureFile(
      d,
      'README.md',
      `# SQLite copy-table migration fixture

Repair \`migrate\` as an atomic copy-table migration compatible with the supplied older SQLite path: begin transaction, create new table with stricter CHECK and without legacy column, handle invalid legacy rows explicitly (reject/quarantine according to the documented fixture policy), copy valid rows, recreate supplied indexes/triggers, swap tables, run foreign-key integrity validation, commit only when all steps pass. On interruption/error rollback leaves the old schema/data intact.

Write \`.kory-eval/sqlite-migration.json\` with runtime-version branch, preserved index/trigger/FK inventory, bad-row decision, success/constraint/interruption/downgrade tests, \`foreign_key_check\`, recovery/backup boundary and Postgres neighbor hierarchy.
`,
    );
  },
};
const sqliteMigrationScorer: SkillEvalDeterministicScorer = {
  id: 'sqlite-engineering/copy-table-migration-scorer@2',
  scenarioIds: [SQLITE_MIGRATION],
  score: ({ workingDirectory }) => {
    const hidden = runPython(
      workingDirectory,
      `import os,sys,sqlite3
sys.path.insert(0, os.getcwd())
from src.migration import migrate
db=sqlite3.connect(':memory:');db.execute('pragma foreign_keys=on');db.executescript('create table parents(id integer primary key);create table widgets(id integer primary key,parent_id integer references parents(id),legacy text,score integer);create index idx_widgets_parent on widgets(parent_id);create table audit(msg text);create trigger trg_widgets after insert on widgets begin insert into audit(msg) values(new.id);end;insert into parents values(1);insert into widgets values(1,1,"old",5);')
migrate(db)
cols=[r[1] for r in db.execute('pragma table_info(widgets)')];assert 'legacy' not in cols and 'score' in cols
assert any(r[1]=='idx_widgets_parent' for r in db.execute('pragma index_list(widgets)'))
assert any(r[0]=='trg_widgets' for r in db.execute("select name from sqlite_master where type='trigger'"))
assert list(db.execute('pragma foreign_key_check'))==[]
try: db.execute('insert into widgets(id,parent_id,score) values(2,1,-1)');raise AssertionError('CHECK missing')
except sqlite3.IntegrityError: pass
print('copy migration pass')
`,
    );
    const reg = hasRegressionText(workingDirectory, [
      /interrupt|rollback|old.?schema|downgrade/iu,
      /foreign_key_check|constraint|bad/iu,
    ]);
    const report = artifactText(workingDirectory, '.kory-eval/sqlite-migration.json');
    const passed = hidden.passed && reg && Boolean(report.artifact);
    return {
      passed,
      quality: passed ? 1 : hidden.passed && reg ? 0.85 : hidden.passed ? 0.6 : 0,
      verification: hidden.passed ? 1 : 0,
      integrityFailure: false,
      evidence: [
        `copy-table migration behavior: ${hidden.passed ? 'pass' : 'fail'}`,
        `rollback/integrity regressions: ${reg ? 'present' : 'missing'}`,
        hidden.evidence,
      ],
    };
  },
};

const MONGO_SOURCE = `export interface Item{id:string;value:string}export interface Doc{id:string;version:number;items:Item[]}
export class MongoLikeStore{doc:Doc={id:'d',version:1,items:[]};read(){return structuredClone(this.doc)}addFromSnapshot(snapshot:Doc,item:Item):'ok'|'duplicate'|'stale'{if(snapshot.items.some(x=>x.id===item.id))return'duplicate';// BUG: stale read-modify-write replaces the entire array and silently loses concurrent changes.
this.doc={...snapshot,version:snapshot.version+1,items:[...snapshot.items,item]};return'ok'}removeFromSnapshot(snapshot:Doc,itemId:string):'ok'|'stale'{this.doc={...snapshot,version:snapshot.version+1,items:snapshot.items.filter(x=>x.id!==itemId)};return'ok'}}
export interface IndexSpec{keys:Array<[string,1|-1]>;partialUnresolved?:boolean}
export function explainRecentUnresolved(spec:IndexSpec,tenantDocs:number,unresolvedDocs:number){const names=spec.keys.map(x=>x[0]);const ideal=names[0]==='tenantId'&&names.includes('resolved')&&names.at(-1)==='createdAt';const sortCovered=ideal&&spec.keys.find(x=>x[0]==='createdAt')?.[1]===-1;const examined=ideal?Math.max(unresolvedDocs,20):tenantDocs;return{examined,returned:Math.min(unresolvedDocs,100),sortCovered,writeCost:spec.keys.length};}
`;
const mongoUpdateMaterializer: SkillEvalFixtureMaterializer = {
  id: 'mongodb-engineering/atomic-array-update@2',
  readinessBlockers: [MONGODB_RUNTIME_BLOCKER],
  matches: (s) => s.id === MONGO_UPDATE,
  materialize: (d) => {
    writeFixtureFile(d, 'package.json', packageJson('kory-eval-mongo-update'));
    writeFixtureFile(d, 'src/mongo.ts', MONGO_SOURCE);
    writeFixtureFile(
      d,
      'tests/mongo.test.ts',
      `import{expect,test}from'bun:test';import{MongoLikeStore}from'../src/mongo';test('add',()=>{const s=new MongoLikeStore();expect(s.addFromSnapshot(s.read(),{id:'a',value:'A'})).toBe('ok');});\n`,
    );
    writeFixtureFile(
      d,
      'README.md',
      `# MongoDB document-level atomic update fixture

Repair the store to model the narrow MongoDB atomicity required: concurrent legitimate item add/remove must not replace the entire array from a stale snapshot. Use stable item id, atomic filtered update/version precondition semantics, and make stale-version outcomes explicit/retryable. Duplicate item id is rejected/idempotent. Do not add a relational database or a multi-document transaction when the invariant is document-local.

Add two-stale-snapshot add/remove, duplicate id, transient retry and stale-version regressions. Write \`.kory-eval/mongodb-update.json\` with pinned MongoDB/read-write concern, dominant access pattern, document growth bound, representative index/explain evidence and Redis neighbor hierarchy.
`,
    );
  },
};
const mongoUpdateScorer: SkillEvalDeterministicScorer = {
  id: 'mongodb-engineering/atomic-array-update-scorer@1',
  scenarioIds: [MONGO_UPDATE],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import{expect,test}from'bun:test';import{MongoLikeStore}from'../src/mongo';
test('hidden: stale concurrent adds cannot lose a committed item',()=>{const s=new MongoLikeStore();const a=s.read(),b=s.read();expect(s.addFromSnapshot(a,{id:'a',value:'A'})).toBe('ok');expect(s.addFromSnapshot(b,{id:'b',value:'B'})).toBe('stale');const fresh=s.read();expect(s.addFromSnapshot(fresh,{id:'b',value:'B'})).toBe('ok');expect(s.doc.items.map(x=>x.id).sort()).toEqual(['a','b']);});
test('hidden: duplicate id and stale remove are explicit',()=>{const s=new MongoLikeStore();s.addFromSnapshot(s.read(),{id:'a',value:'A'});expect(s.addFromSnapshot(s.read(),{id:'a',value:'again'})).toBe('duplicate');const stale={id:'d',version:1,items:[]};expect(s.removeFromSnapshot(stale,'a')).toBe('stale');expect(s.doc.items).toHaveLength(1);});
`,
    );
    const reg = hasRegressionText(workingDirectory, [
      /stale|version|concurr/iu,
      /duplicate|retry/iu,
    ]);
    const report = artifactText(workingDirectory, '.kory-eval/mongodb-update.json');
    const passed = hidden.passed && reg && Boolean(report.artifact);
    return {
      passed,
      quality: passed ? 1 : hidden.passed && reg ? 0.85 : hidden.passed ? 0.6 : 0,
      verification: hidden.passed ? 1 : 0,
      integrityFailure: false,
      evidence: [
        `Mongo atomic update behavior: ${hidden.passed ? 'pass' : 'fail'}`,
        `stale/retry regressions: ${reg ? 'present' : 'missing'}`,
        hidden.evidence,
      ],
    };
  },
};

const mongoIndexMaterializer: SkillEvalFixtureMaterializer = {
  id: 'mongodb-engineering/skewed-compound-index@2',
  readinessBlockers: [MONGODB_RUNTIME_BLOCKER],
  matches: (s) => s.id === MONGO_INDEX,
  materialize: (d) => {
    writeFixtureFile(d, 'package.json', packageJson('kory-eval-mongo-index'));
    writeFixtureFile(d, 'src/mongo.ts', MONGO_SOURCE);
    writeFixtureFile(d, 'tests/.gitkeep', '');
    writeFixtureFile(
      d,
      'README.md',
      `# MongoDB skewed recent-alert index fixture

Write \`.kory-eval/mongo-index.json\` as \`IndexSpec\` for the query \`tenantId = ? AND resolved = false ORDER BY createdAt DESC LIMIT 100\`. The high-volume tenant has 1,000,000 documents and 2,000 unresolved. Equality tenant comes first, then the status predicate/partial strategy, then descending time so sort is covered. Do not lead with the globally low-cardinality resolved field.

Write \`.kory-eval/mongo-index-evidence.json\` with before/after examined/returned, sort coverage, representative tenant skew, write/storage amplification, neighboring query regressions, document growth/read-write concern, explain evidence and relational-data-modeling neighbor boundary.
`,
    );
  },
};
const mongoIndexScorer: SkillEvalDeterministicScorer = {
  id: 'mongodb-engineering/skewed-compound-index-scorer@1',
  scenarioIds: [MONGO_INDEX],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import{expect,test}from'bun:test';import{readFileSync}from'node:fs';import{explainRecentUnresolved,type IndexSpec}from'../src/mongo';const s=JSON.parse(readFileSync('.kory-eval/mongo-index.json','utf8')) as IndexSpec;test('hidden: representative skew gets covered selective scan',()=>{const e=explainRecentUnresolved(s,1_000_000,2_000);expect(e.sortCovered).toBe(true);expect(e.examined).toBeLessThanOrEqual(5000);expect(e.writeCost).toBeLessThanOrEqual(4);expect(s.keys[0][0]).toBe('tenantId');});\n`,
    );
    const ev = artifactText(workingDirectory, '.kory-eval/mongo-index-evidence.json');
    const bounded =
      Boolean(ev.artifact) &&
      /explain/u.test(ev.text) &&
      /1,?000,?000|million/u.test(ev.text) &&
      /write|storage/u.test(ev.text) &&
      /neighbor/u.test(ev.text);
    const passed = hidden.passed && bounded;
    return {
      passed,
      quality: passed ? 1 : hidden.passed ? 0.8 : 0,
      verification: hidden.passed ? 1 : 0,
      integrityFailure: false,
      evidence: [
        `compound index simulation: ${hidden.passed ? 'pass' : 'fail'}`,
        `cost/regression evidence: ${bounded ? 'present' : 'missing'}`,
        hidden.evidence,
      ],
    };
  },
};

const REDIS_SOURCE = `export interface Lock{owner:string;expiresAt:number}export class RedisLockSim{lock:Lock|null=null;acquire(owner:string,now:number,ttl:number){if(this.lock&&this.lock.expiresAt>now)return false;this.lock={owner,expiresAt:now+ttl};return true}release(owner:string){// BUG: release ignores current ownership token.
if(this.lock)this.lock=null;return true}renew(owner:string,now:number,ttl:number){if(!this.lock)return false;this.lock.expiresAt=now+ttl;return true}}
export interface Message{id:string;attempts:number;acked:boolean;pendingSince:number;poison?:boolean}export class StreamGroup{messages=new Map<string,Message>();effects=new Set<string>();dlq:string[]=[];add(m:Message){this.messages.set(m.id,{...m})}process(id:string,now:number,crashAfterEffect=false){const m=this.messages.get(id)!;if(m.poison){m.attempts++;if(m.attempts>=3){this.dlq.push(id);m.acked=true}return}if(!this.effects.has(id))this.effects.add(id);if(crashAfterEffect)throw new Error('crash');m.acked=true}claimIdle(id:string,now:number,minIdle:number){const m=this.messages.get(id)!;if(m.acked||now-m.pendingSince<minIdle)return false;m.pendingSince=now;m.attempts++;return true}}
`;
const redisLockMaterializer: SkillEvalFixtureMaterializer = {
  id: 'redis-engineering/owned-refresh-lock@1',
  matches: (s) => s.id === REDIS_LOCK,
  materialize: (d) => {
    writeFixtureFile(d, 'package.json', packageJson('kory-eval-redis-lock'));
    writeFixtureFile(d, 'src/redis.ts', REDIS_SOURCE);
    writeFixtureFile(
      d,
      'tests/redis.test.ts',
      `import{expect,test}from'bun:test';import{RedisLockSim}from'../src/redis';test('acquire',()=>expect(new RedisLockSim().acquire('a',0,10)).toBe(true));\n`,
    );
    writeFixtureFile(
      d,
      'README.md',
      `# Redis refresh-lock ownership fixture

Repair release/renewal as atomic compare-owner operations. A worker may lose authority when TTL expires; after a newer owner acquires, stale release/renew from the old token must fail and never erase/extend the new owner's lock. Renewal requires current owner and non-expired authority. Bound TTL/renew failures; lock coordinates cache refresh but is not distributed consensus or source-of-truth correctness.

Add expiry/paused-worker/new-owner, stale release, stale renewal, Redis error/failover and cache-correctness regressions. Write \`.kory-eval/redis-lock.json\` with pinned deployment semantics, atomic-script/transaction equivalent, owner-token lifecycle, expiry assumptions and MongoDB neighbor boundary.
`,
    );
  },
};
const redisLockScorer: SkillEvalDeterministicScorer = {
  id: 'redis-engineering/owned-refresh-lock-scorer@1',
  scenarioIds: [REDIS_LOCK],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import{expect,test}from'bun:test';import{RedisLockSim}from'../src/redis';
test('hidden: stale owner cannot erase newer owner',()=>{const r=new RedisLockSim();expect(r.acquire('a',0,10)).toBe(true);expect(r.acquire('b',11,10)).toBe(true);expect(r.release('a')).toBe(false);expect(r.lock?.owner).toBe('b');expect(r.renew('a',12,10)).toBe(false);expect(r.lock?.owner).toBe('b');expect(r.release('b')).toBe(true);expect(r.lock).toBeNull();});
test('hidden: expired owner cannot renew itself back into authority',()=>{const r=new RedisLockSim();r.acquire('a',0,10);expect(r.renew('a',11,10)).toBe(false);});
`,
    );
    const reg = hasRegressionText(workingDirectory, [
      /expire|paused|stale/iu,
      /failover|error|renew|release/iu,
    ]);
    const report = artifactText(workingDirectory, '.kory-eval/redis-lock.json');
    const passed = hidden.passed && reg && Boolean(report.artifact);
    return {
      passed,
      quality: passed ? 1 : hidden.passed && reg ? 0.85 : hidden.passed ? 0.6 : 0,
      verification: hidden.passed ? 1 : 0,
      integrityFailure: false,
      evidence: [
        `Redis ownership token behavior: ${hidden.passed ? 'pass' : 'fail'}`,
        `expiry/failure regressions: ${reg ? 'present' : 'missing'}`,
        hidden.evidence,
      ],
    };
  },
};

const redisStreamMaterializer: SkillEvalFixtureMaterializer = {
  id: 'redis-engineering/streams-pending-recovery@1',
  matches: (s) => s.id === REDIS_STREAM,
  materialize: (d) => {
    writeFixtureFile(d, 'package.json', packageJson('kory-eval-redis-stream'));
    writeFixtureFile(d, 'src/redis.ts', REDIS_SOURCE);
    writeFixtureFile(d, 'tests/.gitkeep', '');
    writeFixtureFile(
      d,
      'README.md',
      `# Redis Streams pending recovery fixture

Repair/qualify the group with stable message identity and idempotent external effects. Acknowledgement comes only after durable logical effect. Crash after effect before ACK leaves pending; another worker claims only after bounded idle age and replay observes the stable idempotency record so the effect is not repeated. Poison messages have bounded attempts then DLQ/ack policy; removed consumers' idle pending entries remain reclaimable/observable.

Add crash before/after effect, duplicate claim, idle threshold, consumer removal, poison/DLQ regressions. Write \`.kory-eval/redis-stream.json\` with at-least-once transport/logically-once effect distinction, pending metrics/claim age, retry/DLQ bounds, reconnect/failover assumptions and relational-data-modeling neighbor boundary.
`,
    );
  },
};
const redisStreamScorer: SkillEvalDeterministicScorer = {
  id: 'redis-engineering/streams-pending-recovery-scorer@1',
  scenarioIds: [REDIS_STREAM],
  score: ({ workingDirectory }) => {
    const hidden = runHiddenBunTest(
      workingDirectory,
      `import{expect,test}from'bun:test';import{StreamGroup}from'../src/redis';
test('hidden: crash after effect before ack then claim/replay does not duplicate',()=>{const g=new StreamGroup();g.add({id:'m',attempts:0,acked:false,pendingSince:0});expect(()=>g.process('m',0,true)).toThrow();expect(g.effects.size).toBe(1);expect(g.claimIdle('m',5,10)).toBe(false);expect(g.claimIdle('m',11,10)).toBe(true);g.process('m',11);expect(g.effects.size).toBe(1);expect(g.messages.get('m')?.acked).toBe(true);});
test('hidden: poison bounded to DLQ',()=>{const g=new StreamGroup();g.add({id:'bad',attempts:0,acked:false,pendingSince:0,poison:true});g.process('bad',0);g.process('bad',1);g.process('bad',2);expect(g.dlq).toEqual(['bad']);expect(g.messages.get('bad')?.acked).toBe(true);});
`,
    );
    const reg = hasRegressionText(workingDirectory, [
      /crash|pending|claim|idle/iu,
      /poison|dlq|dead/iu,
      /duplicate|idempoten/iu,
    ]);
    const report = artifactText(workingDirectory, '.kory-eval/redis-stream.json');
    const passed = hidden.passed && reg && Boolean(report.artifact);
    return {
      passed,
      quality: passed ? 1 : hidden.passed && reg ? 0.85 : hidden.passed ? 0.6 : 0,
      verification: hidden.passed ? 1 : 0,
      integrityFailure: false,
      evidence: [
        `Redis Streams replay/DLQ behavior: ${hidden.passed ? 'pass' : 'fail'}`,
        `pending/idempotency regressions: ${reg ? 'present' : 'missing'}`,
        hidden.evidence,
      ],
    };
  },
};

export const DATABASE_SKILL_EVAL_MATERIALIZERS: readonly SkillEvalFixtureMaterializer[] = [
  membershipMaterializer,
  ordersMaterializer,
  pgQueueMaterializer,
  pgConstraintMaterializer,
  mysqlIndexMaterializer,
  mysqlDeadlockMaterializer,
  sqliteWalMaterializer,
  sqliteMigrationMaterializer,
  mongoUpdateMaterializer,
  mongoIndexMaterializer,
  redisLockMaterializer,
  redisStreamMaterializer,
];
export const DATABASE_SKILL_EVAL_SCORERS: readonly SkillEvalDeterministicScorer[] = [
  membershipScorer,
  ordersScorer,
  pgQueueScorer,
  pgConstraintScorer,
  mysqlIndexScorer,
  mysqlDeadlockScorer,
  sqliteWalScorer,
  sqliteMigrationScorer,
  mongoUpdateScorer,
  mongoIndexScorer,
  redisLockScorer,
  redisStreamScorer,
];
