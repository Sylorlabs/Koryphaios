import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

export const POSTGRES_RUNTIME_BLOCKER =
  'Full-task qualification requires an available local Docker runtime with the pinned postgres:17.5 image so ownership, extension, workload, isolation, lock/transaction duration, constraint, concurrency, timeout, statistics, and representative plan checks execute on PostgreSQL 17.5.';

export interface PostgresRuntimeResult {
  passed: boolean;
  evidence: string;
}

let postgresReadinessCache: readonly string[] | null = null;

function command(args: string[], options?: { input?: string; timeout?: number }) {
  return spawnSync('docker', args, {
    input: options?.input,
    encoding: 'utf8',
    timeout: options?.timeout ?? 5_000,
    maxBuffer: 2_000_000,
  });
}

export function postgresRuntimeReadiness(): readonly string[] {
  if (postgresReadinessCache) return postgresReadinessCache;
  const image = command(['image', 'inspect', 'postgres:17.5'], { timeout: 15_000 });
  postgresReadinessCache = image.status === 0 ? [] : [POSTGRES_RUNTIME_BLOCKER];
  return postgresReadinessCache;
}

function runHarness(root: string, files: string[], shellSource: string): PostgresRuntimeResult {
  const blockers = postgresRuntimeReadiness();
  if (blockers.length > 0) return { passed: false, evidence: blockers.join('\n') };

  const container = 'kory-pg-' + randomUUID().replaceAll('-', '').slice(0, 12);
  let started = false;
  try {
    const start = command(
      [
        'run',
        '--rm',
        '-d',
        '--name',
        container,
        '--tmpfs',
        '/var/lib/postgresql/data:rw',
        '-e',
        'POSTGRES_PASSWORD=kory',
        '-e',
        'POSTGRES_INITDB_ARGS=--no-sync',
        'postgres:17.5',
      ],
      { timeout: 15_000 },
    );
    if (start.status !== 0) {
      return {
        passed: false,
        evidence: ('postgres:17.5 start failed: ' + (start.stderr || start.stdout)).trim(),
      };
    }
    started = true;

    let ready = false;
    for (let attempt = 0; attempt < 180; attempt += 1) {
      const logs = command(['logs', container], { timeout: 2_000 });
      const initialized = /PostgreSQL init process complete; ready for start up\./u.test(
        (logs.stdout ?? '') + (logs.stderr ?? ''),
      );
      if (initialized) {
        const probe = command(
          ['exec', container, 'pg_isready', '-U', 'postgres', '-d', 'postgres'],
          { timeout: 2_000 },
        );
        if (probe.status === 0) {
          ready = true;
          break;
        }
      }
      spawnSync('sleep', ['0.1'], { timeout: 500 });
    }
    if (!ready) return { passed: false, evidence: 'postgres:17.5 did not become ready' };

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
        container,
        'psql',
        '-X',
        '-At',
        '-U',
        'postgres',
        '-d',
        'postgres',
        '-c',
        'show server_version;',
      ],
      { timeout: 5_000 },
    );
    if (version.status !== 0 || !/^17\.5(?:\s|\(|\.|$)/u.test(version.stdout.trim())) {
      return {
        passed: false,
        evidence: ('unexpected PostgreSQL runtime: ' + (version.stdout || version.stderr)).trim(),
      };
    }

    const harness = command(['exec', '-i', container, 'sh', '-s'], {
      input: shellSource,
      timeout: 60_000,
    });
    return {
      passed: harness.status === 0,
      evidence: [
        'PostgreSQL runtime: ' + version.stdout.trim(),
        harness.stdout,
        harness.stderr,
        harness.error?.message,
      ]
        .filter(Boolean)
        .join('\n')
        .trim()
        .slice(-8_000),
    };
  } finally {
    if (started) command(['rm', '-f', container], { timeout: 5_000 });
  }
}

