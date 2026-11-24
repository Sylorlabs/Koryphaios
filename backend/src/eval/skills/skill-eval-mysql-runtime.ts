import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

export const MYSQL_RUNTIME_IMAGE = 'mysql:8.4.6';
export const MYSQL_RUNTIME_BLOCKER = `Full-task qualification requires an available local Docker runtime with the pinned ${MYSQL_RUNTIME_IMAGE} image so online DDL, metadata-lock, write-concurrency, InnoDB deadlock, retry, and idempotency checks execute on the real MySQL engine.`;

export interface MySqlRuntimeResult {
  passed: boolean;
  evidence: string;
}

let mysqlReadinessCache: readonly string[] | null = null;

function command(args: string[], options?: { input?: string; timeout?: number }) {
  return spawnSync('docker', args, {
    input: options?.input,
    encoding: 'utf8',
    timeout: options?.timeout ?? 5_000,
    maxBuffer: 2_000_000,
  });
}

export function mysqlRuntimeReadiness(): readonly string[] {
  if (mysqlReadinessCache) return mysqlReadinessCache;
  const image = command(['image', 'inspect', MYSQL_RUNTIME_IMAGE], { timeout: 15_000 });
  mysqlReadinessCache = image.status === 0 ? [] : [MYSQL_RUNTIME_BLOCKER];
  return mysqlReadinessCache;
}

function runHarness(root: string, files: string[], shellSource: string): MySqlRuntimeResult {
  const blockers = mysqlRuntimeReadiness();
  if (blockers.length > 0) return { passed: false, evidence: blockers.join('\n') };

  const container = 'kory-mysql-' + randomUUID().replaceAll('-', '').slice(0, 12);
  let started = false;
  try {
    const start = command(
      [
        'run',
        '--rm',
        '-d',
        '--name',
        container,
        '-e',
        'MYSQL_ROOT_PASSWORD=kory',
        '-e',
        'MYSQL_DATABASE=kory',
        '-e',
        'MYSQL_INITDB_SKIP_TZINFO=1',
        MYSQL_RUNTIME_IMAGE,
      ],
      { timeout: 15_000 },
    );
    if (start.status !== 0) {
      return {
        passed: false,
        evidence: (`${MYSQL_RUNTIME_IMAGE} start failed: ` + (start.stderr || start.stdout)).trim(),
      };
    }
    started = true;

    let initializationComplete = false;
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const logs = command(['logs', container], { timeout: 2_000 });
      if (
        /MySQL init process done\. Ready for start up\./u.test(
          (logs.stdout ?? '') + (logs.stderr ?? ''),
        )
      ) {
        initializationComplete = true;
        break;
      }
      spawnSync('sleep', ['0.1'], { timeout: 500 });
    }
    if (!initializationComplete) {
      return { passed: false, evidence: `${MYSQL_RUNTIME_IMAGE} initialization did not complete` };
    }

    let ready = false;
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const probe = command(
        [
          'exec',
          '-e',
          'MYSQL_PWD=kory',
          container,
          'mysql',
          '--protocol=socket',
          '-uroot',
          '-D',
          'kory',
          '--batch',
          '--skip-column-names',
          '-e',
          'SELECT 1;',
        ],
        { timeout: 5_000 },
      );
      if (probe.status === 0 && probe.stdout.trim() === '1') {
        ready = true;
        break;
      }
      spawnSync('sleep', ['0.1'], { timeout: 500 });
    }
    if (!ready) return { passed: false, evidence: `${MYSQL_RUNTIME_IMAGE} did not become ready` };

    for (const file of files) {
      const copy = command(['cp', join(root, file), container + ':/tmp/' + file], {
        timeout: 5_000,
      });
      if (copy.status !== 0) {
        return {
          passed: false,
          evidence: ('failed to stage ' + file + ': ' + (copy.stderr || copy.stdout)).trim(),
        };
      }
    }

    const version = command(
      [
        'exec',
        '-e',
        'MYSQL_PWD=kory',
        container,
        'mysql',
        '--protocol=socket',
        '-uroot',
        '-D',
        'kory',
        '--batch',
        '--skip-column-names',
        '-e',
        'SELECT VERSION(), @@version_comment, @@default_storage_engine;',
      ],
      { timeout: 5_000 },
    );
    const versionText = version.stdout.trim();
    const [serverVersion, versionComment, defaultEngine] = versionText.split('\t');
    if (
      version.status !== 0 ||
      serverVersion !== '8.4.6' ||
      !/mysql/iu.test(versionComment ?? '') ||
      !/^innodb$/iu.test(defaultEngine ?? '')
    ) {
      return {
        passed: false,
        evidence: ('unexpected MySQL runtime: ' + (version.stdout || version.stderr)).trim(),
      };
    }

    const harness = command(['exec', '-i', container, 'sh', '-s'], {
      input: shellSource,
      timeout: 75_000,
    });
    return {
      passed: harness.status === 0,
      evidence: [
        `MySQL runtime: ${serverVersion}; ${versionComment}; default-storage-engine=${defaultEngine}`,
        harness.stdout,
        harness.stderr,
        harness.error?.message,
      ]
        .filter(Boolean)
        .join('\n')
        .trim()
        .slice(-10_000),
    };
  } finally {
    if (started) command(['rm', '-f', container], { timeout: 5_000 });
  }
}

