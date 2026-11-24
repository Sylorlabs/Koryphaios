import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

export const MONGODB_RUNTIME_IMAGE = 'mongo:8.0.12';

export const MONGODB_RUNTIME_BLOCKER =
  'Full-task qualification requires an available local Docker runtime with the pinned mongo:8.0.12 image so atomic versioned document updates and representative compound-index explain checks execute on MongoDB 8.0.12.';

export interface MongoRuntimeResult {
  passed: boolean;
  evidence: string;
}

interface MongoIndexSpec {
  keys: Array<[string, 1 | -1]>;
  partialUnresolved?: boolean;
}

let mongodbReadinessCache: readonly string[] | null = null;

function command(args: string[], options?: { input?: string; timeout?: number }) {
  return spawnSync('docker', args, {
    input: options?.input,
    encoding: 'utf8',
    timeout: options?.timeout ?? 5_000,
    maxBuffer: 8_000_000,
  });
}

export function mongodbRuntimeReadiness(): readonly string[] {
  if (mongodbReadinessCache) return mongodbReadinessCache;
  const image = command(['image', 'inspect', MONGODB_RUNTIME_IMAGE], { timeout: 15_000 });
  mongodbReadinessCache = image.status === 0 ? [] : [MONGODB_RUNTIME_BLOCKER];
  return mongodbReadinessCache;
}

function mongoEval(container: string, source: string, timeout = 5_000) {
  return command(['exec', container, 'mongosh', '--quiet', '--norc', '--eval', source], {
    timeout,
  });
}

function runHarness(shellSource: string, timeout = 90_000): MongoRuntimeResult {
  const blockers = mongodbRuntimeReadiness();
  if (blockers.length > 0) return { passed: false, evidence: blockers.join('\n') };

  const container = 'kory-mongo-' + randomUUID().replaceAll('-', '').slice(0, 12);
  let started = false;
  try {
    const start = command(
      [
        'run',
        '--pull=never',
        '--rm',
        '-d',
        '--name',
        container,
        '--tmpfs',
        '/data/db:rw',
        MONGODB_RUNTIME_IMAGE,
        'mongod',
        '--bind_ip_all',
        '--replSet',
        'rs0',
      ],
      { timeout: 15_000 },
    );
    if (start.status !== 0) {
      return {
        passed: false,
        evidence: (
          `${MONGODB_RUNTIME_IMAGE} start failed: ` + (start.stderr || start.stdout)
        ).trim(),
      };
    }
    started = true;

    let acceptsConnections = false;
    for (let attempt = 0; attempt < 180; attempt += 1) {
      const logs = command(['logs', container], { timeout: 2_000 });
      if (/Waiting for connections/u.test((logs.stdout ?? '') + (logs.stderr ?? ''))) {
        acceptsConnections = true;
        break;
      }
      spawnSync('sleep', ['0.1'], { timeout: 500 });
    }
    if (!acceptsConnections) {
      return { passed: false, evidence: `${MONGODB_RUNTIME_IMAGE} did not accept connections` };
    }

    const harness = mongoEval(
      container,
      `try {
const initiation = rs.initiate({_id:'rs0',members:[{_id:0,host:'127.0.0.1:27017'}]});
if (initiation.ok !== 1) throw new Error('replica-set initiation failed: ' + JSON.stringify(initiation));
let primary = false;
for (let attempt = 0; attempt < 180; attempt += 1) {
  if (db.hello().isWritablePrimary) { primary = true; break; }
  sleep(100);
}
if (!primary) throw new Error('MongoDB replica set did not elect a writable primary');
const runtimeVersion = db.version();
if (runtimeVersion !== '8.0.12') throw new Error('unexpected MongoDB runtime: ' + runtimeVersion);
print('MongoDB runtime: ' + runtimeVersion);
print('topology: single-node replica set rs0; readConcern=majority; writeConcern=majority');
${shellSource}
} catch (error) {
  console.error(error?.stack ?? error);
  quit(97);
}
quit(0);
`,
      timeout,
    );
    return {
      passed: harness.status === 0,
      evidence: [harness.stdout, harness.stderr, harness.error?.message]
        .filter(Boolean)
        .join('\n')
        .trim()
        .slice(-10_000),
    };
  } finally {
    if (started) command(['rm', '-f', container], { timeout: 5_000 });
  }
}