const queueHarness = [
  'set -eu',
  'psqlx() { psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres "$@"; }',
  "psqlx <<'SQL'",
  'CREATE TABLE jobs (',
  '  id bigint PRIMARY KEY,',
  "  status text NOT NULL DEFAULT 'queued',",
  '  priority integer NOT NULL,',
  '  available_at timestamptz NOT NULL DEFAULT now(),',
  '  claimed_at timestamptz,',
  '  lease_expires_at timestamptz,',
  '  attempt_count integer NOT NULL DEFAULT 0,',
  '  claimed_by uuid,',
  '  claim_token uuid',
  ');',
  'CREATE TABLE claim_audit(job_id bigint NOT NULL, backend_pid integer NOT NULL, claimed_at timestamptz NOT NULL DEFAULT clock_timestamp());',
  'CREATE OR REPLACE FUNCTION kory_slow_claim() RETURNS trigger LANGUAGE plpgsql AS $$',
  'BEGIN',
  "  IF OLD.status = 'queued' AND NEW.status = 'running' THEN",
  '    PERFORM pg_sleep(0.06);',
  '    INSERT INTO claim_audit(job_id, backend_pid) VALUES (NEW.id, pg_backend_pid());',
  '  END IF;',
  '  RETURN NEW;',
  'END $$;',
  'CREATE TRIGGER kory_slow_claim BEFORE UPDATE ON jobs FOR EACH ROW EXECUTE FUNCTION kory_slow_claim();',
  "INSERT INTO jobs(id,status,priority,available_at) SELECT g, 'queued', 1000-g, now()-interval '1 minute' FROM generate_series(1,20) g;",
  'SQL',
  "ownership=\"$(psql -X -At -U postgres -d postgres -c \"select n.nspname||'|'||pg_get_userbyid(n.nspowner)||'|'||pg_get_userbyid(c.relowner) from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.oid='jobs'::regclass;\")\"",
  '[ -n "$ownership" ] || { echo "schema/table ownership observation missing"; exit 10; }',
  'isolation="$(psql -X -At -U postgres -d postgres -c "show transaction_isolation;")"',
  '[ "$isolation" = "read committed" ] || { echo "unexpected transaction isolation: $isolation"; exit 11; }',
  'extensions="$(psql -X -At -U postgres -d postgres -c "select coalesce(string_agg(extname,\',\' order by extname),\'none\') from pg_extension;")"',
  'uuid_function="$(psql -X -At -U postgres -d postgres -c "select coalesce(to_regprocedure(\'gen_random_uuid()\')::text,\'missing\');")"',
  '[ "$uuid_function" != "missing" ] || { echo "PostgreSQL 17.5 gen_random_uuid() unavailable"; exit 12; }',
  'initial_workload="$(psql -X -At -U postgres -d postgres -c "select count(*)||\' rows; queued=\'||count(*) filter (where status=\'queued\') from jobs;")"',
  'set +e',
  'psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres -c "insert into jobs(id,status,priority) values (1,\'queued\',1);" >/tmp/kory-duplicate-constraint.out 2>&1',
  'duplicate_status=$?',
  'psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres -c "insert into jobs(id,status,priority) values (100000,\'queued\',null);" >/tmp/kory-null-constraint.out 2>&1',
  'null_status=$?',
  'set -e',
  '[ "$duplicate_status" -ne 0 ] && [ "$null_status" -ne 0 ] || { echo "queue constraint-violation probe unexpectedly succeeded"; exit 13; }',
  'rm -f /tmp/kory-claim-status.* /tmp/kory-claim-out.*',
  'i=1',
  'while [ "$i" -le 20 ]; do',
  '  (',
  '    set +e',
  '    psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres -f /tmp/.kory-bound-claim-$i.sql >/tmp/kory-claim-out.$i 2>&1',
  '    echo "$?" >/tmp/kory-claim-status.$i',
  '  ) &',
  '  i=$((i+1))',
  'done',
  'wait',
  'for status_file in /tmp/kory-claim-status.*; do',
  '  [ "$(cat "$status_file")" = "0" ] || { cat /tmp/kory-claim-out.* || true; echo "one or more concurrent claim executions failed"; exit 20; }',
  'done',
  'stats="$(psql -X -At -U postgres -d postgres -c "select count(*),count(distinct job_id),(select count(*) from jobs where status=\'running\'),(select count(*) from jobs where status=\'queued\') from claim_audit;")"',
  '[ "$stats" = "20|20|20|0" ] || { echo "concurrent claim invariant failed: $stats"; cat /tmp/kory-claim-out.* || true; exit 21; }',
  'before="$(psql -X -At -U postgres -d postgres -c "select count(*) from claim_audit;")"',
  'psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres -f /tmp/.kory-bound-claim-1.sql >/tmp/kory-empty.out 2>&1',
  'after="$(psql -X -At -U postgres -d postgres -c "select count(*) from claim_audit;")"',
  '[ "$before" = "$after" ] || { echo "empty queue produced another claim"; exit 22; }',
  "psqlx -c \"update jobs set status='queued', available_at=now()-interval '1 minute', claimed_at=null, lease_expires_at=null, claimed_by=null, claim_token=null where id in (1,2);\"",
  'rm -f /tmp/kory-lock-holder-ready',
  "( psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres >/tmp/kory-lock-holder.out 2>&1 <<'SQL'",
  'BEGIN;',
  'SELECT id FROM jobs WHERE id=1 FOR UPDATE;',
  // This marker is written by the psql client only after PostgreSQL has
  // acquired the lock. A fixed sleep alone can falsely certify SKIP LOCKED.
  '\\! touch /tmp/kory-lock-holder-ready',
  'SELECT pg_sleep(3);',
  'COMMIT;',
  'SQL',
  ') &',
  'locker=$!',
  'attempt=0',
  'while [ ! -f /tmp/kory-lock-holder-ready ] && [ "$attempt" -lt 40 ]; do sleep 0.05; attempt=$((attempt+1)); done',
  '[ -f /tmp/kory-lock-holder-ready ] && kill -0 "$locker" 2>/dev/null || { cat /tmp/kory-lock-holder.out; echo "could not prove row lock was acquired"; exit 25; }',
  // Time the actual SQL statement in its own psql connection. Three distinct
  // docker exec calls previously included host/container scheduling delay in
  // the supposed PostgreSQL transaction duration, producing false failures.
  "psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres -c '\\timing on' -f /tmp/.kory-bound-claim-1.sql >/tmp/kory-lock-bypass.out 2>&1",
  'lock_bypass_ms="$(awk \'/^Time: [0-9]+([.][0-9]+)? ms/ { t=$2; n++ } END { if (n != 1) exit 1; printf "%.0f", t }\' /tmp/kory-lock-bypass.out)" || { cat /tmp/kory-lock-bypass.out; echo "SQL claim timing unavailable"; exit 25; }',
  '[ "$lock_bypass_ms" -lt 1000 ] || { echo "SKIP LOCKED claim waited too long: ${lock_bypass_ms}ms"; cat /tmp/kory-lock-bypass.out; exit 25; }',
  '[ "$(psql -X -At -U postgres -d postgres -c "select status from jobs where id=2;")" = "running" ] || { echo "locked highest-priority row was not bypassed to id=2"; exit 26; }',
  'wait "$locker"',
  "psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres -c '\\timing on' -f /tmp/.kory-bound-claim-2.sql >/tmp/kory-transaction-duration.out 2>&1",
  'transaction_ms="$(awk \'/^Time: [0-9]+([.][0-9]+)? ms/ { t=$2; n++ } END { if (n != 1) exit 1; printf "%.0f", t }\' /tmp/kory-transaction-duration.out)" || { cat /tmp/kory-transaction-duration.out; echo "SQL transaction timing unavailable"; exit 27; }',
  '[ "$transaction_ms" -lt 1000 ] || { echo "autocommit claim transaction too long: ${transaction_ms}ms"; cat /tmp/kory-transaction-duration.out; exit 27; }',
  "psqlx -c \"update jobs set status='running', claimed_at=now()-interval '20 minutes', lease_expires_at=now()-interval '10 minutes' where id=1;\"",
  'if [ -f /tmp/recovery.sql ]; then',
  '  psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres -f /tmp/recovery.sql >/tmp/kory-recovery.out 2>&1',
  'else',
  '  psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres -f /tmp/.kory-bound-claim-1.sql >/tmp/kory-recovery.out 2>&1',
  'fi',
  'recovered="$(psql -X -At -U postgres -d postgres -c "select case when status=\'queued\' or claimed_at >= now()-interval \'2 minutes\' or lease_expires_at > now() then 1 else 0 end from jobs where id=1;")"',
  '[ "$recovered" = "1" ] || { echo "stale/crashed claim was not made retry-visible"; cat /tmp/kory-recovery.out || true; exit 23; }',
  'if [ "$(psql -X -At -U postgres -d postgres -c "select status from jobs where id=1;")" = "queued" ]; then',
  '  psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres -f /tmp/.kory-bound-claim-1.sql >/tmp/kory-reclaim.out 2>&1',
  '  [ "$(psql -X -At -U postgres -d postgres -c "select status from jobs where id=1;")" = "running" ] || { echo "retry-visible job could not be reclaimed"; exit 24; }',
  'fi',
  'psqlx -c "truncate jobs, claim_audit;"',
  "psqlx <<'SQL'",
  'INSERT INTO jobs(id,status,priority,available_at,claimed_at,lease_expires_at,attempt_count)',
  'SELECT g,',
  "       CASE WHEN g % 10 = 0 THEN 'running' ELSE 'queued' END,",
  '       CASE WHEN g % 10 = 0 THEN -100-(g % 50) ELSE 100-(g % 100) END,',
  '       now() - make_interval(secs => (g % 120)),',
  "       CASE WHEN g % 10 = 0 THEN now()-interval '10 minutes' END,",
  "       CASE WHEN g % 20 = 0 THEN now()-interval '2 minutes' WHEN g % 10 = 0 THEN now()+interval '2 minutes' END,",
  '       g % 5',
  'FROM generate_series(1,25000) g;',
  'ANALYZE jobs;',
  'SQL',
  'stats_rows="$(psql -X -At -U postgres -d postgres -c "select reltuples::bigint from pg_class where oid=\'jobs\'::regclass;")"',
  'stats_columns="$(psql -X -At -U postgres -d postgres -c "select count(*) from pg_stats where schemaname=current_schema() and tablename=\'jobs\';")"',
  '[ "$stats_rows" -ge 24000 ] && [ "$stats_columns" -ge 8 ] || { echo "production-like ANALYZE statistics missing: rows=$stats_rows columns=$stats_columns"; exit 28; }',
  'expected_plan_id="$(psql -X -At -U postgres -d postgres -c "select id from jobs where (status=\'queued\' and available_at <= now()) or (status=\'running\' and lease_expires_at <= now()) order by priority desc,id limit 1;")"',
  'psql -X -At -v ON_ERROR_STOP=1 -U postgres -d postgres -f /tmp/.kory-bound-plan.sql >/tmp/kory-representative-plan.out 2>&1',
  'grep -Eiq \'actual time=.*rows=|actual rows\' /tmp/kory-representative-plan.out || { echo "representative EXPLAIN ANALYZE lacked actual-row evidence"; cat /tmp/kory-representative-plan.out; exit 29; }',
  'grep -Eiq \'Buffers:|Shared Hit Blocks\' /tmp/kory-representative-plan.out || { echo "representative EXPLAIN lacked buffer evidence"; cat /tmp/kory-representative-plan.out; exit 30; }',
  'actual_plan_id="$(psql -X -At -U postgres -d postgres -c "select id from jobs where claimed_by=\'00000000-0000-0000-0000-000000000999\'::uuid order by claimed_at desc nulls last limit 1;")"',
  '[ "$actual_plan_id" = "$expected_plan_id" ] || { echo "representative claim violated priority ordering: expected=$expected_plan_id actual=$actual_plan_id"; exit 31; }',
  'echo "20-worker claim uniqueness: pass"',
  'echo "empty queue: pass"',
  'echo "crash/retry visibility: pass"',
  'echo "queue constraint violations (primary key + NOT NULL): pass"',
  'echo "observed schema|schema-owner|table-owner: $ownership"',
  'echo "observed transaction isolation: $isolation"',
  'echo "observed installed extensions: $extensions; gen_random_uuid=$uuid_function"',
  'echo "observed workload: $initial_workload; contention-workers=20; representative-rows=$stats_rows"',
  'echo "measured SKIP LOCKED bypass duration: ${lock_bypass_ms}ms"',
  'echo "measured autocommit claim transaction duration: ${transaction_ms}ms"',
  'echo "production-like ANALYZE statistics: rows=$stats_rows stats-columns=$stats_columns"',
  'echo "representative EXPLAIN ANALYZE BUFFERS: pass; priority-id=$actual_plan_id"',
].join('\n');