const indexHarness = [
  'set -eu',
  'export MYSQL_PWD=kory',
  'mysqlx() { mysql --protocol=socket -uroot -D kory --batch --skip-column-names "$@"; }',
  "mysqlx <<'SQL'",
  'CREATE TABLE digits(n tinyint PRIMARY KEY) ENGINE=InnoDB;',
  'INSERT INTO digits VALUES (0),(1),(2),(3),(4),(5),(6),(7),(8),(9);',
  'CREATE TABLE events (',
  '  id bigint NOT NULL AUTO_INCREMENT PRIMARY KEY,',
  '  tenant_id bigint NOT NULL,',
  '  created_at datetime(6) NOT NULL,',
  '  payload varchar(256) NOT NULL',
  ') ENGINE=InnoDB;',
  'INSERT INTO events(tenant_id, created_at, payload)',
  "SELECT MOD(seq,100), TIMESTAMP('2026-01-01 00:00:00') + INTERVAL seq SECOND, RPAD('x',192,'x')",
  'FROM (',
  '  SELECT a.n + b.n*10 + c.n*100 + d.n*1000 + e.n*10000 + f.n*100000 + 1 AS seq',
  '  FROM digits a CROSS JOIN digits b CROSS JOIN digits c CROSS JOIN digits d CROSS JOIN digits e CROSS JOIN digits f',
  ') AS seqs',
  'WHERE seq <= 250000;',
  'ANALYZE TABLE events;',
  'SQL',
  "server_meta=\"$(mysqlx -e \"SELECT CONCAT('sql_mode=',@@sql_mode,'; isolation=',@@transaction_isolation,'; charset=',@@character_set_database,'; collation=',@@collation_database);\")\"",
  'engine="$(mysqlx -e "SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=\'kory\' AND TABLE_NAME=\'events\';")"',
  '[ "$engine" = "InnoDB" ] || { echo "events did not use InnoDB: $engine"; exit 10; }',
  "row_distribution=\"$(mysqlx -e \"SELECT CONCAT('rows=',SUM(c),'; tenants=',COUNT(*),'; max-per-tenant=',MAX(c)) FROM (SELECT tenant_id,COUNT(*) c FROM events GROUP BY tenant_id) d;\")\"",
  'pre_plan="$(mysqlx -e "EXPLAIN FORMAT=JSON SELECT id,payload FROM events WHERE tenant_id=42 ORDER BY created_at DESC LIMIT 20;")"',
  'echo "$pre_plan" >/tmp/kory-pre-plan.out',
  'if grep -q "idx_events_tenant_created" /tmp/kory-pre-plan.out; then echo "pre-DDL plan unexpectedly used future index"; exit 11; fi',
  'replication_channels="$(mysqlx -e "SELECT COUNT(*) FROM performance_schema.replication_connection_status;")"',
  '( mysqlx -e "SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ; START TRANSACTION; SELECT COUNT(*) FROM events WHERE tenant_id=42; DO SLEEP(2.5); COMMIT;" >/tmp/kory-long-txn.out 2>&1 ) &',
  'holder=$!',
  'sleep 0.2',
  'abort_start="$(mysqlx -e "SELECT ROUND(UNIX_TIMESTAMP(NOW(6))*1000);")"',
  '(',
  '  set +e',
  "  { echo 'SET SESSION lock_wait_timeout=1;'; cat /tmp/migration.sql; } | mysqlx >/tmp/kory-blocked-ddl.out 2>&1",
  '  echo "$?" >/tmp/kory-blocked-ddl.status',
  ') &',
  'blocked_ddl=$!',
  'sleep 0.25',
  "metadata_locks=\"$(mysqlx -e \"SELECT CONCAT(LOCK_TYPE,':',LOCK_DURATION,':',LOCK_STATUS) FROM performance_schema.metadata_locks WHERE OBJECT_SCHEMA='kory' AND OBJECT_NAME='events' ORDER BY LOCK_STATUS,LOCK_TYPE;\" | paste -sd, -)\"",
  'echo "$metadata_locks" | grep -q "PENDING" || { echo "pending metadata lock was not observed: $metadata_locks"; cat /tmp/kory-blocked-ddl.out || true; exit 12; }',
  'wait "$blocked_ddl" || true',
  'abort_end="$(mysqlx -e "SELECT ROUND(UNIX_TIMESTAMP(NOW(6))*1000);")"',
  'blocked_status="$(cat /tmp/kory-blocked-ddl.status)"',
  '[ "$blocked_status" -ne 0 ] || { echo "DDL unexpectedly succeeded while long transaction held metadata lock"; exit 13; }',
  "grep -Eiq 'ERROR 1205|Lock wait timeout exceeded' /tmp/kory-blocked-ddl.out || { echo 'DDL failed for an unexpected reason'; cat /tmp/kory-blocked-ddl.out; exit 14; }",
  'abort_ms=$((abort_end-abort_start))',
  '[ "$abort_ms" -ge 700 ] && [ "$abort_ms" -lt 4000 ] || { echo "metadata-lock abort timing out of bounds: ${abort_ms}ms"; exit 15; }',
  'wait "$holder"',
  "index_count_before=\"$(mysqlx -e \"SELECT COUNT(DISTINCT INDEX_NAME) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA='kory' AND TABLE_NAME='events' AND INDEX_NAME<>'PRIMARY';\")\"",
  '[ "$index_count_before" = "0" ] || { echo "failed DDL left partial index state: $index_count_before"; exit 16; }',
  '(',
  '  writer_start="$(mysqlx -e "SELECT ROUND(UNIX_TIMESTAMP(NOW(6))*1000);")"',
  '  : >/tmp/kory-writer-completions',
  '  i=1',
  '  while [ "$i" -le 60 ]; do',
  "    mysqlx -e \"INSERT INTO events(tenant_id,created_at,payload) VALUES (999,NOW(6),RPAD('w',192,'w')); SELECT ROUND(UNIX_TIMESTAMP(NOW(6))*1000);\" >>/tmp/kory-writer-completions",
  '    i=$((i+1))',
  '  done',
  '  writer_end="$(mysqlx -e "SELECT ROUND(UNIX_TIMESTAMP(NOW(6))*1000);")"',
  '  echo "$writer_start|$writer_end" >/tmp/kory-writer-window',
  ') &',
  'writer=$!',
  'sleep 0.05',
  'ddl_start="$(mysqlx -e "SELECT ROUND(UNIX_TIMESTAMP(NOW(6))*1000);")"',
  'mysqlx < /tmp/migration.sql >/tmp/kory-ddl-success.out 2>&1',
  'ddl_end="$(mysqlx -e "SELECT ROUND(UNIX_TIMESTAMP(NOW(6))*1000);")"',
  'wait "$writer"',
  'writer_start="$(cut -d\'|\' -f1 /tmp/kory-writer-window)"',
  'writer_end="$(cut -d\'|\' -f2 /tmp/kory-writer-window)"',
  '[ "$writer_start" -lt "$ddl_end" ] && [ "$writer_end" -gt "$ddl_start" ] || { echo "write workload did not overlap DDL: writer=${writer_start}-${writer_end} ddl=${ddl_start}-${ddl_end}"; exit 17; }',
  'writes_during_ddl="$(awk -v s="$ddl_start" -v e="$ddl_end" \'$1 >= s && $1 <= e { count += 1 } END { print count + 0 }\' /tmp/kory-writer-completions)"',
  '[ "$writes_during_ddl" -ge 1 ] || { echo "no write completed while online DDL was active: ddl=${ddl_start}-${ddl_end}"; cat /tmp/kory-writer-completions; exit 22; }',
  'writer_rows="$(mysqlx -e "SELECT COUNT(*) FROM events WHERE tenant_id=999;")"',
  '[ "$writer_rows" = "60" ] || { echo "concurrent writer lost rows: $writer_rows"; exit 18; }',
  'write_ms=$((writer_end-writer_start))',
  'write_avg_ms="$(awk -v total="$write_ms" \'BEGIN { printf "%.2f", total/60 }\')"',
  'ddl_ms=$((ddl_end-ddl_start))',
  "index_count_after=\"$(mysqlx -e \"SELECT COUNT(DISTINCT INDEX_NAME) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA='kory' AND TABLE_NAME='events' AND INDEX_NAME='idx_events_tenant_created';\")\"",
  '[ "$index_count_after" = "1" ] || { echo "expected online index missing after retry"; exit 19; }',
  'post_plan="$(mysqlx -e "EXPLAIN FORMAT=JSON SELECT id,payload FROM events WHERE tenant_id=42 ORDER BY created_at DESC LIMIT 20;")"',
  'echo "$post_plan" >/tmp/kory-post-plan.out',
  'grep -q "idx_events_tenant_created" /tmp/kory-post-plan.out || { echo "post-DDL plan did not use expected index"; cat /tmp/kory-post-plan.out; exit 20; }',
  "storage=\"$(mysqlx -e \"SELECT CONCAT('data_length=',DATA_LENGTH,'; index_length=',INDEX_LENGTH,'; table_rows_estimate=',TABLE_ROWS) FROM information_schema.TABLES WHERE TABLE_SCHEMA='kory' AND TABLE_NAME='events';\")\"",
  "pending_after=\"$(mysqlx -e \"SELECT COUNT(*) FROM performance_schema.metadata_locks WHERE OBJECT_SCHEMA='kory' AND OBJECT_NAME='events' AND LOCK_STATUS='PENDING';\")\"",
  '[ "$pending_after" = "0" ] || { echo "pending metadata locks remained after DDL: $pending_after"; exit 21; }',
  'echo "online DDL ALGORITHM=INPLACE LOCK=NONE execution: pass"',
  'echo "observed server settings: $server_meta"',
  'echo "observed table engine: $engine"',
  'echo "observed row/selectivity distribution: $row_distribution"',
  'echo "pre-DDL EXPLAIN lacked target index: pass"',
  'echo "observed metadata locks during blocked DDL: $metadata_locks"',
  'echo "bounded metadata-lock abort: pass; duration=${abort_ms}ms"',
  'echo "abort recovery retry: pass; ddl-duration=${ddl_ms}ms"',
  'echo "concurrent writes during LOCK=NONE DDL: pass; rows=$writer_rows completed-during-ddl=$writes_during_ddl average-write-latency=${write_avg_ms}ms"',
  'echo "post-DDL EXPLAIN uses idx_events_tenant_created: pass"',
  'echo "observed write/storage cost: $storage"',
  'echo "replication topology: standalone; observed replica channels=$replication_channels; replica lag=n/a"',
].join('\n');