const atomicUpdateHarness = String.raw`
const evalDb = db.getSiblingDB('kory_eval_atomic');
evalDb.dropDatabase({ writeConcern: { w: 'majority', wtimeout: 5000 } });
const docs = evalDb.getCollection('docs');

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function updateOne(filter, update) {
  const runtimeDb = db.getSiblingDB('kory_eval_atomic');
  const result = runtimeDb.runCommand({
    update: 'docs',
    updates: [{ q: filter, u: update, multi: false, upsert: false }],
    writeConcern: { w: 'majority', wtimeout: 5000 },
  });
  check(result.ok === 1, 'update command failed: ' + JSON.stringify(result));
  return result.n;
}

function majorityRead() {
  const runtimeDb = db.getSiblingDB('kory_eval_atomic');
  const result = runtimeDb.runCommand({
    find: 'docs',
    filter: { _id: 'd' },
    limit: 1,
    readConcern: { level: 'majority' },
  });
  check(result.ok === 1, 'majority read failed: ' + JSON.stringify(result));
  return result.cursor.firstBatch[0];
}

const inserted = docs.insertOne(
  { _id: 'd', version: 1, items: [] },
  { writeConcern: { w: 'majority', wtimeout: 5000 } },
);
check(inserted.acknowledged === true, 'seed insert was not acknowledged');

const firstAdd = updateOne(
  { _id: 'd', version: 1, 'items.id': { $ne: 'a' } },
  { $push: { items: { id: 'a', value: 'A' } }, $inc: { version: 1 } },
);
const staleAdd = updateOne(
  { _id: 'd', version: 1, 'items.id': { $ne: 'b' } },
  { $push: { items: { id: 'b', value: 'B' } }, $inc: { version: 1 } },
);
const retryAdd = updateOne(
  { _id: 'd', version: 2, 'items.id': { $ne: 'b' } },
  { $push: { items: { id: 'b', value: 'B' } }, $inc: { version: 1 } },
);
check(firstAdd === 1 && staleAdd === 0 && retryAdd === 1, 'unexpected add CAS counts: ' + firstAdd + '/' + staleAdd + '/' + retryAdd);

const beforeDuplicate = majorityRead();
const duplicateAdd = updateOne(
  { _id: 'd', version: beforeDuplicate.version, 'items.id': { $ne: 'a' } },
  { $push: { items: { id: 'a', value: 'again' } }, $inc: { version: 1 } },
);
const afterDuplicate = majorityRead();
check(duplicateAdd === 0, 'duplicate stable item id unexpectedly matched');
check(afterDuplicate.version === beforeDuplicate.version, 'duplicate attempt advanced the version');
check(afterDuplicate.items.filter((item) => item.id === 'a').length === 1, 'duplicate item was written');

const staleRemove = updateOne(
  { _id: 'd', version: 1, 'items.id': 'a' },
  { $pull: { items: { id: 'a' } }, $inc: { version: 1 } },
);
const currentRemove = updateOne(
  { _id: 'd', version: afterDuplicate.version, 'items.id': 'a' },
  { $pull: { items: { id: 'a' } }, $inc: { version: 1 } },
);
const finalDoc = majorityRead();
check(staleRemove === 0 && currentRemove === 1, 'unexpected remove CAS counts: ' + staleRemove + '/' + currentRemove);
check(finalDoc.version === 4, 'unexpected final version: ' + finalDoc.version);
check(finalDoc.items.length === 1 && finalDoc.items[0].id === 'b', 'atomic add/remove lost or duplicated an item');

print('atomic version compare-and-swap: pass; first-add=' + firstAdd + '; stale-add=' + staleAdd + '; retry-add=' + retryAdd);
print('duplicate stable item id rejection: pass; matched=' + duplicateAdd + '; version-before=' + beforeDuplicate.version + '; version-after=' + afterDuplicate.version);
print('stale remove precondition: pass; stale-remove=' + staleRemove + '; current-remove=' + currentRemove);
print('majority read/write concern: pass; final-version=' + finalDoc.version + '; final-items=' + finalDoc.items.map((item) => item.id).join(','));
`;

function readIndexSpec(root: string): MongoIndexSpec | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(root, '.kory-eval', 'mongo-index.json'), 'utf8'));
  } catch (error) {
    return { error: `failed to read .kory-eval/mongo-index.json: ${String(error)}` };
  }

  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as MongoIndexSpec).keys)) {
    return { error: 'mongo-index.json must contain a keys array' };
  }
  const candidate = parsed as MongoIndexSpec;
  if (
    candidate.keys.length === 0 ||
    candidate.keys.some(
      (entry) =>
        !Array.isArray(entry) ||
        entry.length !== 2 ||
        typeof entry[0] !== 'string' ||
        entry[0].length === 0 ||
        (entry[1] !== 1 && entry[1] !== -1),
    ) ||
    (candidate.partialUnresolved !== undefined && typeof candidate.partialUnresolved !== 'boolean')
  ) {
    return { error: 'mongo-index.json contains an invalid MongoDB index specification' };
  }
  if (new Set(candidate.keys.map(([field]) => field)).size !== candidate.keys.length) {
    return { error: 'mongo-index.json contains duplicate index fields' };
  }
  return candidate;
}