const constraintHarness = [
  'set -eu',
  'psqlx() { psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres "$@"; }',
  "psqlx <<'SQL'",
  'CREATE TABLE parent(id bigint PRIMARY KEY);',
  'CREATE TABLE child(id bigint PRIMARY KEY, parent_id bigint);',
  'INSERT INTO parent SELECT g FROM generate_series(1,10000) g;',
  'INSERT INTO child SELECT g, ((g-1) % 10000)+1 FROM generate_series(1,50000) g;',
  'INSERT INTO child VALUES (90001,99001),(90002,99002);',
  'ANALYZE parent;',
  'ANALYZE child;',
  'SQL',
  "ownership=\"$(psql -X -At -U postgres -d postgres -c \"select n.nspname||'|'||pg_get_userbyid(n.nspowner)||'|'||string_agg(c.relname||':'||pg_get_userbyid(c.relowner),',' order by c.relname) from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.oid in ('parent'::regclass,'child'::regclass) group by n.nspname,n.nspowner;\")\"",
  '[ -n "$ownership" ] || { echo "schema/table ownership observation missing"; exit 40; }',
  'isolation="$(psql -X -At -U postgres -d postgres -c "show transaction_isolation;")"',
  '[ "$isolation" = "read committed" ] || { echo "unexpected transaction isolation: $isolation"; exit 41; }',
  'extensions="$(psql -X -At -U postgres -d postgres -c "select coalesce(string_agg(extname,\',\' order by extname),\'none\') from pg_extension;")"',
  "initial_workload=\"$(psql -X -At -U postgres -d postgres -c \"select (select count(*) from parent)||' parents; '||(select count(*) from child)||' children; '||(select count(*) from child c left join parent p on p.id=c.parent_id where p.id is null)||' orphans';\")\"",
  'stats_rows="$(psql -X -At -U postgres -d postgres -c "select reltuples::bigint from pg_class where oid=\'child\'::regclass;")"',
  'stats_columns="$(psql -X -At -U postgres -d postgres -c "select count(*) from pg_stats where schemaname=current_schema() and tablename=\'child\';")"',
  '[ "$stats_rows" -ge 49000 ] && [ "$stats_columns" -ge 2 ] || { echo "production-like child statistics missing: rows=$stats_rows columns=$stats_columns"; exit 42; }',
  'migration_start="$(psql -X -At -U postgres -d postgres -c "select extract(epoch from clock_timestamp());")"',
  'psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres -f /tmp/migration.sql >/tmp/kory-migration.out 2>&1',
  'migration_end="$(psql -X -At -U postgres -d postgres -c "select extract(epoch from clock_timestamp());")"',
  'migration_ms="$(awk -v s="$migration_start" -v e="$migration_end" \'BEGIN { printf "%.0f", (e-s)*1000 }\')"',
  'validated="$(psql -X -At -U postgres -d postgres -c "select count(*) from pg_constraint where conrelid=\'child\'::regclass and contype=\'f\' and convalidated;")"',
  '[ "$validated" -ge 1 ] || { echo "foreign key did not finish validated"; cat /tmp/kory-migration.out; exit 30; }',
  'orphans="$(psql -X -At -U postgres -d postgres -c "select count(*) from child c left join parent p on p.id=c.parent_id where p.id is null;")"',
  '[ "$orphans" = "0" ] || { echo "orphan rows remain: $orphans"; exit 31; }',
  'set +e',
  'psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres -c "insert into child values (60001,999999);" >/tmp/kory-invalid.out 2>&1',
  'invalid_status=$?',
  'set -e',
  '[ "$invalid_status" -ne 0 ] || { echo "invalid concurrent/new write was accepted"; exit 32; }',
  'psql -X -At -v ON_ERROR_STOP=1 -U postgres -d postgres -c "explain (analyze,buffers) select c.id from child c join parent p on p.id=c.parent_id where c.id between 10 and 2000;" >/tmp/kory-constraint-plan.out 2>&1',
  'grep -Eiq \'actual time=.*rows=|actual rows\' /tmp/kory-constraint-plan.out || { echo "constraint representative plan lacked actual-row evidence"; cat /tmp/kory-constraint-plan.out; exit 43; }',
  'grep -Eiq \'Buffers:|Shared Hit Blocks\' /tmp/kory-constraint-plan.out || { echo "constraint representative plan lacked buffer evidence"; cat /tmp/kory-constraint-plan.out; exit 44; }',
  'fkname="$(psql -X -At -U postgres -d postgres -c "select conname from pg_constraint where conrelid=\'child\'::regclass and contype=\'f\' limit 1;")"',
  'psqlx -c "alter table child drop constraint \\"$fkname\\";"',
  '( psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres -c "begin; lock table child in access exclusive mode; select pg_sleep(5); commit;" >/tmp/kory-lock-holder.out 2>&1 ) &',
  'locker=$!',
  'sleep 0.2',
  'timeout_start="$(psql -X -At -U postgres -d postgres -c "select extract(epoch from clock_timestamp());")"',
  'rm -f /tmp/kory-timeout.status',
  '(',
  '  set +e',
  "  PGAPPNAME='kory-pg-migration-timeout' PGOPTIONS='-c lock_timeout=800ms -c statement_timeout=2500ms' psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres -f /tmp/migration.sql >/tmp/kory-timeout.out 2>&1",
  '  echo "$?" >/tmp/kory-timeout.status',
  ') &',
  'migrator=$!',
  'sleep 0.25',
  "waiting_locks=\"$(psql -X -At -U postgres -d postgres -c \"select coalesce(string_agg(l.mode||':'||l.granted::text,',' order by l.granted,l.mode),'none') from pg_locks l join pg_stat_activity a on a.pid=l.pid where a.application_name='kory-pg-migration-timeout' and l.relation='child'::regclass;\")\"",
  'wait "$migrator" || true',
  'timeout_end="$(psql -X -At -U postgres -d postgres -c "select extract(epoch from clock_timestamp());")"',
  'timeout_status="$(cat /tmp/kory-timeout.status)"',
  'lock_timeout_ms="$(awk -v s="$timeout_start" -v e="$timeout_end" \'BEGIN { printf "%.0f", (e-s)*1000 }\')"',
  'wait "$locker"',
  '[ "$timeout_status" -ne 0 ] || { echo "migration ignored bounded timeout under contention"; exit 33; }',
  'grep -Eiq \'lock timeout|statement timeout|canceling statement|due to lock timeout\' /tmp/kory-timeout.out || { echo "contention failure was not a timeout"; cat /tmp/kory-timeout.out; exit 34; }',
  'echo "$waiting_locks" | grep -Eq \'(f|false)\' || { echo "waiting lock mode was not observed: $waiting_locks"; cat /tmp/kory-timeout.out; exit 45; }',
  '[ "$lock_timeout_ms" -lt 4000 ] || { echo "bounded lock timeout took too long: ${lock_timeout_ms}ms"; exit 46; }',
  'partial_fk="$(psql -X -At -U postgres -d postgres -c "select count(*) from pg_constraint where conrelid=\'child\'::regclass and contype=\'f\';")"',
  '[ "$partial_fk" = "0" ] || { echo "failed migration left a partial FK behind"; exit 47; }',
  'retry_start="$(psql -X -At -U postgres -d postgres -c "select extract(epoch from clock_timestamp());")"',
  'psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres -f /tmp/migration.sql >/tmp/kory-retry.out 2>&1',
  'retry_end="$(psql -X -At -U postgres -d postgres -c "select extract(epoch from clock_timestamp());")"',
  'retry_ms="$(awk -v s="$retry_start" -v e="$retry_end" \'BEGIN { printf "%.0f", (e-s)*1000 }\')"',
  'retry_validated="$(psql -X -At -U postgres -d postgres -c "select count(*) from pg_constraint where conrelid=\'child\'::regclass and contype=\'f\' and convalidated;")"',
  '[ "$retry_validated" -ge 1 ] || { echo "migration retry did not restore validated FK"; cat /tmp/kory-retry.out; exit 48; }',
  'set +e',
  'psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres -c "insert into child values (60002,999999);" >/tmp/kory-invalid-after-retry.out 2>&1',
  'retry_invalid_status=$?',
  'set -e',
  '[ "$retry_invalid_status" -ne 0 ] || { echo "invalid write was accepted after retry"; exit 49; }',
  'echo "orphan remediation: pass"',
  'echo "validated FK and invalid-write rejection: pass"',
  'echo "bounded lock-timeout abort: pass"',
  'echo "observed schema|schema-owner|table-owners: $ownership"',
  'echo "observed transaction isolation: $isolation"',
  'echo "observed installed extensions: $extensions"',
  'echo "observed workload: $initial_workload"',
  'echo "measured initial migration transaction/script duration: ${migration_ms}ms"',
  'echo "observed waiting lock modes: $waiting_locks; measured timeout duration: ${lock_timeout_ms}ms"',
  'echo "rollback/forward-recovery retry: pass; retry-duration=${retry_ms}ms"',
  'echo "production-like ANALYZE statistics: rows=$stats_rows stats-columns=$stats_columns"',
  'echo "representative EXPLAIN ANALYZE BUFFERS: pass"',
].join('\n');