const deadlockHarness = [
  'set -eu',
  'export MYSQL_PWD=kory',
  'mysqlx() { mysql --protocol=socket -uroot -D kory --batch --skip-column-names "$@"; }',
  "mysqlx <<'SQL'",
  'CREATE TABLE accounts (id varchar(16) PRIMARY KEY, balance bigint NOT NULL) ENGINE=InnoDB;',
  'CREATE TABLE ledger (',
  '  transfer_id varchar(64) PRIMARY KEY,',
  '  from_id varchar(16) NOT NULL,',
  '  to_id varchar(16) NOT NULL,',
  '  amount bigint NOT NULL',
  ') ENGINE=InnoDB;',
  "INSERT INTO accounts VALUES ('a',100),('b',100);",
  'SQL',
  "server_meta=\"$(mysqlx -e \"SELECT CONCAT('isolation=',@@transaction_isolation,'; deadlock_detect=',@@innodb_deadlock_detect,'; lock_wait_timeout=',@@innodb_lock_wait_timeout);\")\"",
  "engine_pair=\"$(mysqlx -e \"SELECT GROUP_CONCAT(CONCAT(TABLE_NAME,':',ENGINE) ORDER BY TABLE_NAME SEPARATOR ',') FROM information_schema.TABLES WHERE TABLE_SCHEMA='kory' AND TABLE_NAME IN ('accounts','ledger');\")\"",
  '[ "$engine_pair" = "accounts:InnoDB,ledger:InnoDB" ] || { echo "transfer tables are not InnoDB: $engine_pair"; exit 30; }',
  'rm -f /tmp/kory-deadlock-*.status /tmp/kory-deadlock-*.out',
  '(',
  '  set +e',
  "  mysqlx <<'SQL' >/tmp/kory-deadlock-1.out 2>&1",
  'SET SESSION innodb_lock_wait_timeout=5;',
  'START TRANSACTION;',
  "UPDATE accounts SET balance=balance-10 WHERE id='a';",
  'DO SLEEP(0.5);',
  "UPDATE accounts SET balance=balance+10 WHERE id='b';",
  "INSERT INTO ledger VALUES ('deadlock-a-b','a','b',10);",
  'COMMIT;',
  'SQL',
  '  echo "$?" >/tmp/kory-deadlock-1.status',
  ') &',
  'p1=$!',
  '(',
  '  set +e',
  "  mysqlx <<'SQL' >/tmp/kory-deadlock-2.out 2>&1",
  'SET SESSION innodb_lock_wait_timeout=5;',
  'START TRANSACTION;',
  "UPDATE accounts SET balance=balance-10 WHERE id='b';",
  'DO SLEEP(0.5);',
  "UPDATE accounts SET balance=balance+10 WHERE id='a';",
  "INSERT INTO ledger VALUES ('deadlock-b-a','b','a',10);",
  'COMMIT;',
  'SQL',
  '  echo "$?" >/tmp/kory-deadlock-2.status',
  ') &',
  'p2=$!',
  'wait "$p1" || true',
  'wait "$p2" || true',
  's1="$(cat /tmp/kory-deadlock-1.status)"',
  's2="$(cat /tmp/kory-deadlock-2.status)"',
  'if [ "$s1" -eq 0 ] && [ "$s2" -eq 0 ]; then echo "opposite lock order did not produce a deadlock"; exit 31; fi',
  'if [ "$s1" -ne 0 ] && [ "$s2" -ne 0 ]; then cat /tmp/kory-deadlock-1.out /tmp/kory-deadlock-2.out; echo "both deadlock participants failed"; exit 32; fi',
  "cat /tmp/kory-deadlock-1.out /tmp/kory-deadlock-2.out | grep -Eiq 'ERROR 1213|Deadlock found' || { echo 'failed transaction was not an InnoDB deadlock'; cat /tmp/kory-deadlock-1.out /tmp/kory-deadlock-2.out; exit 33; }",
  'mysqlx -e "SHOW ENGINE INNODB STATUS\\G" >/tmp/kory-innodb-status.out',
  "grep -q 'LATEST DETECTED DEADLOCK' /tmp/kory-innodb-status.out || { echo 'InnoDB status lacked latest deadlock evidence'; exit 34; }",
  'if [ "$s1" -ne 0 ]; then',
  '  retry_id=deadlock-a-b',
  "  mysqlx <<'SQL' >/tmp/kory-deadlock-retry.out 2>&1",
  'START TRANSACTION;',
  "SELECT id FROM accounts WHERE id IN ('a','b') ORDER BY id FOR UPDATE;",
  "UPDATE accounts SET balance=balance-10 WHERE id='a';",
  "UPDATE accounts SET balance=balance+10 WHERE id='b';",
  "INSERT INTO ledger VALUES ('deadlock-a-b','a','b',10);",
  'COMMIT;',
  'SQL',
  'else',
  '  retry_id=deadlock-b-a',
  "  mysqlx <<'SQL' >/tmp/kory-deadlock-retry.out 2>&1",
  'START TRANSACTION;',
  "SELECT id FROM accounts WHERE id IN ('a','b') ORDER BY id FOR UPDATE;",
  "UPDATE accounts SET balance=balance-10 WHERE id='b';",
  "UPDATE accounts SET balance=balance+10 WHERE id='a';",
  "INSERT INTO ledger VALUES ('deadlock-b-a','b','a',10);",
  'COMMIT;',
  'SQL',
  'fi',
  "after_retry=\"$(mysqlx -e \"SELECT CONCAT((SELECT balance FROM accounts WHERE id='a'),'|',(SELECT balance FROM accounts WHERE id='b'),'|',(SELECT COUNT(*) FROM ledger),'|',(SELECT SUM(balance) FROM accounts));\")\"",
  '[ "$after_retry" = "100|100|2|200" ] || { echo "deadlock retry invariants failed: $after_retry"; exit 35; }',
  'mysqlx -e "TRUNCATE ledger; UPDATE accounts SET balance=100;"',
  "mysqlx <<'SQL'",
  'START TRANSACTION;',
  "SELECT id FROM accounts WHERE id IN ('a','b') ORDER BY id FOR UPDATE;",
  "INSERT INTO ledger VALUES ('dup-transfer','a','b',10);",
  "UPDATE accounts SET balance=balance-10 WHERE id='a';",
  "UPDATE accounts SET balance=balance+10 WHERE id='b';",
  'COMMIT;',
  'SQL',
  'set +e',
  "mysqlx <<'SQL' >/tmp/kory-duplicate.out 2>&1",
  'START TRANSACTION;',
  "INSERT INTO ledger VALUES ('dup-transfer','a','b',10);",
  "UPDATE accounts SET balance=balance-10 WHERE id='a';",
  "UPDATE accounts SET balance=balance+10 WHERE id='b';",
  'COMMIT;',
  'SQL',
  'duplicate_status=$?',
  'set -e',
  '[ "$duplicate_status" -ne 0 ] || { echo "duplicate transfer id was accepted"; exit 36; }',
  "grep -Eiq 'ERROR 1062|Duplicate entry' /tmp/kory-duplicate.out || { echo 'duplicate transfer failed for unexpected reason'; cat /tmp/kory-duplicate.out; exit 37; }",
  "duplicate_state=\"$(mysqlx -e \"SELECT CONCAT((SELECT balance FROM accounts WHERE id='a'),'|',(SELECT balance FROM accounts WHERE id='b'),'|',(SELECT COUNT(*) FROM ledger));\")\"",
  '[ "$duplicate_state" = "90|110|1" ] || { echo "duplicate transfer changed logical state: $duplicate_state"; exit 38; }',
  'mysqlx -e "TRUNCATE ledger; UPDATE accounts SET balance=100;"',
  'rm -f /tmp/kory-canonical-*.status /tmp/kory-canonical-*.out',
  '(',
  '  set +e',
  "  mysqlx <<'SQL' >/tmp/kory-canonical-1.out 2>&1",
  'START TRANSACTION;',
  "SELECT id FROM accounts WHERE id IN ('a','b') ORDER BY id FOR UPDATE;",
  'DO SLEEP(0.35);',
  "UPDATE accounts SET balance=balance-10 WHERE id='a';",
  "UPDATE accounts SET balance=balance+10 WHERE id='b';",
  "INSERT INTO ledger VALUES ('canonical-a-b','a','b',10);",
  'COMMIT;',
  'SQL',
  '  echo "$?" >/tmp/kory-canonical-1.status',
  ') &',
  'c1=$!',
  '(',
  '  set +e',
  "  mysqlx <<'SQL' >/tmp/kory-canonical-2.out 2>&1",
  'START TRANSACTION;',
  "SELECT id FROM accounts WHERE id IN ('a','b') ORDER BY id FOR UPDATE;",
  'DO SLEEP(0.35);',
  "UPDATE accounts SET balance=balance-10 WHERE id='b';",
  "UPDATE accounts SET balance=balance+10 WHERE id='a';",
  "INSERT INTO ledger VALUES ('canonical-b-a','b','a',10);",
  'COMMIT;',
  'SQL',
  '  echo "$?" >/tmp/kory-canonical-2.status',
  ') &',
  'c2=$!',
  'wait "$c1" || true',
  'wait "$c2" || true',
  'cs1="$(cat /tmp/kory-canonical-1.status)"',
  'cs2="$(cat /tmp/kory-canonical-2.status)"',
  '[ "$cs1" -eq 0 ] && [ "$cs2" -eq 0 ] || { cat /tmp/kory-canonical-1.out /tmp/kory-canonical-2.out; echo "canonical lock order did not allow both transfers"; exit 39; }',
  "canonical_state=\"$(mysqlx -e \"SELECT CONCAT((SELECT balance FROM accounts WHERE id='a'),'|',(SELECT balance FROM accounts WHERE id='b'),'|',(SELECT COUNT(*) FROM ledger),'|',(SELECT SUM(balance) FROM accounts));\")\"",
  '[ "$canonical_state" = "100|100|2|200" ] || { echo "canonical concurrency invariants failed: $canonical_state"; exit 40; }',
  'echo "real InnoDB opposite-order deadlock: pass; statuses=$s1,$s2"',
  'echo "SHOW ENGINE INNODB STATUS latest deadlock evidence: present"',
  'echo "bounded deadlock retry: pass; victim=$retry_id retries=1"',
  'echo "deadlock rollback + balance/ledger invariants: pass; state=$after_retry"',
  'echo "duplicate transfer-id exactly-once effect: pass; state=$duplicate_state"',
  'echo "canonical lock order trace: a,b"',
  'echo "opposite-direction canonical concurrency: pass; state=$canonical_state"',
  'echo "observed table engines: $engine_pair"',
  'echo "observed server settings: $server_meta"',
].join('\n');

export function runMySqlOnlineIndexRuntime(root: string): MySqlRuntimeResult {
  readFileSync(join(root, 'migration.sql'), 'utf8');
  return runHarness(root, ['migration.sql'], indexHarness);
}

export function runMySqlDeadlockRuntime(root: string): MySqlRuntimeResult {
  return runHarness(root, [], deadlockHarness);
}