function indexHarness(spec: MongoIndexSpec): string {
  const serializedSpec = JSON.stringify(spec);
  return String.raw`
const evalDb = db.getSiblingDB('kory_eval_index');
evalDb.dropDatabase({ writeConcern: { w: 'majority', wtimeout: 5000 } });
const alerts = evalDb.getCollection('alerts');
const spec = ${serializedSpec};
const totalDocs = 1000000;
const unresolvedDocs = 2000;
const batchSize = 10000;
const baseTime = Date.UTC(2026, 0, 1);

function check(condition, message) {
  if (!condition) throw new Error(message);
}

check(spec.keys[0]?.[0] === 'tenantId', 'candidate index must lead with tenantId');
check(spec.keys.some(([field]) => field === 'resolved'), 'candidate index must include resolved');
const lastKey = spec.keys[spec.keys.length - 1];
check(lastKey?.[0] === 'createdAt' && lastKey?.[1] === -1, 'candidate index must end with createdAt descending');

for (let start = 0; start < totalDocs; start += batchSize) {
  const batch = [];
  const end = Math.min(start + batchSize, totalDocs);
  for (let i = start; i < end; i += 1) {
    batch.push({
      _id: i,
      tenantId: 'hot-tenant',
      resolved: i >= unresolvedDocs,
      createdAt: new Date(baseTime - i * 1000),
      severity: i % 5,
      message: 'alert-' + i,
    });
  }
  const inserted = alerts.insertMany(batch, {
    ordered: false,
    writeConcern: { w: 'majority', wtimeout: 15000 },
  });
  check(inserted.acknowledged === true, 'representative workload insert was not acknowledged');
}

const query = { tenantId: 'hot-tenant', resolved: false };
const sort = { createdAt: -1 };
const baseline = alerts.find(query).sort(sort).limit(100).hint({ $natural: 1 }).explain('executionStats');
check(baseline.executionStats.nReturned === 100, 'baseline query returned an unexpected row count');
check(baseline.executionStats.totalDocsExamined >= 900000, 'baseline did not exercise the representative 1M-document tenant');

const key = {};
for (const [field, direction] of spec.keys) key[field] = direction;
const indexName = 'candidate_recent_unresolved';
const indexDefinition = { key, name: indexName };
if (spec.partialUnresolved) indexDefinition.partialFilterExpression = { resolved: false };
const created = evalDb.runCommand({
  createIndexes: 'alerts',
  indexes: [indexDefinition],
  writeConcern: { w: 'majority', wtimeout: 30000 },
});
check(created.ok === 1, 'candidate index creation failed: ' + JSON.stringify(created));

const after = alerts.find(query).sort(sort).limit(100).hint(indexName).explain('executionStats');
function hasStage(value, stage) {
  if (!value || typeof value !== 'object') return false;
  if (value.stage === stage) return true;
  for (const child of Object.values(value)) {
    if (Array.isArray(child)) {
      if (child.some((entry) => hasStage(entry, stage))) return true;
    } else if (hasStage(child, stage)) return true;
  }
  return false;
}

const blockingSort = hasStage(after.queryPlanner?.winningPlan, 'SORT') || hasStage(after.executionStats?.executionStages, 'SORT');
check(after.executionStats.nReturned === 100, 'indexed query returned an unexpected row count');
check(after.executionStats.totalDocsExamined <= 5000, 'candidate index examined too many documents: ' + after.executionStats.totalDocsExamined);
check(after.executionStats.totalKeysExamined <= 5000, 'candidate index examined too many keys: ' + after.executionStats.totalKeysExamined);
check(!blockingSort, 'candidate index left a blocking SORT stage in the representative query');

const stats = alerts.stats();
const indexBytes = stats.indexSizes?.[indexName] ?? -1;
check(indexBytes > 0, 'candidate index size was not observable');
print('representative tenant workload: documents=' + totalDocs + '; unresolved=' + unresolvedDocs + '; returned=' + after.executionStats.nReturned);
print('baseline explain: docsExamined=' + baseline.executionStats.totalDocsExamined + '; keysExamined=' + baseline.executionStats.totalKeysExamined + '; returned=' + baseline.executionStats.nReturned);
print('candidate index explain: docsExamined=' + after.executionStats.totalDocsExamined + '; keysExamined=' + after.executionStats.totalKeysExamined + '; returned=' + after.executionStats.nReturned + '; blockingSort=' + blockingSort);
print('candidate index shape: ' + JSON.stringify(spec.keys) + '; partialUnresolved=' + Boolean(spec.partialUnresolved) + '; indexBytes=' + indexBytes);
print('representative index/explain behavior: pass');
`;
}

export function runMongoAtomicUpdateRuntime(): MongoRuntimeResult {
  return runHarness(atomicUpdateHarness, 60_000);
}

export function runMongoIndexRuntime(root: string): MongoRuntimeResult {
  const spec = readIndexSpec(root);
  if ('error' in spec) return { passed: false, evidence: spec.error };
  return runHarness(indexHarness(spec), 210_000);
}