export function runPostgresQueueRuntime(root: string): PostgresRuntimeResult {
  const source = readFileSync(join(root, 'claim.sql'), 'utf8');
  const files: string[] = [];
  try {
    for (let worker = 1; worker <= 20; worker += 1) {
      const workerId = '00000000-0000-0000-0000-' + String(worker).padStart(12, '0');
      const name = '.kory-bound-claim-' + worker + '.sql';
      const bound = source
        .replaceAll('$1', "'" + workerId + "'")
        .replaceAll('$2', "interval '5 minutes'");
      writeFileSync(join(root, name), bound);
      files.push(name);
    }
    const planName = '.kory-bound-plan.sql';
    const plan = source
      .replaceAll('$1', "'00000000-0000-0000-0000-000000000999'")
      .replaceAll('$2', "interval '5 minutes'");
    writeFileSync(join(root, planName), 'EXPLAIN (ANALYZE, BUFFERS)\n' + plan);
    files.push(planName);
    if (existsSync(join(root, 'recovery.sql'))) files.push('recovery.sql');
    return runHarness(root, files, queueHarness);
  } finally {
    for (const file of files) {
      if (file.startsWith('.kory-bound-')) rmSync(join(root, file), { force: true });
    }
  }
}

export function runPostgresConstraintRuntime(root: string): PostgresRuntimeResult {
  return runHarness(root, ['migration.sql'], constraintHarness);
}
